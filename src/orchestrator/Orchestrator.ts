// Orchestrator service: composes the consumer/tick/reload fibers and interprets
// reducer-emitted side effects against the live state, fiber registry, and queue.
import {
  Context,
  Duration,
  Effect,
  Fiber,
  Layer,
  Match,
  Queue,
  Ref,
  Stream,
  SubscriptionRef,
} from "effect";
import { WorkflowLoader } from "../config/WorkflowLoader.ts";
import { LinearClient } from "../linear/LinearClient.ts";
import { Logger } from "../observability/Logger.ts";
import { Sandbox } from "../sandbox/Nono.ts";
import { McpServer } from "../claude/McpServer.ts";
import { WorkspaceHooks } from "../workspace/Hooks.ts";
import { WorkspaceManager } from "../workspace/WorkspaceManager.ts";
import { selectDispatchBatch } from "./Dispatch.ts";
import {
  RetryTimerFired,
  WorkerExited,
  WorkerStarted,
  WorkflowReloaded,
  type OrchestratorEvent,
} from "./events.ts";
import { reconcileStalled, reconcileTrackerStates } from "./Reconcile.ts";
import {
  computeFailureBackoffMs,
  makeRetryRegistry,
  retryTimerEffect,
  type RetryRegistry,
} from "./Retry.ts";
import {
  initialState,
  newRunningEntry,
  reduce,
  type OrchestratorRuntimeState,
} from "./State.ts";
import { runWorker } from "./Worker.ts";
import { ScheduleRetry, type SideEffect } from "./sideEffects.ts";

/* -------------------------------------------------------------------------- */
/* Service interface + Tag.                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Public Orchestrator API. The HTTP server (§13.7) and any external
 * trigger use this interface; the internal fibers use the same `enqueue`
 * to feed reducer events back through the single-authority pipeline.
 */
export interface OrchestratorService {
  /** Snapshot of the current orchestrator state. */
  readonly state: Effect.Effect<OrchestratorRuntimeState>;
  /**
   * Stream of every state transition. Backed by a `SubscriptionRef` so
   * subscribers receive the current value on subscription and then every
   * subsequent update.
   */
  readonly stateChanges: Stream.Stream<OrchestratorRuntimeState>;
  /** Push an event into the orchestrator's event queue. */
  readonly enqueue: (event: OrchestratorEvent) => Effect.Effect<void>;
}

/** The Orchestrator service tag. */
export class Orchestrator extends Context.Tag(
  "symphony/orchestrator/Orchestrator",
)<Orchestrator, OrchestratorService>() {}

/* -------------------------------------------------------------------------- */
/* Internal constants.                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Capacity of the orchestrator's event queue. Bounded so a runaway event
 * source (worker producing UsageReport floods, runaway timer fires) can't
 * OOM. 1024 is comfortably above the steady-state of one tick per
 * `polling.interval_ms` and a handful of events per turn per worker.
 */
const EVENT_QUEUE_CAPACITY = 1024;

/**
 * Minimum sleep granularity for the tick fiber. The tick loop computes
 * the next sleep from `state.poll_interval_ms`; a `0`/negative value
 * would busy-loop, so we floor it.
 */
const MIN_TICK_INTERVAL_MS = 100;

/* -------------------------------------------------------------------------- */
/* Per-worker fiber registry.                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Tracks `Fiber.RuntimeFiber` per running issue id so `InterruptWorker`
 * side effects can cancel a worker mid-flight. Mirrors {@link RetryRegistry}
 * structurally; kept as a separate type to keep call sites readable.
 */
interface WorkerRegistry {
  readonly register: (
    issueId: string,
    fiber: Fiber.RuntimeFiber<unknown, never>,
  ) => Effect.Effect<void>;
  readonly remove: (issueId: string) => Effect.Effect<void>;
  readonly interrupt: (issueId: string) => Effect.Effect<void>;
  readonly interruptAll: Effect.Effect<void>;
}

const makeWorkerRegistry: Effect.Effect<WorkerRegistry> = Effect.gen(
  function* () {
    const ref = yield* Ref.make(
      new Map<string, Fiber.RuntimeFiber<unknown, never>>(),
    );
    const register = (
      issueId: string,
      fiber: Fiber.RuntimeFiber<unknown, never>,
    ): Effect.Effect<void> =>
      Ref.update(ref, (m) => {
        const next = new Map(m);
        next.set(issueId, fiber);
        return next;
      });
    const remove = (issueId: string): Effect.Effect<void> =>
      Ref.update(ref, (m) => {
        const next = new Map(m);
        next.delete(issueId);
        return next;
      });
    const interrupt = (issueId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const m = yield* Ref.get(ref);
        const fiber = m.get(issueId);
        if (fiber === undefined) return;
        yield* Ref.update(ref, (cur) => {
          const next = new Map(cur);
          next.delete(issueId);
          return next;
        });
        yield* Fiber.interrupt(fiber).pipe(Effect.forkDaemon);
      });
    const interruptAll: Effect.Effect<void> = Effect.gen(function* () {
      const m = yield* Ref.get(ref);
      yield* Ref.set(ref, new Map());
      for (const fiber of m.values()) {
        yield* Fiber.interrupt(fiber).pipe(Effect.forkDaemon);
      }
    });
    return { register, remove, interrupt, interruptAll };
  },
);

/* -------------------------------------------------------------------------- */
/* Shared deps bag.                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Closed-over dependencies threaded through interpretSideEffect, runTick,
 * forkOneWorker, and handleRetryFire. Modeled as one interface so the
 * call sites read like "Effect against the orchestrator's plumbing".
 */
interface Deps {
  readonly stateRef: SubscriptionRef.SubscriptionRef<OrchestratorRuntimeState>;
  readonly events: Queue.Queue<OrchestratorEvent>;
  readonly retryRegistry: RetryRegistry;
  readonly workerRegistry: WorkerRegistry;
  readonly loader: WorkflowLoader["Type"];
  readonly linear: LinearClient["Type"];
  readonly log: Logger["Type"];
  readonly mcpServer: McpServer["Type"];
  readonly workspaceManager: WorkspaceManager["Type"];
  readonly workspaceHooks: WorkspaceHooks["Type"];
  readonly sandbox: Sandbox["Type"];
}

/* -------------------------------------------------------------------------- */
/* Side-effect interpreter.                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Interpret one side effect emitted by the reducer. Pure switch on
 * `_tag` via `Match.tagsExhaustive`; every variant has an explicit branch
 * so adding a new SideEffect is a compile error here too.
 *
 * `DispatchWorker` is interpreted by the tick fiber directly (it has the
 * `WorkflowDefinition` snapshot needed to build a worker); the interpreter
 * silently logs and ignores it here as a safety net.
 */
const interpretSideEffect = (
  effect: SideEffect,
  deps: Deps,
): Effect.Effect<void> =>
  Match.value(effect).pipe(
    Match.tagsExhaustive({
      DispatchWorker: () =>
        deps.log.debug({
          msg: "DispatchWorker side-effect ignored at interpreter level",
        }),
      InterruptWorker: (e) =>
        Effect.gen(function* () {
          yield* deps.log.info({
            msg: "interrupting worker",
            issue_id: e.issue_id,
            reason: e.reason,
          });
          yield* deps.workerRegistry.interrupt(e.issue_id);
          // Synthesize a WorkerExited(abnormal) event so the reducer
          // bookkeeping (retry scheduling, claim release) runs. The
          // worker fiber itself was interrupted before it could emit one.
          yield* Queue.offer(
            deps.events,
            new WorkerExited({
              issue_id: e.issue_id,
              reason: "abnormal",
              error: `interrupted: ${e.reason}`,
              at: new Date(),
            }),
          );
        }),
      ScheduleRetry: (e) =>
        Effect.gen(function* () {
          const onFire = Queue.offer(
            deps.events,
            new RetryTimerFired({
              issue_id: e.issue_id,
              attempt: e.attempt,
            }),
          ).pipe(Effect.asVoid);
          const fiber = yield* Effect.forkDaemon(
            retryTimerEffect(e.delay_ms, onFire),
          );
          yield* deps.retryRegistry.replace(e.issue_id, fiber);
        }),
      CancelRetry: (e) => deps.retryRegistry.cancel(e.issue_id),
      CleanupWorkspace: (e) =>
        Effect.gen(function* () {
          // before_remove hook is best-effort — the workspace handle the
          // hook expects is constructed off the identifier alone; the hook
          // service only reads workspace.path / workspace_key, both of
          // which we can synthesize from the workspace root + identifier
          // at the time the cleanup runs. We just call cleanWorkspaceFor
          // directly — the before_remove hook is left as a future
          // refinement (CleanupWorkspace currently fires only on
          // tracker terminal states, where the worker scope is already
          // gone so re-constructing a Workspace is brittle).
          yield* Effect.catchAll(
            deps.workspaceManager.cleanWorkspaceFor(e.identifier),
            (err) =>
              deps.log.warn({
                msg: "workspace cleanup failed",
                identifier: e.identifier,
                error_tag: err._tag,
              }),
          );
        }),
      UpdateIssueSnapshot: (e) =>
        SubscriptionRef.update(deps.stateRef, (state) => {
          const entry = state.running.get(e.issue_id);
          if (entry === undefined) return state;
          const updated = new Map(state.running);
          updated.set(e.issue_id, {
            ...entry,
            issue: { ...entry.issue, state: e.issue.state },
          });
          return { ...state, running: updated };
        }),
      Log: (e) =>
        Match.value(e.level).pipe(
          Match.when("debug", () => deps.log.debug({ msg: e.message, ...e.fields })),
          Match.when("info", () => deps.log.info({ msg: e.message, ...e.fields })),
          Match.when("warn", () => deps.log.warn({ msg: e.message, ...e.fields })),
          Match.when("error", () => deps.log.error({ msg: e.message, ...e.fields })),
          Match.exhaustive,
        ),
      EmitMetric: (e) =>
        // v1 routes EmitMetric to the structured log as debug; the §13.7
        // dashboard reads the same ring buffer the logger fills.
        deps.log.debug({ msg: `metric:${e.kind}`, ...e.payload }),
    }),
  );

/* -------------------------------------------------------------------------- */
/* Tick fiber body.                                                           */
/* -------------------------------------------------------------------------- */

/**
 * One iteration of the §8.1 poll loop. Reconciles, validates, fetches
 * candidates, plans dispatch, and forks worker fibers.
 *
 * Returns void; every observable effect goes through the event queue or
 * the SubscriptionRef. Failures inside Linear/Reconcile/etc. are caught
 * and logged so a single tick failure does not kill the tick fiber.
 */
const runTick = (deps: Deps): Effect.Effect<void> =>
  Effect.gen(function* () {
    const now = new Date();
    const state = yield* SubscriptionRef.get(deps.stateRef);
    const workflow = yield* deps.loader.current;

    // §8.5 Part A: stall detection. The reducer's onStallDetected handler
    // re-emits the matching InterruptWorker side effect, so we ONLY feed
    // the events back through the queue here — interpreting the
    // reconcileStalled.sideEffects directly would double-fire
    // InterruptWorker (and the synthesized WorkerExited).
    const stallResult = reconcileStalled(state, workflow.config, now);
    for (const evt of stallResult.events) {
      yield* Queue.offer(deps.events, evt);
    }

    // §8.5 Part B: refresh tracker states for running issues.
    if (state.running.size > 0) {
      const runningIds = [...state.running.keys()];
      const refreshedResult = yield* Effect.either(
        deps.linear.fetchIssueStatesByIds(runningIds),
      );
      if (refreshedResult._tag === "Right") {
        const terminalLower = lowercaseSet(
          workflow.config.tracker.terminal_states,
        );
        const activeLower = lowercaseSet(
          workflow.config.tracker.active_states,
        );
        const reconcileResult = reconcileTrackerStates(
          state,
          refreshedResult.right,
          terminalLower,
          activeLower,
        );
        for (const eff of reconcileResult.sideEffects) {
          yield* interpretSideEffect(eff, deps);
        }
      } else {
        yield* deps.log.warn({
          msg: "state refresh failed during tick; skipping reconcile Part B",
          error_tag: refreshedResult.left._tag,
        });
      }
    }

    // §6.3 preflight. On failure log + skip dispatch (NOT reconcile).
    const preflight = yield* Effect.either(deps.loader.validateForDispatch);
    if (preflight._tag === "Left") {
      yield* deps.log.warn({
        msg: "dispatch preflight failed; skipping dispatch this tick",
        checks: preflight.left.checks,
      });
      return;
    }

    // §11.x: fetch candidate issues. Failure → log + skip dispatch.
    const candidatesResult = yield* Effect.either(
      deps.linear.fetchCandidateIssues,
    );
    if (candidatesResult._tag === "Left") {
      yield* deps.log.warn({
        msg: "candidate fetch failed; skipping dispatch this tick",
        error_tag: candidatesResult.left._tag,
      });
      return;
    }
    const candidates = candidatesResult.right;

    // Plan dispatch and fork worker fibers for each toDispatch entry.
    const currentState = yield* SubscriptionRef.get(deps.stateRef);
    const plan = selectDispatchBatch(candidates, currentState, workflow.config);
    for (const issue of plan.toDispatch) {
      yield* forkOneWorker(issue, workflow, deps);
    }
    // Log skipped reasons at debug for operator visibility.
    if (plan.reasons_skipped.size > 0) {
      yield* deps.log.debug({
        msg: "dispatch tick: some candidates skipped",
        count: plan.reasons_skipped.size,
      });
    }
  });

/**
 * Fork one worker fiber for an issue. Emits a `WorkerStarted` event so
 * the reducer installs the running entry, registers the fiber so
 * subsequent `InterruptWorker` side effects can find it, and arranges a
 * matching `WorkerExited` event when the worker completes.
 */
const forkOneWorker = (
  issue: import("../linear/schemas.ts").Issue,
  workflow: import("../config/WorkflowSchema.ts").WorkflowDefinition,
  deps: Deps,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const currentState = yield* SubscriptionRef.get(deps.stateRef);
    const retry = currentState.retry_attempts.get(issue.id);
    const retryAttempt = retry?.attempt ?? null;
    const startedAt = new Date();
    const runningEntry = newRunningEntry({
      issue,
      workspace_path: workflow.config.workspace.root,
      started_at: startedAt,
      attempt: null,
      retry_attempt: retryAttempt,
    });
    yield* Queue.offer(
      deps.events,
      new WorkerStarted({ issue, runningEntry }),
    );

    const workerEffect = Effect.scoped(
      runWorker({
        issue,
        workflow,
        retry_attempt: retryAttempt,
        events: deps.events,
        workspaceManager: deps.workspaceManager,
        workspaceHooks: deps.workspaceHooks,
        mcpServer: deps.mcpServer,
        linear: deps.linear,
      }),
    ).pipe(
      Effect.provideService(Sandbox, deps.sandbox),
      Effect.provideService(Logger, deps.log),
    );

    // We fork the worker as a daemon so it survives even if the caller
    // (the tick fiber) finishes its current iteration. Lifetime is
    // governed by the orchestrator scope's finalizers, which call
    // `workerRegistry.interruptAll` at shutdown.
    const fiber = yield* Effect.forkDaemon(
      workerEffect.pipe(
        Effect.tap((outcome) =>
          Effect.gen(function* () {
            yield* deps.workerRegistry.remove(issue.id);
            yield* Queue.offer(
              deps.events,
              new WorkerExited({
                issue_id: issue.id,
                reason: outcome.reason,
                error: outcome.error,
                at: outcome.at,
              }),
            );
          }),
        ),
        Effect.catchAllCause((cause) =>
          Effect.gen(function* () {
            yield* deps.workerRegistry.remove(issue.id);
            if (cause._tag === "Interrupt") {
              // Skip the WorkerExited emit on Interrupt — the
              // InterruptWorker side-effect interpreter already emitted
              // one.
              return;
            }
            yield* deps.log.warn({
              msg: "worker fiber failed with defect",
              issue_id: issue.id,
            });
            yield* Queue.offer(
              deps.events,
              new WorkerExited({
                issue_id: issue.id,
                reason: "abnormal",
                error: "worker defect",
                at: new Date(),
              }),
            );
          }),
        ),
      ),
    );
    yield* deps.workerRegistry.register(issue.id, fiber);
  });

/**
 * Re-evaluate dispatch for the issue whose retry timer just fired (§16.6).
 *
 *   1. If the issue no longer appears in `fetchCandidateIssues`, release
 *      the claim and let the next normal tick re-acquire it if it returns.
 *   2. If no slots are available, schedule a fresh retry at attempt+1
 *      with the appropriate backoff and the standard error.
 *   3. Otherwise, fork a worker with the current attempt count.
 */
const handleRetryFire = (
  issueId: string,
  attempt: number,
  deps: Deps,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const workflow = yield* deps.loader.current;
    const candidatesResult = yield* Effect.either(
      deps.linear.fetchCandidateIssues,
    );
    if (candidatesResult._tag === "Left") {
      yield* deps.log.warn({
        msg: "retry fire: candidate fetch failed; releasing claim",
        issue_id: issueId,
        error_tag: candidatesResult.left._tag,
      });
      yield* SubscriptionRef.update(deps.stateRef, (s) => ({
        ...s,
        claimed: removeFromSet(s.claimed, issueId),
      }));
      return;
    }
    const issue = candidatesResult.right.find((i) => i.id === issueId);
    if (issue === undefined) {
      yield* deps.log.info({
        msg: "retry fire: issue no longer in candidates; releasing claim",
        issue_id: issueId,
      });
      yield* SubscriptionRef.update(deps.stateRef, (s) => ({
        ...s,
        claimed: removeFromSet(s.claimed, issueId),
      }));
      return;
    }

    const state = yield* SubscriptionRef.get(deps.stateRef);
    const plan = selectDispatchBatch([issue], state, workflow.config);
    if (plan.toDispatch.length === 0) {
      // No slot — re-schedule at attempt+1. We update the SubscriptionRef
      // directly with a fresh RetryEntry (the reducer's reaction to
      // RetryTimerFired already removed the prior one); the side-effect
      // interpreter then forks the matching timer fiber.
      const nextAttempt = attempt + 1;
      const cap = workflow.config.agent_runner.max_retry_backoff_ms;
      const delayMs = computeFailureBackoffMs(nextAttempt, cap);
      const dueAtMs = Date.now() + delayMs;
      yield* deps.log.info({
        msg: "retry fire: no slot; re-queuing",
        issue_id: issueId,
        attempt: nextAttempt,
        delay_ms: delayMs,
      });
      yield* SubscriptionRef.update(deps.stateRef, (s) => {
        const next = new Map(s.retry_attempts);
        next.set(issueId, {
          issue_id: issueId,
          identifier: issue.identifier,
          attempt: nextAttempt,
          due_at_ms: dueAtMs,
          timer_handle: null,
          error: "no available orchestrator slots",
        });
        return { ...s, retry_attempts: next };
      });
      yield* interpretSideEffect(
        new ScheduleRetry({
          issue_id: issueId,
          identifier: issue.identifier,
          attempt: nextAttempt,
          delay_ms: delayMs,
          error: "no available orchestrator slots",
        }),
        deps,
      );
      return;
    }

    yield* forkOneWorker(issue, workflow, deps);
  });

/* -------------------------------------------------------------------------- */
/* Layer.                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Live Layer for the Orchestrator. Builds initial state from the current
 * WorkflowLoader snapshot, forks the consumer/tick/reload subscriber
 * fibers, and exposes the service handle.
 *
 * The Layer is scoped: closing it interrupts every forked fiber and
 * tears down the subprocess scopes the workers were running under.
 */
export const OrchestratorLive: Layer.Layer<
  Orchestrator,
  never,
  | WorkflowLoader
  | LinearClient
  | Logger
  | Sandbox
  | McpServer
  | WorkspaceHooks
  | WorkspaceManager
> = Layer.scoped(
  Orchestrator,
  Effect.gen(function* () {
    const loader = yield* WorkflowLoader;
    const linear = yield* LinearClient;
    const log = yield* Logger;
    const mcpServer = yield* McpServer;
    const workspaceHooks = yield* WorkspaceHooks;
    const workspaceManager = yield* WorkspaceManager;
    const sandbox = yield* Sandbox;

    const workflow = yield* loader.current;
    const stateRef = yield* SubscriptionRef.make(initialState(workflow.config));

    const events = yield* Queue.bounded<OrchestratorEvent>(
      EVENT_QUEUE_CAPACITY,
    );
    yield* Effect.addFinalizer(() => Queue.shutdown(events));

    const retryRegistry = yield* makeRetryRegistry;
    const workerRegistry = yield* makeWorkerRegistry;

    // Ensure shutdown interrupts every running worker / timer.
    yield* Effect.addFinalizer(() => workerRegistry.interruptAll);
    yield* Effect.addFinalizer(() => retryRegistry.cancelAll);

    const deps: Deps = {
      stateRef,
      retryRegistry,
      workerRegistry,
      events,
      loader,
      linear,
      mcpServer,
      workspaceManager,
      workspaceHooks,
      log,
      sandbox,
    };

    /* ---------- consumer fiber: reduce + interpret ---------- */
    const consumer = Effect.forever(
      Effect.gen(function* () {
        const event = yield* Queue.take(events);
        // Apply the reducer.
        const current = yield* SubscriptionRef.get(stateRef);
        const result = reduce(current, event);
        yield* SubscriptionRef.set(stateRef, result.state);
        // Interpret side effects sequentially.
        for (const eff of result.sideEffects) {
          yield* interpretSideEffect(eff, deps);
        }
        // Post-reducer special handling: RetryTimerFired triggers a
        // dispatch re-evaluation for that issue (§16.6).
        if (event._tag === "RetryTimerFired") {
          yield* handleRetryFire(event.issue_id, event.attempt, deps);
        }
      }),
    );
    yield* Effect.forkScoped(consumer);

    /* ---------- tick fiber ---------- */
    const tickFiberState = yield* Ref.make<{
      readonly immediateRequested: boolean;
    }>({ immediateRequested: false });
    const tickFiber = Effect.forever(
      Effect.gen(function* () {
        const stateNow = yield* SubscriptionRef.get(stateRef);
        const intervalMs = Math.max(
          MIN_TICK_INTERVAL_MS,
          stateNow.poll_interval_ms,
        );
        yield* Effect.raceAll([
          Effect.sleep(Duration.millis(intervalMs)),
          waitForImmediate(tickFiberState),
        ]);
        yield* Ref.set(tickFiberState, { immediateRequested: false });
        yield* runTick(deps).pipe(
          Effect.catchAllCause((cause) =>
            log.warn({
              msg: "tick fiber error caught; continuing",
              cause: String(cause),
            }),
          ),
        );
      }),
    );
    yield* Effect.forkScoped(tickFiber);

    /* ---------- workflow-reload subscriber ---------- */
    yield* Effect.forkScoped(
      loader.changes.pipe(
        Stream.runForEach((definition) =>
          Queue.offer(events, new WorkflowReloaded({ definition })).pipe(
            Effect.asVoid,
          ),
        ),
        Effect.catchAll(() => Effect.void),
      ),
    );

    /* ---------- service implementation ---------- */
    const service: OrchestratorService = {
      state: SubscriptionRef.get(stateRef),
      stateChanges: stateRef.changes,
      enqueue: (event) =>
        Effect.gen(function* () {
          // Special-case ImmediateTickRequested: signal the tick fiber
          // BEFORE enqueueing the reducer event so the loop reacts on
          // its next iteration without waiting for poll_interval_ms.
          if (event._tag === "ImmediateTickRequested") {
            yield* Ref.set(tickFiberState, { immediateRequested: true });
          }
          yield* Queue.offer(events, event).pipe(Effect.asVoid);
        }),
    };
    return service;
  }),
);

/* -------------------------------------------------------------------------- */
/* Internal helpers.                                                          */
/* -------------------------------------------------------------------------- */

const lowercaseSet = (xs: ReadonlyArray<string>): ReadonlySet<string> => {
  const out = new Set<string>();
  for (const x of xs) out.add(x.toLowerCase());
  return out;
};

const removeFromSet = <T>(s: ReadonlySet<T>, v: T): ReadonlySet<T> => {
  if (!s.has(v)) return s;
  const next = new Set(s);
  next.delete(v);
  return next;
};

/**
 * Wait until the tick-fiber state's `immediateRequested` flag is set.
 * Polls at a small interval (testable via `TestClock`); the consumer
 * sets the flag synchronously via `enqueue`, so this returns promptly
 * on a real request.
 */
const waitForImmediate = (
  ref: Ref.Ref<{ readonly immediateRequested: boolean }>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    while (true) {
      const cur = yield* Ref.get(ref);
      if (cur.immediateRequested) return;
      yield* Effect.sleep(Duration.millis(25));
    }
  });

