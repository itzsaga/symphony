// ClaudeSessionState: the reduced per-session record consumed by the orchestrator.
// Pure data; the EventMapping reducer derives a new value from each StreamJsonMessage frame.
import type { RateLimitInfo } from "./StreamJson.ts";

/**
 * Reduced state for one Claude `claude` subprocess session. Spec §4.1.6
 * (Live Session fields) and §4.1.8 (Orchestrator state). The HTTP §13.7
 * boundary renames `claude_*` → `codex_*` for spec compatibility, but
 * internally we keep the program-specific name.
 *
 * `last_reported_*_tokens` mirror the most recent values surfaced upstream
 * (e.g. on the dashboard). The reducer in EventMapping does **not** touch
 * those fields — the orchestrator owns the flush-then-update step so it
 * can compute deltas vs. what it last reported. The reducer simply keeps
 * the absolute totals fresh from each `result.usage`.
 */
export interface ClaudeSessionState {
  /** `system.init.session_id` — the stable Claude session UUID. Symphony's `thread_id`. */
  readonly thread_id: string | null;
  /** Latest `result.num_turns` seen this session. Symphony's `turn_id`. */
  readonly latest_turn_id: number | null;
  /** PID of the spawned `claude` CLI process. Set by the subprocess layer; the
   *  reducer does not modify it — kept here so the snapshot has a single
   *  source of truth for §13.7's `codex_app_server_pid` field. */
  readonly claude_pid: number | null;
  /** Most recent event tag seen (e.g. `"TurnCompleted"`). Used by the dashboard. */
  readonly last_event: string | null;
  /** Wall-clock time the latest event was observed. */
  readonly last_event_at: Date | null;
  /** Most recent assistant text-block content (truncated/stored verbatim). */
  readonly last_message: string | null;
  /** Absolute input-token total from the latest `result.usage` (replace, not add). */
  readonly claude_input_tokens: number;
  /** Absolute output-token total from the latest `result.usage`. */
  readonly claude_output_tokens: number;
  /** Absolute total-token total derived from the latest `result.usage`
   *  (input + output + cache_creation_input + cache_read_input when present). */
  readonly claude_total_tokens: number;
  /** Mirror of the input-token count last surfaced upstream. The reducer does not
   *  touch this; the orchestrator updates it after reporting deltas. */
  readonly last_reported_input_tokens: number;
  /** Mirror of the output-token count last surfaced upstream. */
  readonly last_reported_output_tokens: number;
  /** Mirror of the total-token count last surfaced upstream. */
  readonly last_reported_total_tokens: number;
  /** Count of `result` frames observed (== completed-or-failed turns). */
  readonly turn_count: number;
  /** Most recent `rate_limit_event.rate_limit_info` payload, if any. */
  readonly latest_rate_limit: RateLimitInfo | null;
  /** Model id observed on `system.init` (or, as a fallback, the latest `assistant.message.model`). */
  readonly model: string | null;
}

/** Initial state for a freshly-spawned session — every field zero/null. */
export const initialClaudeSessionState: ClaudeSessionState = {
  thread_id: null,
  latest_turn_id: null,
  claude_pid: null,
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
  latest_rate_limit: null,
  model: null,
};
