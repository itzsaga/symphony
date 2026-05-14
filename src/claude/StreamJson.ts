// Effect Schemas for every frame emitted/accepted by the Claude Code CLI in
// stream-json mode. Authoritative reference: research/claude-stream-json.md §2.
import { Schema } from "effect";

/* -------------------------------------------------------------------------- */
/* Branded identifier types.                                                  */
/* -------------------------------------------------------------------------- */

/** Stable Claude session id (UUID) — appears on nearly every frame. */
export const SessionId = Schema.String.pipe(Schema.brand("SessionId"));
export type SessionId = Schema.Schema.Type<typeof SessionId>;

/**
 * Synthetic per-turn id Symphony composes from `result.num_turns`. Not present
 * on the wire — defined here so callers compose `${session_id}-${turn_id}`
 * with brand-checked types instead of bare numbers.
 */
export const TurnId = Schema.Number.pipe(Schema.brand("TurnId"));
export type TurnId = Schema.Schema.Type<typeof TurnId>;

/** Per-message UUID stamped on assistant/user/system/result/stream_event. */
export const MessageUuid = Schema.String.pipe(Schema.brand("MessageUuid"));
export type MessageUuid = Schema.Schema.Type<typeof MessageUuid>;

/** Anthropic-API style `toolu_…` id for tool_use / tool_result correlation. */
export const ToolUseId = Schema.String.pipe(Schema.brand("ToolUseId"));
export type ToolUseId = Schema.Schema.Type<typeof ToolUseId>;

/** Control-protocol request id (`req_<counter>_<hex>`). */
export const RequestId = Schema.String.pipe(Schema.brand("RequestId"));
export type RequestId = Schema.Schema.Type<typeof RequestId>;

/* -------------------------------------------------------------------------- */
/* Shared building blocks.                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Anthropic Messages API `usage` block. The full field set is API-determined
 * and grows across model versions; we accept everything via index signature
 * but spell out the fields we read so consumers get inference.
 */
export const Usage = Schema.Struct(
  {
    input_tokens: Schema.optional(Schema.Number),
    output_tokens: Schema.optional(Schema.Number),
    cache_creation_input_tokens: Schema.optional(Schema.Number),
    cache_read_input_tokens: Schema.optional(Schema.Number),
    service_tier: Schema.optional(Schema.String),
    server_tool_use: Schema.optional(
      Schema.Struct(
        {},
        { key: Schema.String, value: Schema.Unknown },
      ),
    ),
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type Usage = Schema.Schema.Type<typeof Usage>;

/* -------------------------------------------------------------------------- */
/* Content blocks — discriminated on `type`. Used inside both                 */
/* AssistantMessage.message.content and UserMessage.message.content.          */
/* -------------------------------------------------------------------------- */

export const TextBlock = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});
export type TextBlock = Schema.Schema.Type<typeof TextBlock>;

export const ThinkingBlock = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  signature: Schema.optional(Schema.String),
});
export type ThinkingBlock = Schema.Schema.Type<typeof ThinkingBlock>;

export const ToolUseBlock = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
});
export type ToolUseBlock = Schema.Schema.Type<typeof ToolUseBlock>;

/**
 * `tool_result.content` is either a string (typical) or a structured
 * Anthropic API content list. We model it as `unknown` to stay forward-
 * compatible with whatever the CLI passes through.
 */
export const ToolResultBlock = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Schema.String,
  content: Schema.optional(Schema.Unknown),
  is_error: Schema.optional(Schema.Boolean),
});
export type ToolResultBlock = Schema.Schema.Type<typeof ToolResultBlock>;

export const ServerToolUseBlock = Schema.Struct({
  type: Schema.Literal("server_tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
});
export type ServerToolUseBlock = Schema.Schema.Type<typeof ServerToolUseBlock>;

export const AdvisorToolResultBlock = Schema.Struct({
  type: Schema.Literal("advisor_tool_result"),
  tool_use_id: Schema.String,
  content: Schema.optional(Schema.Unknown),
  is_error: Schema.optional(Schema.Boolean),
});
export type AdvisorToolResultBlock = Schema.Schema.Type<
  typeof AdvisorToolResultBlock
>;

/** Discriminated union of every content block type the CLI emits. */
export const ContentBlock = Schema.Union(
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
  ServerToolUseBlock,
  AdvisorToolResultBlock,
);
export type ContentBlock = Schema.Schema.Type<typeof ContentBlock>;

/* -------------------------------------------------------------------------- */
/* AssistantMessage.                                                          */
/* -------------------------------------------------------------------------- */

/** Mid-turn assistant errors per types.py:1003-1010. Forward-compat: string. */
export const AssistantMessageError = Schema.String;
export type AssistantMessageError = Schema.Schema.Type<
  typeof AssistantMessageError
>;

/**
 * Inner Anthropic Messages API response payload carried by an assistant frame.
 * `model` is REQUIRED per message_parser.py:126-186; everything else optional.
 */
export const AssistantInnerMessage = Schema.Struct(
  {
    id: Schema.optional(Schema.String),
    model: Schema.String,
    role: Schema.optional(Schema.Literal("assistant")),
    stop_reason: Schema.optional(Schema.NullOr(Schema.String)),
    stop_sequence: Schema.optional(Schema.NullOr(Schema.String)),
    usage: Schema.optional(Usage),
    content: Schema.Array(ContentBlock),
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type AssistantInnerMessage = Schema.Schema.Type<
  typeof AssistantInnerMessage
>;

export const AssistantMessage = Schema.Struct({
  type: Schema.Literal("assistant"),
  uuid: Schema.optional(Schema.String),
  session_id: Schema.optional(Schema.String),
  parent_tool_use_id: Schema.optional(Schema.NullOr(Schema.String)),
  error: Schema.optional(Schema.NullOr(AssistantMessageError)),
  message: AssistantInnerMessage,
});
export type AssistantMessage = Schema.Schema.Type<typeof AssistantMessage>;

/* -------------------------------------------------------------------------- */
/* UserMessage.                                                               */
/* -------------------------------------------------------------------------- */

/**
 * User-message content is either a plain string (typical) or an Anthropic-API
 * style array of content blocks. The CLI emits the array form when injecting
 * synthetic tool-result-bearing user turns; the host writes the string form
 * for prompt input.
 */
export const UserContent = Schema.Union(
  Schema.String,
  Schema.Array(ContentBlock),
);
export type UserContent = Schema.Schema.Type<typeof UserContent>;

export const UserInnerMessage = Schema.Struct(
  {
    role: Schema.optional(Schema.Literal("user")),
    content: UserContent,
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type UserInnerMessage = Schema.Schema.Type<typeof UserInnerMessage>;

export const UserMessage = Schema.Struct({
  type: Schema.Literal("user"),
  uuid: Schema.optional(Schema.String),
  session_id: Schema.optional(Schema.String),
  parent_tool_use_id: Schema.optional(Schema.NullOr(Schema.String)),
  tool_use_result: Schema.optional(Schema.Unknown),
  message: UserInnerMessage,
});
export type UserMessage = Schema.Schema.Type<typeof UserMessage>;

/* -------------------------------------------------------------------------- */
/* SystemMessage — sub-discriminated on `subtype`.                            */
/* -------------------------------------------------------------------------- */

/** Plugin descriptor inside system.init.plugins. */
export const InitPlugin = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
});
export type InitPlugin = Schema.Schema.Type<typeof InitPlugin>;

/** Plugin load-error descriptor inside system.init.plugin_errors. */
export const InitPluginError = Schema.Struct({
  plugin: Schema.String,
  type: Schema.String,
  message: Schema.String,
});
export type InitPluginError = Schema.Schema.Type<typeof InitPluginError>;

/**
 * `system` / `init` — emitted once at session start. `plugin_errors` is
 * absent when there are no errors (per the headless docs page); the schema
 * accepts both absent and present forms via `Schema.optional`.
 *
 * Other init fields (cwd, tools, mcp_servers, apiKeySource, permissionMode)
 * are accepted but untyped via the index signature, since the source has not
 * pinned them down — runtime verification is needed.
 */
export const SystemInitMessage = Schema.Struct(
  {
    type: Schema.Literal("system"),
    subtype: Schema.Literal("init"),
    model: Schema.optional(Schema.String),
    session_id: Schema.optional(Schema.String),
    uuid: Schema.optional(Schema.String),
    plugins: Schema.optional(Schema.Array(InitPlugin)),
    plugin_errors: Schema.optional(Schema.Array(InitPluginError)),
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type SystemInitMessage = Schema.Schema.Type<typeof SystemInitMessage>;

/** Task-tool usage block carried by task_progress / task_notification. */
export const TaskUsage = Schema.Struct(
  {
    total_tokens: Schema.optional(Schema.Number),
    tool_uses: Schema.optional(Schema.Number),
    duration_ms: Schema.optional(Schema.Number),
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type TaskUsage = Schema.Schema.Type<typeof TaskUsage>;

export const SystemTaskStartedMessage = Schema.Struct(
  {
    type: Schema.Literal("system"),
    subtype: Schema.Literal("task_started"),
    task_id: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    session_id: Schema.optional(Schema.String),
    uuid: Schema.optional(Schema.String),
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type SystemTaskStartedMessage = Schema.Schema.Type<
  typeof SystemTaskStartedMessage
>;

export const SystemTaskProgressMessage = Schema.Struct(
  {
    type: Schema.Literal("system"),
    subtype: Schema.Literal("task_progress"),
    task_id: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    usage: Schema.optional(TaskUsage),
    session_id: Schema.optional(Schema.String),
    uuid: Schema.optional(Schema.String),
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type SystemTaskProgressMessage = Schema.Schema.Type<
  typeof SystemTaskProgressMessage
>;

export const SystemTaskNotificationMessage = Schema.Struct(
  {
    type: Schema.Literal("system"),
    subtype: Schema.Literal("task_notification"),
    task_id: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    status: Schema.optional(Schema.String),
    usage: Schema.optional(TaskUsage),
    session_id: Schema.optional(Schema.String),
    uuid: Schema.optional(Schema.String),
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type SystemTaskNotificationMessage = Schema.Schema.Type<
  typeof SystemTaskNotificationMessage
>;

export const SystemHookStartedMessage = Schema.Struct(
  {
    type: Schema.Literal("system"),
    subtype: Schema.Literal("hook_started"),
    hook_event: Schema.optional(Schema.String),
    hook_event_name: Schema.optional(Schema.String),
    hook_name: Schema.optional(Schema.String),
    session_id: Schema.optional(Schema.String),
    uuid: Schema.optional(Schema.String),
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type SystemHookStartedMessage = Schema.Schema.Type<
  typeof SystemHookStartedMessage
>;

export const SystemHookResponseMessage = Schema.Struct(
  {
    type: Schema.Literal("system"),
    subtype: Schema.Literal("hook_response"),
    hook_event: Schema.optional(Schema.String),
    hook_event_name: Schema.optional(Schema.String),
    hook_name: Schema.optional(Schema.String),
    output: Schema.optional(Schema.Unknown),
    exit_code: Schema.optional(Schema.Number),
    outcome: Schema.optional(Schema.String),
    session_id: Schema.optional(Schema.String),
    uuid: Schema.optional(Schema.String),
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type SystemHookResponseMessage = Schema.Schema.Type<
  typeof SystemHookResponseMessage
>;

/** SDK-synthesized when an external SessionStore.append fails. */
export const SystemMirrorErrorMessage = Schema.Struct(
  {
    type: Schema.Literal("system"),
    subtype: Schema.Literal("mirror_error"),
    error: Schema.optional(Schema.String),
    session_id: Schema.optional(Schema.String),
    uuid: Schema.optional(Schema.String),
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type SystemMirrorErrorMessage = Schema.Schema.Type<
  typeof SystemMirrorErrorMessage
>;

/** Post-turn marker emitted after `result` per query.py:312-314. */
export const SystemSessionStateChangedMessage = Schema.Struct(
  {
    type: Schema.Literal("system"),
    subtype: Schema.Literal("session_state_changed"),
    session_id: Schema.optional(Schema.String),
    uuid: Schema.optional(Schema.String),
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type SystemSessionStateChangedMessage = Schema.Schema.Type<
  typeof SystemSessionStateChangedMessage
>;

/**
 * `system` / `api_retry` — emitted before the CLI retries a failing API call.
 * `error` is modeled as `Schema.String` (not a closed union) for forward-
 * compat; the documented values are listed in research/claude-stream-json.md
 * §2.g and exercised by the unit tests.
 */
export const SystemApiRetryMessage = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("api_retry"),
  attempt: Schema.Number,
  max_retries: Schema.Number,
  retry_delay_ms: Schema.Number,
  error_status: Schema.NullOr(Schema.Number),
  error: Schema.String,
  uuid: Schema.String,
  session_id: Schema.String,
});
export type SystemApiRetryMessage = Schema.Schema.Type<
  typeof SystemApiRetryMessage
>;

/**
 * `system` / `plugin_install` — only emitted when CLAUDE_CODE_SYNC_PLUGIN_INSTALL
 * is set (Symphony does not). `status` is a closed literal union per the
 * headless docs page.
 */
export const SystemPluginInstallMessage = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("plugin_install"),
  status: Schema.Literal("started", "installed", "failed", "completed"),
  name: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  uuid: Schema.String,
  session_id: Schema.String,
});
export type SystemPluginInstallMessage = Schema.Schema.Type<
  typeof SystemPluginInstallMessage
>;

/**
 * Catch-all `system` frame for forward-compat: any subtype not matched by
 * the variants above (CHANGELOG references autocompact/compact subtypes
 * whose payloads aren't documented yet, plus any future additions).
 */
export const SystemUnknownMessage = Schema.Struct(
  {
    type: Schema.Literal("system"),
    subtype: Schema.String,
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type SystemUnknownMessage = Schema.Schema.Type<
  typeof SystemUnknownMessage
>;

/** Discriminated union of every `system` subtype + the catch-all. */
export const SystemMessage = Schema.Union(
  SystemInitMessage,
  SystemTaskStartedMessage,
  SystemTaskProgressMessage,
  SystemTaskNotificationMessage,
  SystemHookStartedMessage,
  SystemHookResponseMessage,
  SystemMirrorErrorMessage,
  SystemSessionStateChangedMessage,
  SystemApiRetryMessage,
  SystemPluginInstallMessage,
  SystemUnknownMessage,
);
export type SystemMessage = Schema.Schema.Type<typeof SystemMessage>;

/* -------------------------------------------------------------------------- */
/* ResultMessage.                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `result` — per-turn terminator. `subtype` is `Schema.String` (not a closed
 * union) per the spec: documented values include `"success"`,
 * `"error_max_turns"`, `"error_during_execution"`, `"error_max_budget_usd"`,
 * but the full enumeration is unknown so we accept any string for forward-
 * compat.
 */
export const ResultMessage = Schema.Struct(
  {
    type: Schema.Literal("result"),
    subtype: Schema.String,
    duration_ms: Schema.Number,
    duration_api_ms: Schema.Number,
    is_error: Schema.Boolean,
    num_turns: Schema.Number,
    session_id: Schema.String,
    stop_reason: Schema.optional(Schema.NullOr(Schema.String)),
    total_cost_usd: Schema.optional(Schema.NullOr(Schema.Number)),
    usage: Schema.optional(Usage),
    result: Schema.optional(Schema.String),
    structured_output: Schema.optional(Schema.Unknown),
    modelUsage: Schema.optional(
      Schema.Record({ key: Schema.String, value: Usage }),
    ),
    permission_denials: Schema.optional(Schema.Array(Schema.Unknown)),
    deferred_tool_use: Schema.optional(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        input: Schema.Unknown,
      }),
    ),
    errors: Schema.optional(Schema.Array(Schema.String)),
    api_error_status: Schema.optional(Schema.NullOr(Schema.Number)),
    uuid: Schema.optional(Schema.String),
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type ResultMessage = Schema.Schema.Type<typeof ResultMessage>;

/* -------------------------------------------------------------------------- */
/* StreamEvent — opaque pass-through for Anthropic API SSE events.            */
/* -------------------------------------------------------------------------- */

export const StreamEvent = Schema.Struct(
  {
    type: Schema.Literal("stream_event"),
    uuid: Schema.String,
    session_id: Schema.String,
    parent_tool_use_id: Schema.optional(Schema.NullOr(Schema.String)),
    event: Schema.Unknown,
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type StreamEvent = Schema.Schema.Type<typeof StreamEvent>;

/* -------------------------------------------------------------------------- */
/* RateLimitEvent — wire fields are camelCase; we rename to snake_case.       */
/* -------------------------------------------------------------------------- */

/**
 * Inner `rate_limit_info` payload. The wire format is camelCase
 * (`resetsAt`, `rateLimitType`, `overageStatus`, `overageResetsAt`,
 * `overageDisabledReason`) but we present a snake_case shape internally to
 * match the rest of the codebase. `Schema.fromKey` performs the rename
 * during decode and reverses it during encode.
 */
export const RateLimitInfo = Schema.Struct({
  status: Schema.String,
  resets_at: Schema.optional(Schema.Number).pipe(Schema.fromKey("resetsAt")),
  rate_limit_type: Schema.optional(Schema.String).pipe(
    Schema.fromKey("rateLimitType"),
  ),
  utilization: Schema.optional(Schema.Number),
  overage_status: Schema.optional(Schema.String).pipe(
    Schema.fromKey("overageStatus"),
  ),
  overage_resets_at: Schema.optional(Schema.Number).pipe(
    Schema.fromKey("overageResetsAt"),
  ),
  overage_disabled_reason: Schema.optional(Schema.String).pipe(
    Schema.fromKey("overageDisabledReason"),
  ),
});
export type RateLimitInfo = Schema.Schema.Type<typeof RateLimitInfo>;

export const RateLimitEvent = Schema.Struct({
  type: Schema.Literal("rate_limit_event"),
  uuid: Schema.String,
  session_id: Schema.String,
  rate_limit_info: RateLimitInfo,
});
export type RateLimitEvent = Schema.Schema.Type<typeof RateLimitEvent>;

/* -------------------------------------------------------------------------- */
/* Control protocol — request / response / cancel.                            */
/* -------------------------------------------------------------------------- */

/** `request.subtype = "can_use_tool"` — the CLI asking the host to approve. */
export const CanUseToolRequest = Schema.Struct(
  {
    subtype: Schema.Literal("can_use_tool"),
    tool_name: Schema.String,
    input: Schema.Unknown,
    tool_use_id: Schema.optional(Schema.String),
    agent_id: Schema.optional(Schema.String),
    permission_suggestions: Schema.optional(Schema.Array(Schema.Unknown)),
    blocked_path: Schema.optional(Schema.String),
    decision_reason: Schema.optional(Schema.String),
    title: Schema.optional(Schema.String),
    display_name: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type CanUseToolRequest = Schema.Schema.Type<typeof CanUseToolRequest>;

/** `request.subtype = "mcp_message"` — opaque MCP JSON-RPC envelope. */
export const McpMessageRequest = Schema.Struct(
  {
    subtype: Schema.Literal("mcp_message"),
    server_name: Schema.optional(Schema.String),
    message: Schema.Unknown,
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type McpMessageRequest = Schema.Schema.Type<typeof McpMessageRequest>;

/** `request.subtype = "initialize"` — sent by host to the CLI at startup. */
export const InitializeRequest = Schema.Struct(
  {
    subtype: Schema.Literal("initialize"),
    hooks: Schema.optional(Schema.Unknown),
    mcp_servers: Schema.optional(Schema.Unknown),
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type InitializeRequest = Schema.Schema.Type<typeof InitializeRequest>;

/** Catch-all for any `request.subtype` not in the closed list above. */
export const UnknownControlRequestBody = Schema.Struct(
  {
    subtype: Schema.String,
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type UnknownControlRequestBody = Schema.Schema.Type<
  typeof UnknownControlRequestBody
>;

/** Discriminated union of every known inner control_request body. */
export const ControlRequestBody = Schema.Union(
  CanUseToolRequest,
  McpMessageRequest,
  InitializeRequest,
  UnknownControlRequestBody,
);
export type ControlRequestBody = Schema.Schema.Type<typeof ControlRequestBody>;

export const ControlRequest = Schema.Struct(
  {
    type: Schema.Literal("control_request"),
    request_id: Schema.String,
    request: ControlRequestBody,
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type ControlRequest = Schema.Schema.Type<typeof ControlRequest>;

/** Success body of a control_response (`response.subtype = "success"`). */
export const ControlResponseSuccessBody = Schema.Struct(
  {
    subtype: Schema.Literal("success"),
    request_id: Schema.String,
    response: Schema.optional(Schema.Unknown),
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type ControlResponseSuccessBody = Schema.Schema.Type<
  typeof ControlResponseSuccessBody
>;

/** Error body of a control_response (`response.subtype = "error"`). */
export const ControlResponseErrorBody = Schema.Struct(
  {
    subtype: Schema.Literal("error"),
    request_id: Schema.String,
    error: Schema.String,
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type ControlResponseErrorBody = Schema.Schema.Type<
  typeof ControlResponseErrorBody
>;

export const ControlResponseBody = Schema.Union(
  ControlResponseSuccessBody,
  ControlResponseErrorBody,
);
export type ControlResponseBody = Schema.Schema.Type<
  typeof ControlResponseBody
>;

export const ControlResponse = Schema.Struct(
  {
    type: Schema.Literal("control_response"),
    response: ControlResponseBody,
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type ControlResponse = Schema.Schema.Type<typeof ControlResponse>;

export const ControlCancelRequest = Schema.Struct(
  {
    type: Schema.Literal("control_cancel_request"),
    request_id: Schema.String,
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type ControlCancelRequest = Schema.Schema.Type<
  typeof ControlCancelRequest
>;

/* -------------------------------------------------------------------------- */
/* TranscriptMirror — opaque, filtered at the parser layer when no            */
/* SessionStore is attached. We don't model the body.                         */
/* -------------------------------------------------------------------------- */

export const TranscriptMirror = Schema.Struct(
  {
    type: Schema.Literal("transcript_mirror"),
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type TranscriptMirror = Schema.Schema.Type<typeof TranscriptMirror>;

/* -------------------------------------------------------------------------- */
/* Forward-compat catch-all and the top-level discriminated union.            */
/* -------------------------------------------------------------------------- */

/**
 * Any frame whose `type` doesn't match one of the known variants. The parser
 * layer logs at debug level and drops the frame without failing the stream
 * (matches Python SDK message_parser.py:314-318). Modeling it as a struct
 * with only `type: string` keeps the rest of the payload available via the
 * index signature for diagnostics.
 */
export const UnknownFrame = Schema.Struct(
  {
    type: Schema.String,
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type UnknownFrame = Schema.Schema.Type<typeof UnknownFrame>;

/**
 * Top-level discriminated union: every known variant first, with
 * `UnknownFrame` last so it only matches when no known variant does.
 *
 * Effect Schema's union decoder tries members in order and picks the first
 * that succeeds; the known variants discriminate on `type` literals so they
 * fail fast on a mismatched type, leaving the catch-all to capture anything
 * else (verified by the forward-compat unit test).
 */
export const StreamJsonMessage = Schema.Union(
  UserMessage,
  AssistantMessage,
  SystemMessage,
  ResultMessage,
  StreamEvent,
  RateLimitEvent,
  ControlRequest,
  ControlResponse,
  ControlCancelRequest,
  TranscriptMirror,
  UnknownFrame,
);
export type StreamJsonMessage = Schema.Schema.Type<typeof StreamJsonMessage>;

/* -------------------------------------------------------------------------- */
/* Outbound (Symphony → Claude) frame schemas.                                */
/*                                                                            */
/* These are the only frames Symphony writes to the CLI's stdin: a user       */
/* prompt, a control_response (e.g. answering a can_use_tool request), and   */
/* a control_cancel_request (e.g. interrupting a long-running turn).         */
/* -------------------------------------------------------------------------- */

/**
 * Outbound user prompt. Mirrors the inbound `UserMessage` shape but tightens
 * the optional fields the host typically omits to keep the wire payload tiny.
 */
export const OutboundUserMessage = Schema.Struct({
  type: Schema.Literal("user"),
  message: UserInnerMessage,
  parent_tool_use_id: Schema.optional(Schema.NullOr(Schema.String)),
  session_id: Schema.optional(Schema.String),
});
export type OutboundUserMessage = Schema.Schema.Type<typeof OutboundUserMessage>;

/** Outbound control response — same wire shape as the inbound one. */
export const OutboundControlResponse = ControlResponse;
export type OutboundControlResponse = Schema.Schema.Type<
  typeof OutboundControlResponse
>;

/** Outbound control_cancel_request — same wire shape as the inbound one. */
export const OutboundControlCancelRequest = ControlCancelRequest;
export type OutboundControlCancelRequest = Schema.Schema.Type<
  typeof OutboundControlCancelRequest
>;
