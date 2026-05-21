// Pure reconciliation helpers per spec §8.5 + §16.3. Splits stall detection
// (Part A) from tracker state refresh (Part B); the tick fiber wires them up.
import type { TypedConfig } from "../config/WorkflowSchema.ts";
import type { MinimalIssue } from "../linear/schemas.ts";
import { StallDetected, type OrchestratorEvent } from "./events.ts";
import {
  CleanupWorkspace,
  InterruptWorker,
  ScheduleRetry,
  UpdateIssueSnapshot,
  type SideEffect,
} from "./sideEffects.ts";
import type { OrchestratorRuntimeState, RunningEntry } from "./State.ts";

/* -------------------------------------------------------------------------- */
/* Result shape.                                                              */
/*                                                                            */
/* The spec sketches `reconcileStalled` / `reconcileTrackerStates` as         */
/* returning `ReadonlyArray<SideEffect>`, but Part A is required to emit a    */
/* `StallDetected` *event* alongside its side effects so the reducer can      */
/* keep its single-authority bookkeeping in sync. Returning both fields       */
/* keeps callers honest without sneaking events through the SideEffect type.  */
/* -------------------------------------------------------------------------- */

export interface ReconcileResult {
  /** OrchestratorEvents the tick fiber must push back into the dispatch queue. */
  readonly events: ReadonlyArray<OrchestratorEvent>;
  /** SideEffect intents the runtime interprets (interrupt fibers, schedule timers, etc.). */
  readonly sideEffects: ReadonlyArray<SideEffect>;
}

const EMPTY_RESULT: ReconcileResult = { events: [], sideEffects: [] };

/* -------------------------------------------------------------------------- */
/* Retry backoff math — mirrors State.ts so this module stays standalone.     */
/*                                                                            */
/* Kept in lockstep with the reducer's `computeFailureBackoffMs`. If those    */
/* constants change, update both call sites (or expose the helper from        */
/* State.ts and import it). Duplication is deliberate: Reconcile.ts is pure   */
/* and has no Effect dependency, so we avoid pulling in the reducer module's  */
/* Effect-heavy imports just to share one tiny helper.                        */
/* -------------------------------------------------------------------------- */

const FAILURE_RETRY_BASE_MS = 10_000;
const MAX_RETRY_BACKOFF_MS = 300_000;

const computeStallBackoffMs = (attempt: number): number => {
  const exponent = Math.max(0, attempt - 1);
  const raw = FAILURE_RETRY_BASE_MS * Math.pow(2, exponent);
  return Math.min(raw, MAX_RETRY_BACKOFF_MS);
};

/* -------------------------------------------------------------------------- */
/* Part A — Stall detection.                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Walk the running entries and emit a `StallDetected` event plus
 * `InterruptWorker` + `ScheduleRetry` side effects for any whose
 * last-observed activity exceeds `agent_runner.stall_timeout_ms`.
 *
 * Stall detection is disabled when `stall_timeout_ms <= 0` per spec §5.3.5
 * and §8.5: in that case this function is a no-op.
 *
 * `now` is taken as a parameter rather than read from `new Date()` so unit
 * tests can pin time and exercise the boundary case deterministically.
 */
export const reconcileStalled = (
  state: OrchestratorRuntimeState,
  config: TypedConfig,
  now: Date,
): ReconcileResult => {
  const timeoutMs = config.agent_runner.stall_timeout_ms;
  if (timeoutMs <= 0) {
    return EMPTY_RESULT;
  }

  const events: Array<OrchestratorEvent> = [];
  const sideEffects: Array<SideEffect> = [];
  const nowMs = now.getTime();

  for (const [issueId, entry] of state.running) {
    const referenceMs = (entry.last_event_at ?? entry.started_at).getTime();
    const elapsedMs = nowMs - referenceMs;
    if (elapsedMs <= timeoutMs) continue;

    // §7.3 Stall Timeout: bookkeeping retry attempt counter — abnormal exit
    // semantics, so `retry_attempt + 1` (or 1 on the first stall).
    const priorRetryAttempt = entry.retry_attempt ?? 0;
    const nextAttempt = priorRetryAttempt + 1;
    const delayMs = computeStallBackoffMs(nextAttempt);

    events.push(new StallDetected({ issue_id: issueId, at: now }));
    sideEffects.push(
      new InterruptWorker({ issue_id: issueId, reason: "stall" }),
      new ScheduleRetry({
        issue_id: issueId,
        identifier: entry.issue.identifier,
        attempt: nextAttempt,
        delay_ms: delayMs,
        error: "stall_timeout",
      }),
    );
  }

  return { events, sideEffects };
};

/* -------------------------------------------------------------------------- */
/* Part B — Tracker state refresh.                                            */
/* -------------------------------------------------------------------------- */

/**
 * Classify each refreshed `MinimalIssue` against the configured
 * active/terminal state sets and emit the matching side-effect intents.
 *
 * Per §8.5 Part B:
 * - terminal state → `InterruptWorker` + `CleanupWorkspace`
 * - still active → `UpdateIssueSnapshot` (no interrupt)
 * - neither → `InterruptWorker` without `CleanupWorkspace`
 *
 * State-name comparison is normalized via `.toLowerCase()` per spec §4.2.
 * Both `terminal_states` and `active_states` MUST be passed in
 * lowercased — callers (`TypedConfig` consumers) own that normalization
 * step so this helper stays O(1) per lookup.
 *
 * If `refreshed` omits an issue that is currently running (i.e. tracker
 * fetch came back without it), this function does NOT touch its entry.
 * The next poll tick's candidate-fetch pass decides whether to drop the
 * issue from `running` or not — per the spec, the Linear API doesn't
 * distinguish "deleted" from "API hiccup" for us.
 */
export const reconcileTrackerStates = (
  state: OrchestratorRuntimeState,
  refreshed: ReadonlyArray<MinimalIssue>,
  terminal_states: ReadonlySet<string>,
  active_states: ReadonlySet<string>,
): ReconcileResult => {
  const sideEffects: Array<SideEffect> = [];

  for (const refreshedIssue of refreshed) {
    const entry: RunningEntry | undefined = state.running.get(refreshedIssue.id);
    if (entry === undefined) continue;

    const stateName = refreshedIssue.state.toLowerCase();

    if (terminal_states.has(stateName)) {
      sideEffects.push(
        new InterruptWorker({
          issue_id: refreshedIssue.id,
          reason: "terminal",
        }),
        new CleanupWorkspace({
          issue_id: refreshedIssue.id,
          identifier: entry.issue.identifier,
        }),
      );
      continue;
    }

    if (active_states.has(stateName)) {
      sideEffects.push(
        new UpdateIssueSnapshot({
          issue_id: refreshedIssue.id,
          issue: refreshedIssue,
        }),
      );
      continue;
    }

    sideEffects.push(
      new InterruptWorker({
        issue_id: refreshedIssue.id,
        reason: "non_active",
      }),
    );
  }

  return { events: [], sideEffects };
};
