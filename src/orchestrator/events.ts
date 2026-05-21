// OrchestratorEvent: the tagged union of every input that drives the orchestrator's
// reducer. One variant per spec §7.3 transition trigger plus the few non-§7.3 events.
import { Data } from "effect";
import type { Issue } from "../linear/schemas.ts";
import type { WorkflowDefinition } from "../config/WorkflowSchema.ts";
import type { RuntimeEvent } from "../claude/EventMapping.ts";
import type { RunningEntry } from "./State.ts";

/* -------------------------------------------------------------------------- */
/* OrchestratorEvent variants.                                                */
/*                                                                            */
/* Each variant is a `Data.TaggedClass`. The reducer in `State.ts` matches on */
/* `_tag` via `Match.tagsExhaustive` so adding a new variant without a        */
/* handler is a compile error.                                                */
/* -------------------------------------------------------------------------- */

/**
 * Spec §7.3 `Poll Tick` — the orchestrator's periodic kick. The reducer
 * itself only records that a tick happened (no side-effect emitted from
 * here); the surrounding dispatch/reconcile fibers fan out from this event
 * via separate paths.
 */
export class PollTick extends Data.TaggedClass("PollTick")<{
  readonly at: Date;
}> {}

/**
 * A worker fiber has been spawned and is now claiming an issue. The
 * dispatcher passes both the normalized Issue snapshot and the
 * already-constructed RunningEntry so the reducer can simply install it
 * into `running`/`claimed` without re-deriving state.
 */
export class WorkerStarted extends Data.TaggedClass("WorkerStarted")<{
  readonly issue: Issue;
  readonly runningEntry: RunningEntry;
}> {}

/**
 * A §10.4 RuntimeEvent observed inside one worker's session. Carries the
 * issue id so the reducer can look up which RunningEntry to update.
 */
export class WorkerEventReceived extends Data.TaggedClass(
  "WorkerEventReceived",
)<{
  readonly issue_id: string;
  readonly event: RuntimeEvent;
}> {}

/**
 * Spec §7.3 `Worker Exit (normal|abnormal)` — the worker fiber has
 * terminated. `reason` distinguishes a clean exit (continuation retry) from
 * a failure (exponential-backoff retry).
 */
export class WorkerExited extends Data.TaggedClass("WorkerExited")<{
  readonly issue_id: string;
  readonly reason: "normal" | "abnormal";
  readonly error: string | null;
  readonly at: Date;
}> {}

/**
 * Spec §7.3 `Retry Timer Fired`. The reducer removes the retry entry; the
 * caller fetches state by ID and decides whether to re-dispatch.
 */
export class RetryTimerFired extends Data.TaggedClass("RetryTimerFired")<{
  readonly issue_id: string;
  readonly attempt: number;
}> {}

/**
 * Spec §7.3 `Stall Timeout`. The reconcile fiber observed `elapsed_ms >
 * stall_timeout_ms` for one running issue and is asking the reducer to
 * schedule the kill + retry.
 */
export class StallDetected extends Data.TaggedClass("StallDetected")<{
  readonly issue_id: string;
  readonly at: Date;
}> {}

/**
 * WorkflowLoader observed a change to WORKFLOW.md. The reducer updates the
 * effective `poll_interval_ms` / `max_concurrent_agents` (§6.2) but does
 * NOT touch any running workers — the spec allows but does not require
 * in-flight restarts.
 */
export class WorkflowReloaded extends Data.TaggedClass("WorkflowReloaded")<{
  readonly definition: WorkflowDefinition;
}> {}

/**
 * §13.7 HTTP `POST /api/v1/refresh` — the operator asked the orchestrator
 * to run a tick immediately. The reducer treats this exactly like a
 * `PollTick` for state purposes; surrounding fibers know to short-circuit
 * the sleep timer.
 */
export class ImmediateTickRequested extends Data.TaggedClass(
  "ImmediateTickRequested",
)<{
  readonly at: Date;
}> {}

/** Discriminated union of every orchestrator input event. */
export type OrchestratorEvent =
  | PollTick
  | WorkerStarted
  | WorkerEventReceived
  | WorkerExited
  | RetryTimerFired
  | StallDetected
  | WorkflowReloaded
  | ImmediateTickRequested;
