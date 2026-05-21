// SideEffect: the tagged union of intents the reducer emits for the runtime to
// execute. The reducer is pure; the runtime fiber interprets these.
import { Data } from "effect";
import type { Issue, MinimalIssue } from "../linear/schemas.ts";

/* -------------------------------------------------------------------------- */
/* SideEffect variants.                                                       */
/*                                                                            */
/* The reducer cannot run fibers, touch the filesystem, or call services, so  */
/* every observable change beyond the in-memory state record is expressed as  */
/* one of these intents. The fiber owning `OrchestratorRuntimeState` reads    */
/* the `sideEffects` array out of each `reduce(...)` call and dispatches.     */
/* -------------------------------------------------------------------------- */

/**
 * Dispatch fired from inside the reducer is rare — the dispatcher subtask
 * owns candidate selection — but the type lives here so the reducer can
 * emit "please re-evaluate dispatch" after events that free a slot
 * (e.g. `WorkerExited`). The runtime decides what "dispatch" means; this
 * variant only carries enough for log/metric correlation.
 */
export class DispatchWorker extends Data.TaggedClass("DispatchWorker")<{
  readonly issue: Issue;
  readonly attempt: number | null;
}> {}

/**
 * Interrupt a running worker fiber. The runtime maps `issue_id` to the
 * supervisor handle stored alongside the RunningEntry and calls
 * `Fiber.interrupt`.
 */
export class InterruptWorker extends Data.TaggedClass("InterruptWorker")<{
  readonly issue_id: string;
  readonly reason: "stall" | "terminal" | "non_active" | "reconcile";
}> {}

/**
 * Schedule a retry timer. The runtime forks an `Effect.sleep(delay_ms)`
 * fiber, stores the Fiber handle on the RetryEntry, and enqueues a
 * `RetryTimerFired` event when it completes.
 */
export class ScheduleRetry extends Data.TaggedClass("ScheduleRetry")<{
  readonly issue_id: string;
  readonly identifier: string;
  readonly attempt: number;
  readonly delay_ms: number;
  readonly error: string | null;
}> {}

/**
 * Cancel an outstanding retry timer. Emitted by `WorkerStarted` (a freshly
 * started worker supersedes any queued retry) and by reducer paths that
 * release a claim. The runtime calls `Fiber.interrupt` on the stored
 * handle.
 */
export class CancelRetry extends Data.TaggedClass("CancelRetry")<{
  readonly issue_id: string;
}> {}

/**
 * Clean up the per-issue workspace directory (run `before_remove` hook
 * then `rm -rf`). Emitted by reconciliation when an issue moves to a
 * terminal tracker state.
 */
export class CleanupWorkspace extends Data.TaggedClass("CleanupWorkspace")<{
  readonly issue_id: string;
  readonly identifier: string;
}> {}

/**
 * Update the in-memory issue snapshot on a running entry. Emitted by §8.5
 * Part B (tracker state refresh) when a running issue's tracker state is
 * still in the active list — the orchestrator records the latest state
 * name without interrupting the worker.
 */
export class UpdateIssueSnapshot extends Data.TaggedClass(
  "UpdateIssueSnapshot",
)<{
  readonly issue_id: string;
  readonly issue: MinimalIssue;
}> {}

/**
 * Defer a log line to the runtime so the reducer stays pure. `level` maps
 * onto the LoggerService levels; `fields` is the JSONL payload (added to
 * the structured log record verbatim).
 */
export class Log extends Data.TaggedClass("Log")<{
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
}> {}

/**
 * Emit a metric/event to the in-memory ring buffer that backs the §13.7
 * dashboard's recent-events feed. `kind` is a free-form category; payload
 * is opaque JSON.
 */
export class EmitMetric extends Data.TaggedClass("EmitMetric")<{
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
}> {}

/** Discriminated union of every reducer-emitted side effect intent. */
export type SideEffect =
  | DispatchWorker
  | InterruptWorker
  | ScheduleRetry
  | CancelRetry
  | CleanupWorkspace
  | UpdateIssueSnapshot
  | Log
  | EmitMetric;
