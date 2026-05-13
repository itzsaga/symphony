# Event mapping and token accounting

## Objective

Transform parsed `StreamJsonMessage` frames into the spec's §10.4 emitted-event taxonomy and track running token totals per §13.5. This is the boundary between the Claude-specific subprocess layer and the spec-agnostic orchestrator. Reference: `research/claude-stream-json.md` §3 (mapping table) and §5 (token accounting).

## Context

### Parent PRD

- **PRD**: Symphony v1 (Effect.ts + Claude Code)
- **PRD Path**: `.claude/prds/symphony-v1/PRD.md`

### Related Tasks

- **Depends on**: claude-subprocess-lifecycle.md, claude-stream-json-schemas.md, claude-control-protocol.md, logger-service.md.
- **Blocks**: orchestrator-state.md (consumes the mapped events).

## Acceptance Criteria

- [ ] `EventMapping` module (pure functions, no Effect service needed) exposes:
  - `mapFrame(frame: StreamJsonMessage, sessionState: ClaudeSessionState): { events: ReadonlyArray<RuntimeEvent>; newState: ClaudeSessionState }`
  - `synthesizeSessionId(threadId: string, turnId: number): string` — produces `<threadId>-<turnId>`.
- [ ] `RuntimeEvent` is a tagged union covering at least the spec §10.4 set:
  - `SessionStarted` — from `system.init`. Carries `session_id`, `model`, `codex_app_server_pid` (called `claude_pid` here but kept in the orchestrator's `running` entry under the spec field name for §13.7 API compatibility). Also carries `plugins` and `plugin_errors` from the init payload — empty under `--bare`, populated with whatever's in `~/.claude` when not. The orchestrator surfaces non-empty `plugin_errors` as warn logs in either mode.
  - `StartupFailed` — pre-stream error, or first `result` with `is_error:true` before any `init`.
  - `TurnCompleted` — from `result` with `subtype:"success"`. Carries duration, usage, num_turns, total_cost_usd.
  - `TurnFailed` — from `result` with `is_error:true` and a non-cancel subtype.
  - `TurnCancelled` — synthesized when `control_cancel_request` was sent for this turn.
  - `TurnEndedWithError` — assistant.error present, run continued.
  - `TurnInputRequired` — from a `can_use_tool` request (ControlProtocol injects this via a side channel; see below).
  - `ApprovalAutoApproved` — synthesized on every `tool_use` content block while `bypassPermissions` is in effect.
  - `UnsupportedToolCall` — `tool_use` block whose tool isn't in the advertised set + `tool_result.is_error=true` correlated.
  - `Notification` — `system.task_notification` or informational `stream_event`s.
  - `ApiRetrying` — from `system.api_retry`. Carries `attempt`, `max_retries`, `retry_delay_ms`, `error`, `error_status`. **Important:** this is the CLI's *internal* retry; the orchestrator MUST NOT treat it as a turn failure — Claude is still alive and will retry on its own. Surface to the dashboard's recent-events feed only.
  - `OtherMessage` — unknown/unmapped frames (forward-compat).
  - `Malformed` — failure to decode.
  - Plus the useful-non-§10.4 events from `research/claude-stream-json.md` §3 (TextDelta, ToolCallStarted, ToolCallCompleted, RateLimit, ProcessExited, UsageReport).
- [ ] Token accounting (§13.5):
  - Prefer `result.usage` (turn aggregate) and `result.modelUsage` (per-model). Track deltas vs `last_reported_*_tokens` to avoid double-counting.
  - For per-assistant-message usage in `assistant.message.usage`, NOT treated as cumulative (per `research/claude-stream-json.md` §5).
  - Maintain `claude_input_tokens`, `claude_output_tokens`, `claude_total_tokens` plus `last_reported_*` mirrors on the session state. Spec field names use `codex_*` prefix; we use `claude_*` internally and rename at the §13.7 HTTP boundary for spec compatibility.
- [ ] Session/turn ID synthesis:
  - `thread_id = system.init.session_id`.
  - `turn_id = result.num_turns` (latest seen).
  - Emit `session_id = "<thread_id>-<turn_id>"` per spec §4.2 and §10.2.
- [ ] Rate-limit tracking: store the latest `rate_limit_event` payload on the session state, expose via the orchestrator's snapshot for §13.7.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `src/claude/EventMapping.ts` | Create | Pure mapping functions + RuntimeEvent union. |
| `src/claude/sessionState.ts` | Create | The reduced state record (`ClaudeSessionState`). |

### Technical Constraints

- The mapping is pure. Stateful concerns (which `can_use_tool` requests were sent, which were cancelled) are passed in via `ClaudeSessionState`.
- The pipeline that *uses* this mapping is in the orchestrator: `subprocess.incoming → mapFrame → orchestrator.dispatch`.
- `TurnInputRequired` event source: `ControlProtocol`'s `can_use_tool` handler emits this via a `Queue` injected into `ControlHandlers`; the orchestrator merges it with the main runtime-event stream. The mapping module exposes a constructor for the event but doesn't itself observe control requests (they're not in the conversation stream).
- Spec-compat at the HTTP boundary: the §13.7 API uses `codex_*` field names for tokens and `last_codex_event`/`last_codex_timestamp` for the live-session record. We translate at the snapshot layer (http-api-and-dashboard.md), not here.

### Relevant Code References

- `research/claude-stream-json.md` §3 (mapping table), §5 (token accounting), §4 (session IDs).
- Spec §10.4 (emitted events), §10.5 (approval handling), §13.5 (token accounting rules), §4.1.6 (Live Session fields), §4.1.8 (Orchestrator state).

### Code Examples

```ts
type ClaudeSessionState = {
  readonly thread_id: string | null
  readonly latest_turn_id: number | null
  readonly claude_pid: number | null
  readonly last_event: string | null
  readonly last_event_at: Date | null
  readonly last_message: string | null
  readonly claude_input_tokens: number
  readonly claude_output_tokens: number
  readonly claude_total_tokens: number
  readonly last_reported_input_tokens: number
  readonly last_reported_output_tokens: number
  readonly last_reported_total_tokens: number
  readonly turn_count: number
  readonly latest_rate_limit: RateLimitInfo | null
  readonly model: string | null
}
```

## Testing Requirements

- [ ] `system.init` → `SessionStarted` with `session_id`, `model`, `plugins`, `plugin_errors` extracted.
- [ ] `system.init` with non-empty `plugin_errors` → `SessionStarted` AND a warn log entry per error.
- [ ] `result.subtype="success"` → `TurnCompleted` with `num_turns`, `total_cost_usd`, `duration_ms`.
- [ ] `result.is_error=true, subtype="error_max_turns"` → `TurnFailed`.
- [ ] `assistant.error="rate_limit"` → `TurnEndedWithError`.
- [ ] `system.api_retry` → `ApiRetrying` event; running entry NOT marked as failed; `last_event`/`last_event_at` updated for dashboard visibility.
- [ ] Token deltas: two consecutive `result` frames with `usage.input_tokens` 100 then 250 produce only +250 increment to `claude_input_tokens` (replace, not add — absolute totals); but `last_reported_input_tokens` tracks correctly.
- [ ] `rate_limit_event` updates `latest_rate_limit`.
- [ ] Unmapped frame → `OtherMessage` event.

## Out of Scope

- Pretty-formatted "humanized" event summaries (§13.6 — OPTIONAL).
- Persistence of session state across restarts.
- A separate metrics service (Prometheus, OTLP). Future work.
