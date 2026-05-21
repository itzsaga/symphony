// OrchestratorRuntimeState + pure reducer. The reducer is total over
// OrchestratorEvent and emits SideEffect intents the runtime fiber interprets.
import { Fiber, Match } from "effect";
import type { Issue, MinimalIssue } from "../linear/schemas.ts";
import type { TypedConfig } from "../config/WorkflowSchema.ts";
import type { RateLimitInfo } from "../claude/StreamJson.ts";
import type { RuntimeEvent } from "../claude/EventMapping.ts";
import type {
  ImmediateTickRequested,
  OrchestratorEvent,
  PollTick,
  RetryTimerFired,
  StallDetected,
  WorkerEventReceived,
  WorkerExited,
  WorkerStarted,
  WorkflowReloaded,
} from "./events.ts";
import {
  CancelRetry,
  EmitMetric,
  InterruptWorker,
  Log,
  ScheduleRetry,
  type SideEffect,
} from "./sideEffects.ts";
import {
  CONTINUATION_RETRY_DELAY_MS,
  DEFAULT_MAX_RETRY_BACKOFF_MS,
  computeFailureBackoffMs,
} from "./Retry.ts";

/* -------------------------------------------------------------------------- */
/* Domain types — spec §4.1.5 / §4.1.6 / §4.1.7 / §4.1.8.                     */
/* -------------------------------------------------------------------------- */

/** Type alias for issue id used as map keys. */
export type IssueId = string;

/**
 * Aggregate token + runtime totals carried on `OrchestratorRuntimeState`.
 * Spec §4.1.8's `codex_totals`, renamed to `claude_totals` per the v1
 * divergence in TRUST.md. The HTTP §13.7 boundary renames on the way out.
 */
export interface ClaudeTotals {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly seconds_running: number;
}

/**
 * One running worker's snapshot, fused from spec §4.1.5 (Run Attempt) and
 * §4.1.6 (Live Session). The reducer owns this struct; the surrounding
 * dispatch fiber constructs the initial instance and the reducer applies
 * incremental updates as `WorkerEventReceived` events arrive.
 */
export interface RunningEntry {
  /* §4.1.5 Run Attempt fields. */
  readonly issue: Issue;
  readonly workspace_path: string;
  readonly started_at: Date;
  /** `null` on the first attempt; `>=1` on retries/continuations. */
  readonly attempt: number | null;
  readonly retry_attempt: number | null;

  /* §4.1.6 Live Session fields (subset relevant to the reducer). */
  readonly session_id: string | null;
  readonly thread_id: string | null;
  readonly last_event: string | null;
  readonly last_event_at: Date | null;
  readonly last_message: string | null;

  /** Absolute counters fed by `result.usage` via {@link RuntimeEvent}s. */
  readonly claude_input_tokens: number;
  readonly claude_output_tokens: number;
  readonly claude_total_tokens: number;
  /** Mirror of the last value surfaced to the operator (delta accounting). */
  readonly last_reported_input_tokens: number;
  readonly last_reported_output_tokens: number;
  readonly last_reported_total_tokens: number;

  /** Per-§4.1.6 turn counter — incremented on every `result` frame. */
  readonly turn_count: number;
}

/**
 * Spec §4.1.7 RetryEntry. The reducer never reads or writes `timer_handle`
 * directly — the runtime fiber that interprets `ScheduleRetry` /
 * `CancelRetry` populates it. The reducer simply records its presence so
 * the public state shape is complete.
 */
export interface RetryEntry {
  readonly issue_id: IssueId;
  readonly identifier: string;
  readonly attempt: number;
  readonly due_at_ms: number;
  /**
   * Runtime-owned timer handle. Modeled as `Fiber.Fiber<void>` per spec
   * §8.4 "Cancel any existing retry timer for the same issue" implemented
   * as `Fiber.interrupt`. Optional because the reducer constructs the
   * RetryEntry before the runtime forks the timer.
   */
  readonly timer_handle: Fiber.Fiber<void, never> | null;
  readonly error: string | null;
}

/**
 * Single authoritative orchestrator state. Spec §4.1.8 field-for-field
 * with the `codex_*` → `claude_*` rename declared in TRUST.md.
 */
export interface OrchestratorRuntimeState {
  readonly poll_interval_ms: number;
  readonly max_concurrent_agents: number;
  readonly running: ReadonlyMap<IssueId, RunningEntry>;
  readonly claimed: ReadonlySet<IssueId>;
  readonly retry_attempts: ReadonlyMap<IssueId, RetryEntry>;
  readonly completed: ReadonlySet<IssueId>;
  readonly claude_totals: ClaudeTotals;
  readonly claude_rate_limits: RateLimitInfo | null;
}

/* -------------------------------------------------------------------------- */
/* Initial state factory.                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Build the empty initial state from the current effective TypedConfig.
 * `max_concurrent_agents` is read from `agent_runner.max_concurrent_agents`
 * (spec §5.3.5; default 10 via the WorkflowSchema). `DEFAULT_MAX_CONCURRENT_AGENTS`
 * is kept as a fallback constant for callers that need to reason about the
 * spec default without a TypedConfig handy (e.g. unit tests).
 */
export const DEFAULT_MAX_CONCURRENT_AGENTS = 10;

export const initialState = (
  config: TypedConfig,
): OrchestratorRuntimeState => ({
  poll_interval_ms: config.polling.interval_ms,
  max_concurrent_agents: config.agent_runner.max_concurrent_agents,
  running: new Map(),
  claimed: new Set(),
  retry_attempts: new Map(),
  completed: new Set(),
  claude_totals: {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    seconds_running: 0,
  },
  claude_rate_limits: null,
});

/* -------------------------------------------------------------------------- */
/* Reducer output shape.                                                      */
/* -------------------------------------------------------------------------- */

/** Output of {@link reduce}: the new state plus any side effects to interpret. */
export interface ReduceResult {
  readonly state: OrchestratorRuntimeState;
  readonly sideEffects: ReadonlyArray<SideEffect>;
}

/* -------------------------------------------------------------------------- */
/* Retry constants (§8.4) — re-exported from Retry.ts.                        */
/*                                                                            */
/* Re-exports keep the existing import surface (`State.ts` was the historical */
/* home for these) while the canonical definitions live in `Retry.ts`, which */
/* is the module both the reducer (`onWorkerExited`) and the reconciler      */
/* (`reconcileStalled`) now share.                                           */
/* -------------------------------------------------------------------------- */

export { CONTINUATION_RETRY_DELAY_MS, DEFAULT_MAX_RETRY_BACKOFF_MS };

/* -------------------------------------------------------------------------- */
/* Small helpers for immutable Map/Set updates.                                */
/*                                                                            */
/* v1 scale is ~10 concurrent issues; `Map`/`Set` clone-on-write is fine and  */
/* keeps the reducer dependency-free.                                         */
/* -------------------------------------------------------------------------- */

const mapSet = <K, V>(m: ReadonlyMap<K, V>, k: K, v: V): ReadonlyMap<K, V> => {
  const next = new Map(m);
  next.set(k, v);
  return next;
};

const mapDelete = <K, V>(m: ReadonlyMap<K, V>, k: K): ReadonlyMap<K, V> => {
  if (!m.has(k)) return m;
  const next = new Map(m);
  next.delete(k);
  return next;
};

const setAdd = <T>(s: ReadonlySet<T>, v: T): ReadonlySet<T> => {
  if (s.has(v)) return s;
  const next = new Set(s);
  next.add(v);
  return next;
};

const setDelete = <T>(s: ReadonlySet<T>, v: T): ReadonlySet<T> => {
  if (!s.has(v)) return s;
  const next = new Set(s);
  next.delete(v);
  return next;
};

/* -------------------------------------------------------------------------- */
/* RuntimeEvent → RunningEntry projection.                                    */
/*                                                                            */
/* Spec §13.5 token-accounting and §4.1.6 live-session field updates flow     */
/* through this function. It is total over RuntimeEvent (every variant is     */
/* handled) and only touches the per-issue snapshot; aggregate totals on      */
/* OrchestratorRuntimeState are updated separately by the caller.             */
/* -------------------------------------------------------------------------- */

interface PerIssueDelta {
  readonly entry: RunningEntry;
  readonly inputDelta: number;
  readonly outputDelta: number;
  readonly totalDelta: number;
  readonly rateLimit: RateLimitInfo | null;
}

const applyRuntimeEvent = (
  entry: RunningEntry,
  event: RuntimeEvent,
): PerIssueDelta => {
  // Default carry-over: most events only update `last_event` + timestamps.
  const base = (next: Partial<RunningEntry>): RunningEntry => ({
    ...entry,
    last_event: event._tag,
    last_event_at: new Date(),
    ...next,
  });

  switch (event._tag) {
    case "SessionStarted": {
      const entryNext = base({
        thread_id: event.session_id ?? entry.thread_id,
      });
      return zeroDelta(entryNext);
    }
    case "TurnCompleted":
    case "TurnFailed": {
      const entryNext = base({
        session_id: event.session_id,
        thread_id: event.thread_id,
        turn_count: entry.turn_count + 1,
      });
      return zeroDelta(entryNext);
    }
    case "UsageReport": {
      // §13.5: prefer absolute totals; compute deltas against last_reported_*.
      const input = event.usage.input_tokens ?? entry.claude_input_tokens;
      const output = event.usage.output_tokens ?? entry.claude_output_tokens;
      const total =
        (event.usage.input_tokens ?? 0) +
        (event.usage.output_tokens ?? 0) +
        (event.usage.cache_creation_input_tokens ?? 0) +
        (event.usage.cache_read_input_tokens ?? 0);
      const inputDelta = Math.max(0, input - entry.last_reported_input_tokens);
      const outputDelta = Math.max(
        0,
        output - entry.last_reported_output_tokens,
      );
      const totalDelta = Math.max(0, total - entry.last_reported_total_tokens);
      const entryNext: RunningEntry = {
        ...entry,
        last_event: event._tag,
        last_event_at: new Date(),
        claude_input_tokens: input,
        claude_output_tokens: output,
        claude_total_tokens: total,
        last_reported_input_tokens: input,
        last_reported_output_tokens: output,
        last_reported_total_tokens: total,
      };
      return {
        entry: entryNext,
        inputDelta,
        outputDelta,
        totalDelta,
        rateLimit: null,
      };
    }
    case "RateLimit": {
      const entryNext = base({});
      return {
        entry: entryNext,
        inputDelta: 0,
        outputDelta: 0,
        totalDelta: 0,
        rateLimit: event.info,
      };
    }
    case "TextDelta": {
      // Mirror the last text fragment onto last_message for the dashboard,
      // matching ClaudeSessionState's behavior in EventMapping.ts.
      const entryNext = base({ last_message: event.text });
      return zeroDelta(entryNext);
    }
    case "ProcessExited":
    case "TurnCancelled":
    case "TurnEndedWithError":
    case "TurnInputRequired":
    case "StartupFailed":
    case "Malformed":
    case "ApprovalAutoApproved":
    case "ApiRetrying":
    case "ToolCallStarted":
    case "ToolCallCompleted":
    case "UnsupportedToolCall":
    case "Notification":
    case "OtherMessage":
      return zeroDelta(base({}));
  }
};

const zeroDelta = (entry: RunningEntry): PerIssueDelta => ({
  entry,
  inputDelta: 0,
  outputDelta: 0,
  totalDelta: 0,
  rateLimit: null,
});

/* -------------------------------------------------------------------------- */
/* Per-OrchestratorEvent handlers.                                            */
/* -------------------------------------------------------------------------- */

const onPollTick = (
  state: OrchestratorRuntimeState,
  _event: PollTick,
): ReduceResult => ({ state, sideEffects: [] });

const onImmediateTickRequested = (
  state: OrchestratorRuntimeState,
  _event: ImmediateTickRequested,
): ReduceResult => ({
  state,
  sideEffects: [
    new Log({
      level: "info",
      message: "immediate tick requested",
      fields: {},
    }),
  ],
});

const onWorkerStarted = (
  state: OrchestratorRuntimeState,
  event: WorkerStarted,
): ReduceResult => {
  const issueId = event.issue.id;
  const running = mapSet(state.running, issueId, event.runningEntry);
  const claimed = setAdd(state.claimed, issueId);
  // A freshly-started worker supersedes any queued retry — §8.4: "Cancel
  // any existing retry timer for the same issue".
  const hadRetry = state.retry_attempts.has(issueId);
  const retryAttempts = hadRetry
    ? mapDelete(state.retry_attempts, issueId)
    : state.retry_attempts;
  const sideEffects: Array<SideEffect> = [];
  if (hadRetry) {
    sideEffects.push(new CancelRetry({ issue_id: issueId }));
  }
  sideEffects.push(
    new Log({
      level: "info",
      message: "worker started",
      fields: {
        issue_id: issueId,
        identifier: event.issue.identifier,
        attempt: event.runningEntry.attempt,
      },
    }),
  );
  return {
    state: {
      ...state,
      running,
      claimed,
      retry_attempts: retryAttempts,
    },
    sideEffects,
  };
};

const onWorkerEventReceived = (
  state: OrchestratorRuntimeState,
  event: WorkerEventReceived,
): ReduceResult => {
  const entry = state.running.get(event.issue_id);
  if (entry === undefined) {
    // The worker's run-loop fiber outlived its `running` entry, or the event
    // races with a reconciliation interrupt. Surface as a notice and
    // otherwise drop — the reducer is not the right place to recover.
    return {
      state,
      sideEffects: [
        new Log({
          level: "warn",
          message: "WorkerEventReceived for unknown issue_id",
          fields: { issue_id: event.issue_id, tag: event.event._tag },
        }),
      ],
    };
  }
  const delta = applyRuntimeEvent(entry, event.event);
  const running = mapSet(state.running, event.issue_id, delta.entry);
  const claude_totals: ClaudeTotals = {
    input_tokens: state.claude_totals.input_tokens + delta.inputDelta,
    output_tokens: state.claude_totals.output_tokens + delta.outputDelta,
    total_tokens: state.claude_totals.total_tokens + delta.totalDelta,
    seconds_running: state.claude_totals.seconds_running,
  };
  const claude_rate_limits =
    delta.rateLimit !== null ? delta.rateLimit : state.claude_rate_limits;
  return {
    state: { ...state, running, claude_totals, claude_rate_limits },
    sideEffects: [],
  };
};

const onWorkerExited = (
  state: OrchestratorRuntimeState,
  event: WorkerExited,
): ReduceResult => {
  const entry = state.running.get(event.issue_id);
  if (entry === undefined) {
    // No running record — likely already cleaned up by a prior reconcile.
    // Still release any lingering claim so the issue can be re-dispatched.
    const claimed = setDelete(state.claimed, event.issue_id);
    return {
      state: { ...state, claimed },
      sideEffects: [
        new Log({
          level: "warn",
          message: "WorkerExited for unknown issue_id",
          fields: { issue_id: event.issue_id, reason: event.reason },
        }),
      ],
    };
  }
  const running = mapDelete(state.running, event.issue_id);
  // §13.5: "Add run duration seconds to the cumulative ended-session runtime
  // when a session ends".
  const elapsedSeconds = Math.max(
    0,
    Math.floor((event.at.getTime() - entry.started_at.getTime()) / 1_000),
  );
  const claude_totals: ClaudeTotals = {
    ...state.claude_totals,
    seconds_running: state.claude_totals.seconds_running + elapsedSeconds,
  };

  // Schedule a retry per §7.3 / §8.4. The retry attempt counter is 1 on
  // every normal exit (continuation retries always restart at attempt 1)
  // and increments on abnormal exits.
  const priorRetryAttempt = entry.retry_attempt ?? 0;
  const nextAttempt =
    event.reason === "normal" ? 1 : priorRetryAttempt + 1;
  const delayMs =
    event.reason === "normal"
      ? CONTINUATION_RETRY_DELAY_MS
      : computeFailureBackoffMs(nextAttempt, DEFAULT_MAX_RETRY_BACKOFF_MS);
  const due_at_ms = event.at.getTime() + delayMs;
  const retryEntry: RetryEntry = {
    issue_id: event.issue_id,
    identifier: entry.issue.identifier,
    attempt: nextAttempt,
    due_at_ms,
    timer_handle: null,
    error: event.error,
  };
  const retry_attempts = mapSet(state.retry_attempts, event.issue_id, retryEntry);

  // Normal exits also flip the `completed` flag — bookkeeping only per
  // spec §4.1.8 ("not dispatch gating").
  const completed =
    event.reason === "normal"
      ? setAdd(state.completed, event.issue_id)
      : state.completed;

  const sideEffects: Array<SideEffect> = [
    new ScheduleRetry({
      issue_id: event.issue_id,
      identifier: entry.issue.identifier,
      attempt: nextAttempt,
      delay_ms: delayMs,
      error: event.error,
    }),
    new Log({
      level: event.reason === "normal" ? "info" : "warn",
      message: `worker exited (${event.reason})`,
      fields: {
        issue_id: event.issue_id,
        identifier: entry.issue.identifier,
        reason: event.reason,
        error: event.error,
        attempt: nextAttempt,
        delay_ms: delayMs,
      },
    }),
    new EmitMetric({
      kind: "worker_exit",
      payload: {
        issue_id: event.issue_id,
        identifier: entry.issue.identifier,
        reason: event.reason,
        seconds_elapsed: elapsedSeconds,
      },
    }),
  ];

  return {
    state: {
      ...state,
      running,
      claude_totals,
      retry_attempts,
      completed,
    },
    sideEffects,
  };
};

const onRetryTimerFired = (
  state: OrchestratorRuntimeState,
  event: RetryTimerFired,
): ReduceResult => {
  const had = state.retry_attempts.has(event.issue_id);
  const retry_attempts = had
    ? mapDelete(state.retry_attempts, event.issue_id)
    : state.retry_attempts;
  return {
    state: { ...state, retry_attempts },
    sideEffects: had
      ? [
          new Log({
            level: "info",
            message: "retry timer fired",
            fields: {
              issue_id: event.issue_id,
              attempt: event.attempt,
            },
          }),
        ]
      : [],
  };
};

const onStallDetected = (
  state: OrchestratorRuntimeState,
  event: StallDetected,
): ReduceResult => {
  const entry = state.running.get(event.issue_id);
  if (entry === undefined) {
    return {
      state,
      sideEffects: [
        new Log({
          level: "warn",
          message: "StallDetected for unknown issue_id",
          fields: { issue_id: event.issue_id },
        }),
      ],
    };
  }
  // §7.3 `Stall Timeout` / §8.5 Part A: "terminate the worker and queue a
  // retry." The retry itself is scheduled when the worker fiber emits its
  // resulting `WorkerExited` event; the reducer's job here is to interrupt
  // and log.
  return {
    state,
    sideEffects: [
      new InterruptWorker({ issue_id: event.issue_id, reason: "stall" }),
      new Log({
        level: "warn",
        message: "stall detected",
        fields: {
          issue_id: event.issue_id,
          identifier: entry.issue.identifier,
        },
      }),
    ],
  };
};

const onWorkflowReloaded = (
  state: OrchestratorRuntimeState,
  event: WorkflowReloaded,
): ReduceResult => {
  // §6.2: re-apply polling cadence and concurrency limits. Do NOT touch
  // `running` — "Implementations are not REQUIRED to restart in-flight
  // agent sessions automatically when config changes."
  const next: OrchestratorRuntimeState = {
    ...state,
    poll_interval_ms: event.definition.config.polling.interval_ms,
    max_concurrent_agents:
      event.definition.config.agent_runner.max_concurrent_agents,
  };
  return {
    state: next,
    sideEffects: [
      new Log({
        level: "info",
        message: "workflow reloaded",
        fields: {
          poll_interval_ms: next.poll_interval_ms,
          max_concurrent_agents: next.max_concurrent_agents,
        },
      }),
    ],
  };
};

/* -------------------------------------------------------------------------- */
/* Public reducer.                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Pure reducer over {@link OrchestratorEvent}. Total: every variant has a
 * handler. Unhandled variants are a compile error via
 * `Match.tagsExhaustive`.
 */
export const reduce = (
  state: OrchestratorRuntimeState,
  event: OrchestratorEvent,
): ReduceResult =>
  Match.value(event).pipe(
    Match.tagsExhaustive({
      PollTick: (e) => onPollTick(state, e),
      WorkerStarted: (e) => onWorkerStarted(state, e),
      WorkerEventReceived: (e) => onWorkerEventReceived(state, e),
      WorkerExited: (e) => onWorkerExited(state, e),
      RetryTimerFired: (e) => onRetryTimerFired(state, e),
      StallDetected: (e) => onStallDetected(state, e),
      WorkflowReloaded: (e) => onWorkflowReloaded(state, e),
      ImmediateTickRequested: (e) => onImmediateTickRequested(state, e),
    }),
  );

/* -------------------------------------------------------------------------- */
/* Smart constructors for callers that just want an initial RunningEntry      */
/* before the first RuntimeEvent has arrived.                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build an empty RunningEntry for an Issue/workspace pair. Callers (the
 * dispatcher subtask) pass this into `new WorkerStarted({ issue, runningEntry })`.
 */
export const newRunningEntry = (params: {
  readonly issue: Issue;
  readonly workspace_path: string;
  readonly started_at: Date;
  readonly attempt: number | null;
  readonly retry_attempt: number | null;
}): RunningEntry => ({
  issue: params.issue,
  workspace_path: params.workspace_path,
  started_at: params.started_at,
  attempt: params.attempt,
  retry_attempt: params.retry_attempt,
  session_id: null,
  thread_id: null,
  last_event: null,
  last_event_at: null,
  last_message: null,
  claude_input_tokens: 0,
  claude_output_tokens: 0,
  claude_total_tokens: 0,
  last_reported_input_tokens: 0,
  last_reported_output_tokens: 0,
  last_reported_total_tokens: 0,
  turn_count: 0,
});

/* Re-exports kept for ergonomic consumption by the dispatch/reconcile/retry
 * subtasks: callers can `import { ... } from "./State.ts"` for the entire
 * orchestrator-state surface area. */
export type { MinimalIssue };
