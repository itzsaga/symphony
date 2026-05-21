// Per-issue worker pipeline: workspace → hooks → claude subprocess → turn loop.
// One worker fiber per dispatched issue, feeding RuntimeEvents back via the shared orchestrator queue.
import { dirname } from "node:path";
import {
  Deferred,
  Effect,
  Either,
  Queue,
  Ref,
  Scope,
  Stream,
} from "effect";
import { type AbsolutePath, toAbsolutePathSync } from "../config/PathSafety.ts";
import type { WorkflowDefinition } from "../config/WorkflowSchema.ts";
import type { Issue } from "../linear/schemas.ts";
import type { LinearClient } from "../linear/LinearClient.ts";
import { renderPrompt } from "../prompt/Render.ts";
import {
  serve as serveControlProtocol,
  defaultHandlers,
  type TurnInputRequiredEvent,
} from "../claude/ControlProtocol.ts";
import { spawn as spawnClaude } from "../claude/ClaudeSubprocess.ts";
import {
  mapFrame,
  ProcessExited,
  TurnInputRequired,
} from "../claude/EventMapping.ts";
import { initialClaudeSessionState } from "../claude/sessionState.ts";
import type { OutboundUserMessage } from "../claude/StreamJson.ts";
import type { McpServer } from "../claude/McpServer.ts";
import type { Sandbox } from "../sandbox/Nono.ts";
import { Logger } from "../observability/Logger.ts";
import type { WorkspaceManager, Workspace } from "../workspace/WorkspaceManager.ts";
import type { WorkspaceHooks } from "../workspace/Hooks.ts";
import { WorkerEventReceived } from "./events.ts";
import type { OrchestratorEvent } from "./events.ts";

/* -------------------------------------------------------------------------- */
/* Public Worker types.                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Result of running one worker pipeline to completion. The orchestrator
 * uses this to emit a `WorkerExited` event; the worker fiber itself never
 * emits that event directly (the consumer fiber owns event production so
 * the side-effect interpreter is the single observer of completion).
 */
export interface WorkerExitOutcome {
  readonly reason: "normal" | "abnormal";
  readonly error: string | null;
  readonly at: Date;
}

/* -------------------------------------------------------------------------- */
/* Worker configuration.                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Inputs the orchestrator hands to {@link runWorker}. Effects are not
 * resolved here — the worker pulls everything it needs from the Effect
 * context (LinearClient, McpServer, Sandbox, Logger) when it runs.
 */
export interface WorkerInput {
  readonly issue: Issue;
  /** Snapshot of WORKFLOW.md to use for this worker's lifetime (§5.4). */
  readonly workflow: WorkflowDefinition;
  /** Retry attempt counter passed into the prompt template (§5.4). */
  readonly retry_attempt: number | null;
  /**
   * Queue to push `OrchestratorEvent`s onto. Worker pushes
   * `WorkerEventReceived` per RuntimeEvent emitted by the subprocess; the
   * consumer fiber owns translating exits into `WorkerExited`.
   */
  readonly events: Queue.Enqueue<OrchestratorEvent>;
  /**
   * Workspace handles. Passed in (rather than re-fetched from the
   * WorkspaceManager) so callers in tests can stub them.
   */
  readonly workspaceManager: WorkspaceManager["Type"];
  readonly workspaceHooks: WorkspaceHooks["Type"];
  /** MCP server handle for in-process linear_graphql calls. */
  readonly mcpServer: McpServer["Type"];
  /** Linear client for state-refresh fetches between turns. */
  readonly linear: LinearClient["Type"];
}

/* -------------------------------------------------------------------------- */
/* MCP config blob.                                                           */
/*                                                                            */
/* The `claude` CLI consumes `--mcp-config <json-or-path>`. v1 uses the       */
/* "in-process via stdio" wiring: the CLI calls the host back over the same  */
/* stream-json pipe via `control_request.mcp_message`. The JSON object below */
/* tells the CLI a single server named "symphony" exists; the actual         */
/* delivery is via control protocol (no socket/pipe).                        */
/* -------------------------------------------------------------------------- */

const buildMcpConfigBlob = (): string =>
  JSON.stringify({
    mcpServers: {
      symphony: {
        type: "stdio",
      },
    },
  });

/* -------------------------------------------------------------------------- */
/* Continuation-prompt — appended on each subsequent turn.                    */
/* -------------------------------------------------------------------------- */

/**
 * Synthesize a brief "continue" prompt for follow-on turns. v1's strategy is
 * the simplest one that works: re-affirm the active issue and let Claude
 * decide what to do next. A future task can move this into WORKFLOW.md's
 * prompt block as an opt-in template (§5.4).
 */
const continuationPrompt = (issue: Issue, turnIndex: number): string =>
  `Continue working on issue ${issue.identifier} (${issue.title}). This is turn ${turnIndex + 1}.`;

/* -------------------------------------------------------------------------- */
/* Public entry point.                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Run one worker pipeline to completion. Returns a `WorkerExitOutcome`
 * describing how the worker exited; the caller (Orchestrator) is
 * responsible for emitting the matching `WorkerExited` event so the
 * reducer's bookkeeping runs through the single-authority consumer fiber.
 *
 * Failures inside the pipeline are caught and surfaced as
 * `{ reason: "abnormal", error }` — the orchestrator's retry/backoff math
 * keys off `reason`, not off an Effect failure channel.
 */
export const runWorker = (
  input: WorkerInput,
): Effect.Effect<
  WorkerExitOutcome,
  never,
  Sandbox | Logger | Scope.Scope
> =>
  Effect.gen(function* () {
    const log = yield* Logger;
    // The worker scope is the caller's scope (passed in via the Effect
    // context). Everything we spawn here — subprocess, fibers — is bound
    // to that scope so the worker can be cleanly interrupted by the
    // orchestrator (reconcile, stall, etc).

    const issue = input.issue;
    yield* log.info({
      msg: "worker pipeline starting",
      issue_id: issue.id,
      identifier: issue.identifier,
      retry_attempt: input.retry_attempt,
    });

    // 1. Workspace + after_create.
    const workspaceResult = yield* Effect.either(
      input.workspaceManager.prepareForIssue(issue),
    );
    if (Either.isLeft(workspaceResult)) {
      const err = workspaceResult.left;
      yield* log.warn({
        msg: "worker: workspace prepare failed",
        issue_id: issue.id,
        error_tag: err._tag,
      });
      return abnormal(`workspace prepare failed: ${err._tag}`);
    }
    const workspace: Workspace = workspaceResult.right;

    if (workspace.created_now) {
      const afterCreate = yield* Effect.either(
        input.workspaceHooks.runAfterCreate(workspace),
      );
      if (Either.isLeft(afterCreate)) {
        return abnormal(`after_create hook failed: ${afterCreate.left._tag}`);
      }
    }

    // 2. Initial prompt.
    const promptResult = yield* Effect.either(
      renderPrompt(input.workflow.prompt_template, {
        issue,
        attempt: input.retry_attempt,
      }),
    );
    if (Either.isLeft(promptResult)) {
      return abnormal(`prompt render failed: ${promptResult.left._tag}`);
    }
    let currentPrompt = promptResult.right;

    // 3. Turn loop.
    const workflowDir = toAbsolutePathSync(dirname(input.workflow.source_path));
    const mcpConfigBlob = buildMcpConfigBlob();
    const maxTurns = input.workflow.config.agent_runner.max_turns;

    let turnIndex = 0;
    let outcome: WorkerExitOutcome | null = null;

    // The whole spawn lives in a child scope so we can stop the subprocess
    // cleanly between attempts. v1 spawns once and holds the session open
    // for `max_turns` turns — a single subprocess across multiple turns
    // matches the streaming-mode CLI's "feed me one user message per turn"
    // contract from research/claude-stream-json.md §1.
    yield* Effect.scoped(
      Effect.gen(function* () {
        // before_run for the first turn.
        const beforeRunFirst = yield* Effect.either(
          input.workspaceHooks.runBeforeRun(workspace),
        );
        if (Either.isLeft(beforeRunFirst)) {
          outcome = abnormal(
            `before_run hook failed: ${beforeRunFirst.left._tag}`,
          );
          return;
        }

        // Spawn the subprocess. If spawn fails, surface as abnormal.
        const spawned = yield* Effect.either(
          spawnClaude({
            workspace: workspace.path as AbsolutePath,
            workflow_dir: workflowDir,
            config: input.workflow.config,
            mcp_config: mcpConfigBlob,
          }),
        );
        if (Either.isLeft(spawned)) {
          outcome = abnormal(`claude spawn failed: ${spawned.left._tag}`);
          return;
        }
        const subprocess = spawned.right;

        // Mount the control-protocol fiber. The `mcp_message` handler
        // forwards inbound JSON-RPC to the in-process McpServer; the
        // `turn_input_required` queue feeds straight into the event
        // pipeline (§10.4 surfaces this as a fatal-for-this-turn signal).
        const turnInputQueue = yield* Queue.unbounded<TurnInputRequiredEvent>();
        const handlers = {
          ...defaultHandlers(turnInputQueue),
          mcpMessage: (req: {
            readonly message: unknown;
          }): Effect.Effect<unknown, Error> =>
            Effect.gen(function* () {
              const response = yield* input.mcpServer.handle(req.message);
              return response;
            }),
        };
        yield* serveControlProtocol(subprocess, handlers);

        // Fork a consumer fiber that surfaces `turn_input_required` events
        // by short-circuiting the turn loop. The Deferred is signalled the
        // first time a `TurnInputRequired` arrives, which the loop awaits
        // alongside the subprocess's frame stream.
        const inputRequired = yield* Deferred.make<TurnInputRequiredEvent>();
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            const evt = yield* Queue.take(turnInputQueue);
            yield* Deferred.succeed(inputRequired, evt);
            // Drain any subsequent ones so the queue doesn't grow.
            yield* Queue.takeAll(turnInputQueue).pipe(Effect.repeatN(1));
          }),
        );

        // Mount the event-mapping consumer fiber. It reads
        // `subprocess.incoming`, runs `mapFrame` per inbound frame, and
        // pushes resulting `RuntimeEvent`s into the orchestrator queue
        // wrapped in `WorkerEventReceived`. Also tracks per-turn
        // completion via a `Deferred` populated when the next `result`
        // frame (TurnCompleted/TurnFailed) lands.
        const sessionRef = yield* Ref.make(initialClaudeSessionState);
        // Per-turn signal: holds the latest TurnCompleted / TurnFailed
        // event tag so the turn driver can advance.
        const turnEndedRef = yield* Ref.make<
          null | { kind: "completed" } | { kind: "failed"; reason: string }
        >(null);

        const bypass = input.workflow.config.agent_runner.permission_mode ===
          "bypassPermissions";

        yield* Effect.forkScoped(
          subprocess.incoming.pipe(
            Stream.runForEach((frame) =>
              Effect.gen(function* () {
                const state = yield* Ref.get(sessionRef);
                const { events, newState } = mapFrame(frame, state, {
                  bypass_permissions: bypass,
                });
                yield* Ref.set(sessionRef, newState);
                for (const event of events) {
                  yield* Queue.offer(
                    input.events,
                    new WorkerEventReceived({
                      issue_id: issue.id,
                      event,
                    }),
                  );
                  // Snapshot turn-end on TurnCompleted/TurnFailed.
                  switch (event._tag) {
                    case "TurnCompleted":
                      yield* Ref.set(turnEndedRef, { kind: "completed" });
                      break;
                    case "TurnFailed":
                      yield* Ref.set(turnEndedRef, {
                        kind: "failed",
                        reason: `turn_failed:${event.subtype}`,
                      });
                      break;
                    case "StartupFailed":
                      yield* Ref.set(turnEndedRef, {
                        kind: "failed",
                        reason: `startup_failed:${event.subtype}`,
                      });
                      break;
                    default:
                      break;
                  }
                }
              }),
            ),
            // The stream EOFs when the subprocess closes its stdout.
            // We swallow stream errors (the subprocess module logs them
            // separately); the loop below detects natural exit via
            // `awaitExit` so a silent EOF still terminates the worker.
            Effect.catchAll(() => Effect.void),
          ),
        );

        // 4. Turn driver: write the initial user message, await turn
        // end, optionally fetch issue state, decide whether to continue.
        while (turnIndex < maxTurns) {
          // Per-turn before_run (skip for turn 0 — we already ran it
          // above to gate spawn).
          if (turnIndex > 0) {
            const beforeRun = yield* Effect.either(
              input.workspaceHooks.runBeforeRun(workspace),
            );
            if (Either.isLeft(beforeRun)) {
              outcome = abnormal(
                `before_run hook failed: ${beforeRun.left._tag}`,
              );
              break;
            }
          }

          // Send the prompt. The user-message wire shape is the same on
          // both the inbound side (UserMessage) and the outbound side
          // (OutboundUserMessage).
          const userMessage: OutboundUserMessage = {
            type: "user",
            message: {
              role: "user",
              content: currentPrompt,
            },
          };
          yield* Queue.offer(subprocess.outgoing, userMessage);

          // Reset the per-turn ended ref BEFORE we wait — the consumer
          // populates it asynchronously.
          yield* Ref.set(turnEndedRef, null);

          // Wait for either a turn-end signal, a subprocess exit, or a
          // turn_input_required signal. We poll the Refs/awaits with
          // a small race; this is the canonical Effect way to model
          // "first of these events wins".
          const winner = yield* Effect.raceAll([
            // Branch 1: turn-end signal (poll until non-null).
            waitForTurnEnd(turnEndedRef),
            // Branch 2: subprocess exited (process died).
            subprocess.awaitExit.pipe(
              Effect.map(
                (e) => ({ kind: "process_exited", code: e.code, signal: e.signal }) as const,
              ),
            ),
            // Branch 3: turn_input_required (CLI is blocked on a
            // permission decision v1 treats as fatal).
            Deferred.await(inputRequired).pipe(
              Effect.map(
                (e) => ({ kind: "input_required", evt: e }) as const,
              ),
            ),
          ]);

          if (winner.kind === "process_exited") {
            // Emit ProcessExited via the event pipeline so the dashboard
            // sees it, then exit normal if turn completed cleanly first,
            // otherwise abnormal.
            yield* Queue.offer(
              input.events,
              new WorkerEventReceived({
                issue_id: issue.id,
                event: new ProcessExited({
                  code: winner.code,
                  signal: winner.signal,
                }),
              }),
            );
            const ended = yield* Ref.get(turnEndedRef);
            if (ended !== null && ended.kind === "completed") {
              outcome = normal();
            } else {
              outcome = abnormal(
                `subprocess exited (code=${winner.code})`,
              );
            }
            break;
          }
          if (winner.kind === "input_required") {
            // Surface as a worker-event for symmetry, then exit abnormal.
            yield* Queue.offer(
              input.events,
              new WorkerEventReceived({
                issue_id: issue.id,
                event: new TurnInputRequired({
                  thread_id: null,
                  turn_id: null,
                  request_id: winner.evt.request_id,
                  tool_name: winner.evt.tool_name,
                  tool_use_id: null,
                  input: winner.evt.tool_input,
                  title: null,
                  description: null,
                }),
              }),
            );
            outcome = abnormal(
              `turn_input_required for tool=${winner.evt.tool_name}`,
            );
            break;
          }
          // winner.kind === "turn_ended"
          if (winner.signal.kind === "failed") {
            outcome = abnormal(winner.signal.reason);
            break;
          }

          // Best-effort after_run. Failure does not break the loop.
          yield* input.workspaceHooks.runAfterRun(workspace);

          // Refresh issue state from Linear. If we can't determine the
          // state, the safe choice is to stop the worker.
          const refreshed = yield* Effect.either(
            input.linear.fetchIssueStatesByIds([issue.id]),
          );
          if (Either.isLeft(refreshed)) {
            outcome = abnormal(
              `state refresh failed: ${refreshed.left._tag}`,
            );
            break;
          }
          const refreshedList = refreshed.right;
          const stillThere = refreshedList.find((m) => m.id === issue.id);
          if (stillThere === undefined) {
            // Issue disappeared from Linear (or wasn't returned). Treat
            // as a clean exit — continuation retry will pick it back up
            // if it comes back.
            outcome = normal();
            break;
          }
          const activeLower = lowerSet(
            input.workflow.config.tracker.active_states,
          );
          if (!activeLower.has(stillThere.state.toLowerCase())) {
            // Tracker moved out of active states; clean exit.
            outcome = normal();
            break;
          }

          // Otherwise, advance and continue.
          turnIndex += 1;
          if (turnIndex >= maxTurns) {
            // Hit the cap — treat as a normal exit so we schedule a
            // continuation retry (the spec considers max_turns as a
            // session-end signal, not a failure).
            outcome = normal();
            break;
          }
          currentPrompt = continuationPrompt(issue, turnIndex);
        }

        if (outcome === null) {
          // Loop ended without setting outcome (e.g. break-less path);
          // default to normal so the continuation retry fires.
          outcome = normal();
        }
      }),
    );

    // Best-effort after_run on the way out — runs whether or not the
    // last turn invoked it. We re-use the original workspace handle.
    yield* input.workspaceHooks.runAfterRun(workspace);

    return outcome ?? normal();
  });

/* -------------------------------------------------------------------------- */
/* Internal helpers.                                                          */
/* -------------------------------------------------------------------------- */

const normal = (): WorkerExitOutcome => ({
  reason: "normal",
  error: null,
  at: new Date(),
});

const abnormal = (error: string): WorkerExitOutcome => ({
  reason: "abnormal",
  error,
  at: new Date(),
});

const lowerSet = (xs: ReadonlyArray<string>): ReadonlySet<string> => {
  const out = new Set<string>();
  for (const x of xs) out.add(x.toLowerCase());
  return out;
};

/**
 * Poll a Ref until it is non-null. Returns a tagged "turn_ended" so the
 * race in `runWorker` can disambiguate from other branches without an
 * additional discriminator.
 */
const waitForTurnEnd = (
  ref: Ref.Ref<
    null | { kind: "completed" } | { kind: "failed"; reason: string }
  >,
): Effect.Effect<{
  readonly kind: "turn_ended";
  readonly signal: { kind: "completed" } | { kind: "failed"; reason: string };
}> =>
  Effect.gen(function* () {
    while (true) {
      const v = yield* Ref.get(ref);
      if (v !== null) {
        return { kind: "turn_ended" as const, signal: v };
      }
      // Yield to the runtime so the consumer fiber gets a chance to
      // update the ref. A small sleep is the simplest "wait for a Ref
      // change" primitive; for v1's pacing (~seconds per turn) the
      // 50ms granularity is invisible.
      yield* Effect.sleep("50 millis");
    }
  });

