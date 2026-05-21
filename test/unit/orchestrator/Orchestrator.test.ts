// Integration-style tests for src/orchestrator/Orchestrator.ts.
// Drives the live consumer/tick fibers against stubbed services and TestClock.
import { describe, expect, it } from "bun:test";
import {
  Effect,
  Layer,
  Queue,
  Ref,
  Schema,
  Stream,
  SubscriptionRef,
  TestClock,
  TestContext,
} from "effect";
import {
  TopLevelSchema,
  type TypedConfig,
  type WorkflowDefinition,
} from "../../../src/config/WorkflowSchema.ts";
import { WorkflowLoader } from "../../../src/config/WorkflowLoader.ts";
import { LinearClient } from "../../../src/linear/LinearClient.ts";
import type {
  Issue,
  MinimalIssue,
  LinearClientError,
} from "../../../src/linear/schemas.ts";
import { Logger } from "../../../src/observability/Logger.ts";
import { McpServer } from "../../../src/claude/McpServer.ts";
import { Sandbox } from "../../../src/sandbox/Nono.ts";
import { WorkspaceHooks } from "../../../src/workspace/Hooks.ts";
import { WorkspaceManager } from "../../../src/workspace/WorkspaceManager.ts";
import {
  Orchestrator,
  OrchestratorLive,
} from "../../../src/orchestrator/Orchestrator.ts";
import {
  ImmediateTickRequested,
  WorkerExited,
  WorkerStarted,
  type OrchestratorEvent,
} from "../../../src/orchestrator/events.ts";
import { newRunningEntry } from "../../../src/orchestrator/State.ts";

/* -------------------------------------------------------------------------- */
/* Stub layers.                                                               */
/* -------------------------------------------------------------------------- */

const baseConfig = (
  patch: {
    polling_interval_ms?: number;
    max_concurrent_agents?: number;
    max_retry_backoff_ms?: number;
    stall_timeout_ms?: number;
  } = {},
): TypedConfig => {
  const decoded = Schema.decodeUnknownSync(TopLevelSchema)({});
  return {
    tracker: {
      kind: decoded.tracker.kind,
      endpoint: decoded.tracker.endpoint,
      api_key: "tok",
      project_slug: "proj",
      active_states: decoded.tracker.active_states,
      terminal_states: decoded.tracker.terminal_states,
    },
    polling: {
      interval_ms: patch.polling_interval_ms ?? decoded.polling.interval_ms,
    },
    workspace: { root: decoded.workspace.root ?? "/tmp/symphony_ws" },
    hooks: {
      after_create: decoded.hooks.after_create,
      before_run: decoded.hooks.before_run,
      after_run: decoded.hooks.after_run,
      before_remove: decoded.hooks.before_remove,
      timeout_ms: decoded.hooks.timeout_ms,
    },
    agent_runner: {
      kind: decoded.agent_runner.kind,
      command: decoded.agent_runner.command,
      permission_mode: decoded.agent_runner.permission_mode,
      max_turns: decoded.agent_runner.max_turns,
      turn_timeout_ms: decoded.agent_runner.turn_timeout_ms,
      read_timeout_ms: decoded.agent_runner.read_timeout_ms,
      stall_timeout_ms:
        patch.stall_timeout_ms ?? decoded.agent_runner.stall_timeout_ms,
      network_profile: decoded.agent_runner.network_profile,
      bare: decoded.agent_runner.bare,
      extra_args: decoded.agent_runner.extra_args,
      max_concurrent_agents:
        patch.max_concurrent_agents ??
        decoded.agent_runner.max_concurrent_agents,
      max_concurrent_agents_by_state:
        decoded.agent_runner.max_concurrent_agents_by_state,
      max_retry_backoff_ms:
        patch.max_retry_backoff_ms ??
        decoded.agent_runner.max_retry_backoff_ms,
      continuation_prompt: decoded.agent_runner.continuation_prompt,
    },
    server: null,
  };
};

const makeIssue = (overrides: Partial<Issue> = {}): Issue => ({
  id: "issue-1",
  identifier: "MT-1",
  title: "Test issue",
  description: null,
  priority: 2,
  state: "Todo",
  branch_name: null,
  url: null,
  labels: [],
  blocked_by: [],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  ...overrides,
});

interface StubbedLoader {
  readonly layer: Layer.Layer<WorkflowLoader>;
  readonly pushReload: (cfg: TypedConfig) => Effect.Effect<void>;
}

const stubLoader = (initial: TypedConfig): Effect.Effect<StubbedLoader> =>
  Effect.gen(function* () {
    const defRef = yield* SubscriptionRef.make<WorkflowDefinition>({
      config: initial,
      prompt_template: "p",
      source_path: "/tmp/WORKFLOW.md",
    });
    const layer: Layer.Layer<WorkflowLoader> = Layer.succeed(
      WorkflowLoader,
      {
        current: SubscriptionRef.get(defRef),
        changes: defRef.changes,
        validateForDispatch: Effect.void,
      },
    );
    const pushReload = (cfg: TypedConfig): Effect.Effect<void> =>
      SubscriptionRef.set(defRef, {
        config: cfg,
        prompt_template: "p",
        source_path: "/tmp/WORKFLOW.md",
      });
    return { layer, pushReload };
  });

interface StubbedLinear {
  readonly layer: Layer.Layer<LinearClient>;
  readonly callCounts: Effect.Effect<{
    readonly candidates: number;
    readonly states: number;
  }>;
  readonly setCandidates: (
    issues: ReadonlyArray<Issue>,
  ) => Effect.Effect<void>;
  readonly setStateRefresh: (
    states: ReadonlyArray<MinimalIssue>,
  ) => Effect.Effect<void>;
}

const stubLinear: Effect.Effect<StubbedLinear> = Effect.gen(function* () {
  const candidatesRef = yield* Ref.make<ReadonlyArray<Issue>>([]);
  const statesRef = yield* Ref.make<ReadonlyArray<MinimalIssue>>([]);
  const counts = yield* Ref.make({ candidates: 0, states: 0 });
  const layer: Layer.Layer<LinearClient> = Layer.succeed(LinearClient, {
    fetchCandidateIssues: Effect.gen(function* () {
      yield* Ref.update(counts, (c) => ({
        ...c,
        candidates: c.candidates + 1,
      }));
      return yield* Ref.get(candidatesRef);
    }),
    fetchIssuesByStates: () => Effect.succeed([] as ReadonlyArray<Issue>),
    fetchIssueStatesByIds: (
      _ids: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<MinimalIssue>, LinearClientError> =>
      Effect.gen(function* () {
        yield* Ref.update(counts, (c) => ({ ...c, states: c.states + 1 }));
        return yield* Ref.get(statesRef);
      }),
    executeRaw: () => Effect.succeed(null),
  });
  return {
    layer,
    callCounts: Ref.get(counts),
    setCandidates: (issues) => Ref.set(candidatesRef, issues),
    setStateRefresh: (states) => Ref.set(statesRef, states),
  };
});

const sandboxLayerFailingSpawn: Layer.Layer<Sandbox> = Layer.succeed(Sandbox, {
  spawn: () =>
    Effect.fail({
      _tag: "SandboxSpawnFailed",
      argv: [],
      message: "stubbed sandbox: spawn disabled in tests",
    } as never),
});

const mcpServerLayer: Layer.Layer<McpServer> = Layer.succeed(McpServer, {
  handle: () => Effect.succeed(null),
});

const workspaceHooksLayer: Layer.Layer<WorkspaceHooks> = Layer.succeed(
  WorkspaceHooks,
  {
    runAfterCreate: () => Effect.void,
    runBeforeRun: () => Effect.void,
    runAfterRun: () => Effect.void,
    runBeforeRemove: () => Effect.void,
  },
);

const workspaceManagerLayer: Layer.Layer<WorkspaceManager> = Layer.succeed(
  WorkspaceManager,
  {
    prepareForIssue: (issue: Issue) =>
      Effect.succeed({
        path: ("/tmp/symphony_ws/" + issue.identifier) as never,
        workspace_key: issue.identifier,
        created_now: false,
      }),
    cleanWorkspaceFor: () => Effect.void,
    startupTerminalCleanup: () => Effect.void,
  },
);

const silentLoggerLayer: Layer.Layer<Logger> = Layer.succeed(Logger, {
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
  recentEvents: Effect.succeed([]),
});

/* -------------------------------------------------------------------------- */
/* Helpers.                                                                   */
/* -------------------------------------------------------------------------- */

const pollUntil = <A>(
  read: Effect.Effect<A>,
  pred: (a: A) => boolean,
  budgetTicks = 300,
): Effect.Effect<A> =>
  Effect.gen(function* () {
    for (let i = 0; i < budgetTicks; i++) {
      const v = yield* read;
      if (pred(v)) return v;
      yield* Effect.sleep("10 millis");
    }
    throw new Error("pollUntil exceeded budget");
  });

/* -------------------------------------------------------------------------- */
/* Tests.                                                                     */
/* -------------------------------------------------------------------------- */

describe("OrchestratorLive — tick + immediate tick", () => {
  it("performs at least one tick after the poll interval elapses", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const loader = yield* stubLoader(
          baseConfig({ polling_interval_ms: 500 }),
        );
        const linear = yield* stubLinear;
        yield* linear.setCandidates([]);
        const fullLayer = Layer.mergeAll(
          loader.layer,
          linear.layer,
          silentLoggerLayer,
          sandboxLayerFailingSpawn,
          mcpServerLayer,
          workspaceHooksLayer,
          workspaceManagerLayer,
        );

        const inner = Effect.gen(function* () {
          const orch = yield* Orchestrator;
          // Wait for the tick fiber to fire at least once.
          yield* pollUntil(linear.callCounts, (c) => c.candidates >= 1);
          const counts = yield* linear.callCounts;
          expect(counts.candidates).toBeGreaterThanOrEqual(1);
          void orch;
        });
        yield* Effect.provide(
          inner,
          OrchestratorLive.pipe(Layer.provide(fullLayer)),
        );
      }),
    );
    await Effect.runPromise(program);
  }, 10_000);

  it("ImmediateTickRequested fires the tick promptly", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const loader = yield* stubLoader(
          baseConfig({ polling_interval_ms: 60 * 60 * 1000 }),
        );
        const linear = yield* stubLinear;
        yield* linear.setCandidates([]);
        const fullLayer = Layer.mergeAll(
          loader.layer,
          linear.layer,
          silentLoggerLayer,
          sandboxLayerFailingSpawn,
          mcpServerLayer,
          workspaceHooksLayer,
          workspaceManagerLayer,
        );
        const inner = Effect.gen(function* () {
          const orch = yield* Orchestrator;
          yield* orch.enqueue(new ImmediateTickRequested({ at: new Date() }));
          yield* pollUntil(linear.callCounts, (c) => c.candidates >= 1);
          const counts = yield* linear.callCounts;
          expect(counts.candidates).toBeGreaterThanOrEqual(1);
        });
        yield* Effect.provide(
          inner,
          OrchestratorLive.pipe(Layer.provide(fullLayer)),
        );
      }),
    );
    await Effect.runPromise(program);
  }, 10_000);

  it("WorkflowReloaded updates poll_interval_ms in state", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const loader = yield* stubLoader(
          baseConfig({ polling_interval_ms: 60_000 }),
        );
        const linear = yield* stubLinear;
        const fullLayer = Layer.mergeAll(
          loader.layer,
          linear.layer,
          silentLoggerLayer,
          sandboxLayerFailingSpawn,
          mcpServerLayer,
          workspaceHooksLayer,
          workspaceManagerLayer,
        );
        const inner = Effect.gen(function* () {
          const orch = yield* Orchestrator;
          const initial = yield* orch.state;
          expect(initial.poll_interval_ms).toBe(60_000);
          yield* loader.pushReload(
            baseConfig({ polling_interval_ms: 12_345 }),
          );
          yield* pollUntil(orch.state, (s) => s.poll_interval_ms === 12_345);
          const updated = yield* orch.state;
          expect(updated.poll_interval_ms).toBe(12_345);
        });
        yield* Effect.provide(
          inner,
          OrchestratorLive.pipe(Layer.provide(fullLayer)),
        );
      }),
    );
    await Effect.runPromise(program);
  }, 10_000);
});

describe("OrchestratorLive — abnormal worker exit triggers backoff retry", () => {
  it("schedules a retry with attempt=1, delay=10s after a single abnormal exit", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const loader = yield* stubLoader(
          baseConfig({ polling_interval_ms: 60 * 60 * 1000 }),
        );
        const linear = yield* stubLinear;
        const fullLayer = Layer.mergeAll(
          loader.layer,
          linear.layer,
          silentLoggerLayer,
          sandboxLayerFailingSpawn,
          mcpServerLayer,
          workspaceHooksLayer,
          workspaceManagerLayer,
        );
        const inner = Effect.gen(function* () {
          const orch = yield* Orchestrator;
          const issue = makeIssue();
          const runningEntry = newRunningEntry({
            issue,
            workspace_path: "/tmp/ws/MT-1",
            started_at: new Date("2024-01-01T00:00:00Z"),
            attempt: null,
            retry_attempt: null,
          });
          yield* orch.enqueue(new WorkerStarted({ issue, runningEntry }));
          yield* pollUntil(orch.state, (s) => s.running.has(issue.id));
          yield* orch.enqueue(
            new WorkerExited({
              issue_id: issue.id,
              reason: "abnormal",
              error: "test injected failure",
              at: new Date("2024-01-01T00:00:10Z"),
            }),
          );
          const after = yield* pollUntil(
            orch.state,
            (s) => s.retry_attempts.has(issue.id),
          );
          const retry = after.retry_attempts.get(issue.id);
          expect(retry?.attempt).toBe(1);
          const expectedDelay = 10_000;
          const dueDelta = (retry?.due_at_ms ?? 0) -
            new Date("2024-01-01T00:00:10Z").getTime();
          expect(dueDelta).toBe(expectedDelay);
        });
        yield* Effect.provide(
          inner,
          OrchestratorLive.pipe(Layer.provide(fullLayer)),
        );
      }),
    );
    await Effect.runPromise(program);
  }, 10_000);
});

describe("OrchestratorLive — slot-exhaustion at retry time", () => {
  it("when no slots available, re-queues with error 'no available orchestrator slots'", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const loader = yield* stubLoader(
          baseConfig({
            polling_interval_ms: 60 * 60 * 1000,
            max_concurrent_agents: 1,
          }),
        );
        const linear = yield* stubLinear;
        const fullLayer = Layer.mergeAll(
          loader.layer,
          linear.layer,
          silentLoggerLayer,
          sandboxLayerFailingSpawn,
          mcpServerLayer,
          workspaceHooksLayer,
          workspaceManagerLayer,
        );
        const inner = Effect.gen(function* () {
          const orch = yield* Orchestrator;

          // issue-A takes the only slot.
          const runningIssue = makeIssue({
            id: "issue-A",
            identifier: "MT-A",
          });
          yield* orch.enqueue(
            new WorkerStarted({
              issue: runningIssue,
              runningEntry: newRunningEntry({
                issue: runningIssue,
                workspace_path: "/tmp/ws/MT-A",
                started_at: new Date(),
                attempt: null,
                retry_attempt: null,
              }),
            }),
          );
          yield* pollUntil(orch.state, (s) => s.running.has(runningIssue.id));

          // issue-B is the candidate that will retry-fire with no slot.
          const retryIssue = makeIssue({
            id: "issue-B",
            identifier: "MT-B",
          });
          yield* linear.setCandidates([retryIssue]);
          // Seed a retry entry for issue-B via WorkerStarted + abnormal Exit.
          yield* orch.enqueue(
            new WorkerStarted({
              issue: retryIssue,
              runningEntry: newRunningEntry({
                issue: retryIssue,
                workspace_path: "/tmp/ws/MT-B",
                started_at: new Date(),
                attempt: null,
                retry_attempt: null,
              }),
            }),
          );
          yield* orch.enqueue(
            new WorkerExited({
              issue_id: retryIssue.id,
              reason: "abnormal",
              error: "boom",
              at: new Date(),
            }),
          );
          const seeded = yield* pollUntil(
            orch.state,
            (s) => s.retry_attempts.has(retryIssue.id),
          );
          const initialRetry = seeded.retry_attempts.get(retryIssue.id)!;
          // Fire the timer immediately by enqueueing the event ourselves.
          yield* orch.enqueue({
            _tag: "RetryTimerFired",
            issue_id: retryIssue.id,
            attempt: initialRetry.attempt,
          } as OrchestratorEvent);
          // The §16.6 handler should re-queue with the slot-exhausted error.
          const after = yield* pollUntil(orch.state, (s) => {
            const r = s.retry_attempts.get(retryIssue.id);
            return (
              r !== undefined &&
              r.error === "no available orchestrator slots"
            );
          });
          const requeued = after.retry_attempts.get(retryIssue.id);
          expect(requeued?.error).toBe("no available orchestrator slots");
          expect(requeued?.attempt).toBe(initialRetry.attempt + 1);
        });
        yield* Effect.provide(
          inner,
          OrchestratorLive.pipe(Layer.provide(fullLayer)),
        );
      }),
    );
    await Effect.runPromise(program);
  }, 10_000);
});

describe("OrchestratorLive — stall reconcile interrupts a running worker", () => {
  it("emits StallDetected + InterruptWorker → WorkerExited(abnormal)", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        // 100ms stall timeout, short poll so the tick fires quickly.
        const loader = yield* stubLoader(
          baseConfig({ polling_interval_ms: 200, stall_timeout_ms: 100 }),
        );
        const linear = yield* stubLinear;
        yield* linear.setCandidates([]);
        const fullLayer = Layer.mergeAll(
          loader.layer,
          linear.layer,
          silentLoggerLayer,
          sandboxLayerFailingSpawn,
          mcpServerLayer,
          workspaceHooksLayer,
          workspaceManagerLayer,
        );
        const inner = Effect.gen(function* () {
          const orch = yield* Orchestrator;
          const issue = makeIssue();
          const past = new Date(Date.now() - 60_000);
          yield* orch.enqueue(
            new WorkerStarted({
              issue,
              runningEntry: newRunningEntry({
                issue,
                workspace_path: "/tmp/ws/MT-1",
                started_at: past,
                attempt: null,
                retry_attempt: null,
              }),
            }),
          );
          yield* pollUntil(orch.state, (s) => s.running.has(issue.id));
          yield* pollUntil(
            orch.state,
            (s) =>
              !s.running.has(issue.id) && s.retry_attempts.has(issue.id),
          );
          const after = yield* orch.state;
          expect(after.running.has(issue.id)).toBe(false);
          expect(after.retry_attempts.has(issue.id)).toBe(true);
        });
        yield* Effect.provide(
          inner,
          OrchestratorLive.pipe(Layer.provide(fullLayer)),
        );
      }),
    );
    await Effect.runPromise(program);
  }, 10_000);
});

describe("OrchestratorLive — state + stateChanges", () => {
  it("publishes state updates on the changes stream", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const loader = yield* stubLoader(
          baseConfig({ polling_interval_ms: 60 * 60 * 1000 }),
        );
        const linear = yield* stubLinear;
        const fullLayer = Layer.mergeAll(
          loader.layer,
          linear.layer,
          silentLoggerLayer,
          sandboxLayerFailingSpawn,
          mcpServerLayer,
          workspaceHooksLayer,
          workspaceManagerLayer,
        );
        const inner = Effect.gen(function* () {
          const orch = yield* Orchestrator;
          const collected = yield* Queue.unbounded<number>();
          yield* Effect.forkScoped(
            orch.stateChanges.pipe(
              Stream.runForEach((s) =>
                Queue.offer(collected, s.running.size).pipe(Effect.asVoid),
              ),
            ),
          );
          // Initial snapshot.
          const first = yield* Queue.take(collected);
          expect(first).toBe(0);
          const issue = makeIssue();
          yield* orch.enqueue(
            new WorkerStarted({
              issue,
              runningEntry: newRunningEntry({
                issue,
                workspace_path: "/tmp/ws/MT-1",
                started_at: new Date(),
                attempt: null,
                retry_attempt: null,
              }),
            }),
          );
          let next = yield* Queue.take(collected);
          while (next !== 1) next = yield* Queue.take(collected);
          expect(next).toBe(1);
        });
        yield* Effect.provide(
          inner,
          OrchestratorLive.pipe(Layer.provide(fullLayer)),
        );
      }),
    );
    await Effect.runPromise(program);
  }, 10_000);
});

// Confirm TestClock + TestContext compile against the project.
describe("TestClock compatibility", () => {
  it("can run a sleep against TestClock", async () => {
    const program = Effect.gen(function* () {
      const fired = yield* Ref.make(false);
      const fiber = yield* Effect.forkDaemon(
        Effect.gen(function* () {
          yield* Effect.sleep("10 seconds");
          yield* Ref.set(fired, true);
        }),
      );
      yield* TestClock.adjust("10 seconds");
      yield* fiber.await;
      return yield* Ref.get(fired);
    });
    const fired = await Effect.runPromise(
      program.pipe(Effect.provide(TestContext.TestContext)),
    );
    expect(fired).toBe(true);
  });
});

