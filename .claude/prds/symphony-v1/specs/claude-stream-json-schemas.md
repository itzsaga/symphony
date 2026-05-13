# Stream-json frame schemas

## Objective

Define `@effect/schema` schemas for every frame the `claude` CLI emits and accepts in stream-json mode. The schemas are the single source of truth for what's on the wire and what the rest of the codebase pattern-matches against. Authoritative reference: `research/claude-stream-json.md` §2.

## Context

### Parent PRD

- **PRD**: Symphony v1 (Effect.ts + Claude Code)
- **PRD Path**: `.claude/prds/symphony-v1/PRD.md`

### Related Tasks

- **Depends on**: Bun + TypeScript + Effect setup.
- **Blocks**: claude-subprocess-lifecycle.md, claude-control-protocol.md, claude-event-mapping.md, mcp-server-and-linear-graphql.md.

## Acceptance Criteria

- [ ] One discriminated-union schema `StreamJsonMessage` covering, on the `type` field:
  - `"user"` — `UserMessage`
  - `"assistant"` — `AssistantMessage`
  - `"system"` — `SystemMessage` (with sub-discrimination on `subtype`: `"init" | "task_started" | "task_progress" | "task_notification" | "hook_started" | "hook_response" | "mirror_error" | "session_state_changed" | "api_retry" | "plugin_install"` plus a fallback `string` for forward-compat).
  - `"result"` — `ResultMessage` (with `subtype: "success" | "error_max_turns" | "error_during_execution" | "error_max_budget_usd" | string`).
  - `"stream_event"` — `StreamEvent` (carries opaque `event: unknown` for the Anthropic API SSE event).
  - `"rate_limit_event"` — `RateLimitEvent`.
  - `"control_request"` — `ControlRequest` (sub-discrimination on `request.subtype`: `"can_use_tool" | "mcp_message" | "initialize" | string`).
  - `"control_response"` — `ControlResponse`.
  - `"control_cancel_request"` — `ControlCancelRequest`.
  - `"transcript_mirror"` — opaque; filtered at parse layer.
- [ ] Each schema's field set matches `research/claude-stream-json.md` §2.a–§2.g exactly. Optional fields are modeled with `Schema.optional`.
- [ ] `system.init` schema explicitly types `plugins` (array of `{ name: string; path: string }`) and `plugin_errors` (array of `{ plugin: string; type: string; message: string }`) — both optional. The headless docs page is explicit that `plugin_errors` is omitted entirely when there are no errors, so the decoder MUST treat absent-key as "no errors" (not as a decode failure).
- [ ] `system.api_retry` schema fields: `attempt: number`, `max_retries: number`, `retry_delay_ms: number`, `error_status: number | null`, `error: string` (one of `"authentication_failed" | "oauth_org_not_allowed" | "billing_error" | "rate_limit" | "invalid_request" | "server_error" | "max_output_tokens" | "unknown"` — model as `Schema.String` to stay forward-compatible), `uuid: string`, `session_id: string`.
- [ ] `system.plugin_install` schema fields: `status: "started" | "installed" | "failed" | "completed"`, optional `name`, optional `error`, `uuid`, `session_id`. (Symphony does not set `CLAUDE_CODE_SYNC_PLUGIN_INSTALL`, so this is purely defensive — verify the decoder doesn't reject it.)
- [ ] Forward-compat: an `Unknown` variant catches any `type` not in the union; the parser logs at debug level and drops the frame without failing the stream (matches `message_parser.py:314-318`).
- [ ] Content-block schemas for inside `AssistantMessage.message.content` and `UserMessage.message.content` (discriminated union on `type`): `"text"`, `"thinking"`, `"tool_use"`, `"tool_result"`, `"server_tool_use"`, `"advisor_tool_result"`.
- [ ] Wire-format camelCase preservation: `rate_limit_event.rate_limit_info.resetsAt` / `.rateLimitType` are camelCase on the wire — the schema MUST decode these correctly. Our internal types use snake_case; the schema does the rename.
- [ ] Outbound (Symphony → Claude) frame schemas: `OutboundUserMessage`, `OutboundControlResponse`, `OutboundControlCancelRequest`. These are the only frame types Symphony writes to stdin.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `src/claude/StreamJson.ts` | Create | All schemas + the parse helpers + branded `SessionId` type. |
| `src/claude/StreamJson.test.ts` | Create | Per-frame-type decode tests with verbatim JSON examples from `research/claude-stream-json.md`. |

### Technical Constraints

- Schemas are co-located in one file unless that file exceeds ~700 lines; if so, split by concern (`MessageSchemas.ts`, `ControlSchemas.ts`).
- Each schema MUST round-trip: decode-then-encode produces equivalent JSON.
- Don't model what we don't use. Spec-listed but unused fields (e.g. `transcript_mirror`) can be schema'd as `Schema.Struct({}, { exact: false })` — accepts but exposes nothing.
- Branded types: `SessionId`, `TurnId` (synthetic), `MessageUuid`, `ToolUseId`, `RequestId`.

### Relevant Code References

- `research/claude-stream-json.md` §2 (every frame type and field), §2.a–§2.g (per-type schemas).

### Code Examples

```ts
// Sketch
const Usage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
  cache_creation_input_tokens: Schema.optional(Schema.Number),
  cache_read_input_tokens: Schema.optional(Schema.Number),
}, { exact: false })

const ResultMessage = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.String, // "success" | "error_max_turns" | …
  duration_ms: Schema.Number,
  duration_api_ms: Schema.Number,
  is_error: Schema.Boolean,
  num_turns: Schema.Number,
  session_id: Schema.String,
  stop_reason: Schema.optional(Schema.String),
  total_cost_usd: Schema.optional(Schema.Number),
  usage: Schema.optional(Usage),
  result: Schema.optional(Schema.String),
  modelUsage: Schema.optional(Schema.Record(Schema.String, Usage)),
  errors: Schema.optional(Schema.Array(Schema.String)),
  // …
})

const StreamJsonMessage = Schema.Union(
  UserMessage, AssistantMessage, SystemMessage,
  ResultMessage, StreamEvent, RateLimitEvent,
  ControlRequest, ControlResponse, ControlCancelRequest,
  TranscriptMirror,
)
```

## Testing Requirements

- [ ] Decode-test for every frame type using a verbatim JSON example from `research/claude-stream-json.md`.
- [ ] Decode-test for the forward-compat path: an unknown `type` decodes to the `Unknown` variant without throwing.
- [ ] Decode-test for the camelCase-renamed `rate_limit_info` fields.
- [ ] `ResultMessage` with an unknown subtype string decodes successfully (subtype is a `Schema.String`, not a closed union).
- [ ] `system.init` decodes both with `plugin_errors` present (non-empty array) and absent (key omitted).
- [ ] `system.api_retry` round-trips for every documented `error` value.
- [ ] `system.plugin_install` decodes without erroring (we won't emit one, but Anthropic might).
- [ ] Round-trip: `Schema.encode(decoded)` produces equivalent JSON for outbound message types.

## Out of Scope

- Decoding the opaque `stream_event.event` payload (the Anthropic API SSE structure). Symphony passes it through.
- Validating MCP-tool-call inner structure here — that's done by mcp-server-and-linear-graphql.md.
- The parser layer that handles partial JSON across lines. That's claude-subprocess-lifecycle.md.
