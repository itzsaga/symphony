// Translator from the internal OrchestratorRuntimeState into the §13.7 JSON
// shapes, performing the spec-mandated `claude_* → codex_*` boundary rename.
import type { RateLimitInfo } from "../claude/StreamJson.ts";
import type {
  IssueId,
  OrchestratorRuntimeState,
  RetryEntry,
  RunningEntry,
} from "../orchestrator/State.ts";

/* -------------------------------------------------------------------------- */
/* Public API shapes — §13.7.1 / §13.7.2.                                     */
/*                                                                            */
/* IMPORTANT: spec §13.7.1 names the aggregate-totals field `codex_totals`.   */
/* Internally we track `claude_totals` per the TRUST.md divergence — the     */
/* rename happens here at the boundary and is the only reason this module    */
/* exists. Anything beyond `codex_*` field names (timestamps, casing,        */
/* nesting) follows the spec example shape exactly.                          */
/* -------------------------------------------------------------------------- */

/** Token-only sub-shape used inside `running[]` entries. */
export interface ApiTokens {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
}

/** Aggregate totals as exposed externally; field name is spec-mandated. */
export interface ApiCodexTotals {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly seconds_running: number;
}

/** One element of the §13.7.1 `running[]` array. */
export interface ApiRunningEntry {
  readonly issue_id: string;
  readonly issue_identifier: string;
  readonly state: string;
  readonly session_id: string | null;
  readonly turn_count: number;
  readonly last_event: string | null;
  readonly last_message: string | null;
  readonly started_at: string;
  readonly last_event_at: string | null;
  readonly tokens: ApiTokens;
}

/** One element of the §13.7.1 `retrying[]` array. */
export interface ApiRetryEntry {
  readonly issue_id: string;
  readonly issue_identifier: string;
  readonly attempt: number;
  readonly due_at: string;
  readonly error: string | null;
}

/** Full §13.7.1 response shape for `GET /api/v1/state`. */
export interface ApiState {
  readonly generated_at: string;
  readonly counts: {
    readonly running: number;
    readonly retrying: number;
  };
  readonly running: ReadonlyArray<ApiRunningEntry>;
  readonly retrying: ReadonlyArray<ApiRetryEntry>;
  /**
   * Spec §13.7.1 mandates `codex_totals` even for non-Codex implementations.
   * The internal field is `claude_totals`; this is where the rename happens.
   */
  readonly codex_totals: ApiCodexTotals;
  readonly rate_limits: RateLimitInfo | null;
}

/** Suggested `workspace` block in the §13.7.2 per-issue response. */
export interface ApiWorkspace {
  readonly path: string;
}

/** Suggested `attempts` block in the §13.7.2 per-issue response. */
export interface ApiAttempts {
  readonly restart_count: number;
  readonly current_retry_attempt: number;
}

/** `running` block when the issue is currently active. */
export interface ApiRunningView {
  readonly session_id: string | null;
  readonly turn_count: number;
  readonly state: string;
  readonly started_at: string;
  readonly last_event: string | null;
  readonly last_message: string | null;
  readonly last_event_at: string | null;
  readonly tokens: ApiTokens;
}

/** `retry` block when the issue is currently waiting on a retry. */
export interface ApiRetryView {
  readonly attempt: number;
  readonly due_at: string;
  readonly error: string | null;
}

/**
 * `logs` block. v1 does not persist agent session logs to file, so the
 * `codex_session_logs` array is always empty — modeled explicitly here so
 * that the field is present (per the spec example shape) rather than
 * silently absent. Spec §13.7.2 names this field `codex_session_logs`
 * regardless of the agent runner; this is part of the same rename
 * boundary.
 */
export interface ApiLogs {
  readonly codex_session_logs: ReadonlyArray<{
    readonly label: string;
    readonly path: string;
    readonly url: string | null;
  }>;
}

/** One entry of the per-issue `recent_events[]` array. */
export interface ApiRecentEvent {
  readonly at: string;
  readonly event: string;
  readonly message: string | null;
}

/** Full §13.7.2 response shape for `GET /api/v1/<identifier>`. */
export interface ApiIssue {
  readonly issue_identifier: string;
  readonly issue_id: string;
  readonly status: "running" | "retrying" | "unknown";
  readonly workspace: ApiWorkspace | null;
  readonly attempts: ApiAttempts;
  readonly running: ApiRunningView | null;
  readonly retry: ApiRetryView | null;
  readonly logs: ApiLogs;
  readonly recent_events: ReadonlyArray<ApiRecentEvent>;
  readonly last_error: string | null;
  readonly tracked: Readonly<Record<string, never>>;
}

/* -------------------------------------------------------------------------- */
/* Translators.                                                               */
/* -------------------------------------------------------------------------- */

/** ISO-8601 (with milliseconds) — `Date.toISOString` per spec §13.7.1 example. */
const iso = (d: Date): string => d.toISOString();

/** Same as {@link iso} but accepts `null` and propagates it. */
const isoOrNull = (d: Date | null): string | null => (d === null ? null : iso(d));

const toApiTokens = (entry: RunningEntry): ApiTokens => ({
  input_tokens: entry.claude_input_tokens,
  output_tokens: entry.claude_output_tokens,
  total_tokens: entry.claude_total_tokens,
});

const toApiRunningEntry = (entry: RunningEntry): ApiRunningEntry => ({
  issue_id: entry.issue.id,
  issue_identifier: entry.issue.identifier,
  state: entry.issue.state,
  session_id: entry.session_id,
  turn_count: entry.turn_count,
  last_event: entry.last_event,
  last_message: entry.last_message,
  started_at: iso(entry.started_at),
  last_event_at: isoOrNull(entry.last_event_at),
  tokens: toApiTokens(entry),
});

const toApiRetryEntry = (entry: RetryEntry): ApiRetryEntry => ({
  issue_id: entry.issue_id,
  issue_identifier: entry.identifier,
  attempt: entry.attempt,
  due_at: iso(new Date(entry.due_at_ms)),
  error: entry.error,
});

/**
 * Project the full {@link OrchestratorRuntimeState} into the §13.7.1
 * `GET /api/v1/state` response. The `generated_at` timestamp is supplied
 * by the caller so handlers can use a consistent clock instant across
 * the response and any sibling log records.
 *
 * IMPORTANT: this is where the `claude_totals` → `codex_totals` rename
 * happens. The internal field name stays `claude_*` per TRUST.md; only
 * the wire representation uses the spec's `codex_*` literal.
 */
export const toApiState = (
  state: OrchestratorRuntimeState,
  generatedAt: Date,
): ApiState => {
  const running: Array<ApiRunningEntry> = [];
  for (const entry of state.running.values()) {
    running.push(toApiRunningEntry(entry));
  }
  const retrying: Array<ApiRetryEntry> = [];
  for (const entry of state.retry_attempts.values()) {
    retrying.push(toApiRetryEntry(entry));
  }
  return {
    generated_at: iso(generatedAt),
    counts: {
      running: state.running.size,
      retrying: state.retry_attempts.size,
    },
    running,
    retrying,
    codex_totals: {
      input_tokens: state.claude_totals.input_tokens,
      output_tokens: state.claude_totals.output_tokens,
      total_tokens: state.claude_totals.total_tokens,
      seconds_running: state.claude_totals.seconds_running,
    },
    rate_limits: state.claude_rate_limits,
  };
};

/* -------------------------------------------------------------------------- */
/* Per-issue lookup.                                                          */
/*                                                                            */
/* Identifier resolution accepts either the tracker identifier (e.g.          */
/* "MT-649", spec §13.7.2 example) or the raw issue id. The orchestrator      */
/* keys its maps by `issue.id`, so the identifier path requires a linear     */
/* scan; n is bounded by `max_concurrent_agents`, so this is a non-issue at  */
/* v1 scale.                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Look up a running or retrying entry by either issue id or identifier.
 * Returns `null` when the identifier is not in any of the in-memory maps.
 */
export const findByIdentifier = (
  state: OrchestratorRuntimeState,
  identifier: string,
): {
  readonly running: RunningEntry | null;
  readonly retry: RetryEntry | null;
} => {
  // Try id-key first since the dispatcher uses ids and a caller hitting
  // /api/v1/<id> directly is plausible.
  const runById = state.running.get(identifier as IssueId);
  if (runById !== undefined) return { running: runById, retry: null };
  const retryById = state.retry_attempts.get(identifier as IssueId);
  if (retryById !== undefined) return { running: null, retry: retryById };
  for (const entry of state.running.values()) {
    if (entry.issue.identifier === identifier) {
      return { running: entry, retry: null };
    }
  }
  for (const entry of state.retry_attempts.values()) {
    if (entry.identifier === identifier) {
      return { running: null, retry: entry };
    }
  }
  return { running: null, retry: null };
};

const toApiRunningView = (entry: RunningEntry): ApiRunningView => ({
  session_id: entry.session_id,
  turn_count: entry.turn_count,
  state: entry.issue.state,
  started_at: iso(entry.started_at),
  last_event: entry.last_event,
  last_message: entry.last_message,
  last_event_at: isoOrNull(entry.last_event_at),
  tokens: toApiTokens(entry),
});

const toApiRetryView = (entry: RetryEntry): ApiRetryView => ({
  attempt: entry.attempt,
  due_at: iso(new Date(entry.due_at_ms)),
  error: entry.error,
});

/**
 * Build a §13.7.2 per-issue response from the entry pair returned by
 * {@link findByIdentifier} plus the `recent_events` already filtered out
 * of the Logger ring buffer (cap of 50 enforced by the caller).
 *
 * `workspace`, `running`, and `retry` are nullable: an issue can be in
 * exactly one of {running, retrying, neither} at any moment. The
 * `tracked` placeholder is the empty object per the spec example.
 */
export const toApiIssue = (params: {
  readonly issue_identifier: string;
  readonly running: RunningEntry | null;
  readonly retry: RetryEntry | null;
  readonly recent_events: ReadonlyArray<ApiRecentEvent>;
}): ApiIssue => {
  const status: "running" | "retrying" =
    params.running !== null ? "running" : "retrying";
  // Surface the canonical issue id: prefer the running entry, fall back
  // to the retry entry.
  const issue_id =
    params.running !== null
      ? params.running.issue.id
      : params.retry !== null
        ? params.retry.issue_id
        : params.issue_identifier;
  const workspace: ApiWorkspace | null =
    params.running !== null ? { path: params.running.workspace_path } : null;
  const attempts: ApiAttempts = {
    // §13.7.2 example splits restart vs. retry. v1 tracks only the retry
    // attempt; restart_count stays 0 as a placeholder until §18.2's
    // persistence work lands.
    restart_count: 0,
    current_retry_attempt:
      params.running?.retry_attempt ?? params.retry?.attempt ?? 0,
  };
  return {
    issue_identifier: params.issue_identifier,
    issue_id,
    status,
    workspace,
    attempts,
    running: params.running !== null ? toApiRunningView(params.running) : null,
    retry: params.retry !== null ? toApiRetryView(params.retry) : null,
    logs: { codex_session_logs: [] },
    recent_events: params.recent_events,
    last_error: params.retry?.error ?? null,
    tracked: {},
  };
};
