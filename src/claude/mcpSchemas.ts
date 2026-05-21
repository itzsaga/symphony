// Effect Schemas for the MCP JSON-RPC frames Symphony's in-process server speaks.
// Covers initialize / tools/list / tools/call requests + responses + errors per the MCP "2025-06-18" spec subset Claude Code drives.
import { Schema } from "effect";

/* -------------------------------------------------------------------------- */
/* JSON-RPC primitives                                                        */
/* -------------------------------------------------------------------------- */

/**
 * JSON-RPC request id. Per the JSON-RPC 2.0 spec it is either a string, a
 * number, or `null`; in practice the Claude CLI uses string or integer ids.
 * We accept any of the three for forward-compat and echo it verbatim back on
 * the response.
 */
export const JsonRpcId = Schema.Union(
  Schema.String,
  Schema.Number,
  Schema.Null,
);
export type JsonRpcId = Schema.Schema.Type<typeof JsonRpcId>;

/**
 * The fixed `"2.0"` literal carried on every JSON-RPC frame. Modeled as a
 * literal so decode rejects frames missing or mistyped it.
 */
export const JsonRpcVersion = Schema.Literal("2.0");
export type JsonRpcVersion = Schema.Schema.Type<typeof JsonRpcVersion>;

/* -------------------------------------------------------------------------- */
/* Inbound JSON-RPC envelope shapes                                            */
/* -------------------------------------------------------------------------- */

/**
 * Generic JSON-RPC request envelope. `id` is OPTIONAL because notifications
 * (e.g. `notifications/initialized`) omit it; `params` is OPTIONAL because
 * some methods (`tools/list`, sometimes `initialize`) carry none.
 *
 * The struct is open via the index signature so unknown JSON-RPC fields pass
 * through without breaking decode.
 */
export const JsonRpcRequest = Schema.Struct(
  {
    jsonrpc: JsonRpcVersion,
    id: Schema.optional(JsonRpcId),
    method: Schema.String,
    params: Schema.optional(Schema.Unknown),
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type JsonRpcRequest = Schema.Schema.Type<typeof JsonRpcRequest>;

/* -------------------------------------------------------------------------- */
/* `tools/call` params + tool result shape                                     */
/* -------------------------------------------------------------------------- */

/**
 * `tools/call` params. `name` is REQUIRED; `arguments` is OPTIONAL and is
 * either a JSON object (preferred shape) or — per the `linear_graphql`
 * shorthand allowance in spec §10.5 — a raw string. We model it as `unknown`
 * here and let the per-tool handler do the narrowing; the input-schema
 * validation lives at the tool level.
 */
export const ToolsCallParams = Schema.Struct(
  {
    name: Schema.String,
    arguments: Schema.optional(Schema.Unknown),
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type ToolsCallParams = Schema.Schema.Type<typeof ToolsCallParams>;

/**
 * Single content block returned in an MCP `tools/call` result. Only the
 * `"text"` variant is used by `linear_graphql`; we model just that variant
 * since adding more later is purely additive.
 */
export const TextContentBlock = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});
export type TextContentBlock = Schema.Schema.Type<typeof TextContentBlock>;

/**
 * `tools/call` response body. Per the MCP spec the response is
 * `{ content: ContentBlock[], isError?: boolean, structuredContent?: object }`.
 * `structuredContent` is the recommended channel for machine-readable tool
 * output (carrying full GraphQL bodies, error codes, etc.) — clients display
 * `content` to the model, and can additionally consume `structuredContent`.
 */
export const ToolCallResult = Schema.Struct(
  {
    content: Schema.Array(TextContentBlock),
    isError: Schema.optional(Schema.Boolean),
    structuredContent: Schema.optional(Schema.Unknown),
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type ToolCallResult = Schema.Schema.Type<typeof ToolCallResult>;

/* -------------------------------------------------------------------------- */
/* Tool descriptor (advertised via `tools/list`)                                */
/* -------------------------------------------------------------------------- */

/**
 * Tool descriptor returned in the `tools/list` payload. `inputSchema` is the
 * raw JSON-Schema object the model uses to validate its tool invocations; we
 * keep it untyped (`Schema.Unknown`) because the shape is JSON-Schema, not a
 * fixed struct, and we want to round-trip whatever the host author wrote.
 */
export const ToolDescriptor = Schema.Struct(
  {
    name: Schema.String,
    description: Schema.optional(Schema.String),
    inputSchema: Schema.Unknown,
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type ToolDescriptor = Schema.Schema.Type<typeof ToolDescriptor>;

/* -------------------------------------------------------------------------- */
/* `initialize` result + server info                                            */
/* -------------------------------------------------------------------------- */

/**
 * `initialize` result body. We advertise `protocolVersion`, a `serverInfo`
 * `{ name, version }` block, and an empty `capabilities.tools: {}` map —
 * matching the shape the Claude CLI's MCP transport expects (see
 * `research/claude-stream-json.md` §7.b).
 */
export const InitializeResult = Schema.Struct(
  {
    protocolVersion: Schema.String,
    serverInfo: Schema.Struct(
      {
        name: Schema.String,
        version: Schema.String,
      },
      { key: Schema.String, value: Schema.Unknown },
    ),
    capabilities: Schema.Struct(
      {
        tools: Schema.optional(
          Schema.Struct(
            {},
            { key: Schema.String, value: Schema.Unknown },
          ),
        ),
      },
      { key: Schema.String, value: Schema.Unknown },
    ),
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type InitializeResult = Schema.Schema.Type<typeof InitializeResult>;

/* -------------------------------------------------------------------------- */
/* Outbound JSON-RPC envelopes                                                 */
/* -------------------------------------------------------------------------- */

/**
 * JSON-RPC success response envelope. We always echo the request `id`; for
 * notifications (no `id` inbound) the dispatcher never builds a response.
 */
export const JsonRpcSuccessResponse = Schema.Struct(
  {
    jsonrpc: JsonRpcVersion,
    id: JsonRpcId,
    result: Schema.Unknown,
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type JsonRpcSuccessResponse = Schema.Schema.Type<
  typeof JsonRpcSuccessResponse
>;

/**
 * JSON-RPC error body. Standard `code` + `message`, with an optional opaque
 * `data` slot used to surface extra diagnostics (we use it for the tool-name
 * on `method not found` errors).
 */
export const JsonRpcErrorBody = Schema.Struct(
  {
    code: Schema.Number,
    message: Schema.String,
    data: Schema.optional(Schema.Unknown),
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type JsonRpcErrorBody = Schema.Schema.Type<typeof JsonRpcErrorBody>;

/**
 * JSON-RPC error response envelope. `id` MAY be `null` if the inbound request
 * could not be parsed enough to extract the id; we still always set it because
 * the dispatcher only routes already-parsed `JsonRpcRequest` envelopes.
 */
export const JsonRpcErrorResponse = Schema.Struct(
  {
    jsonrpc: JsonRpcVersion,
    id: JsonRpcId,
    error: JsonRpcErrorBody,
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type JsonRpcErrorResponse = Schema.Schema.Type<
  typeof JsonRpcErrorResponse
>;

/** Discriminated union of every outbound JSON-RPC response we emit. */
export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/* -------------------------------------------------------------------------- */
/* Standard JSON-RPC error codes                                                */
/* -------------------------------------------------------------------------- */

/**
 * Subset of the JSON-RPC 2.0 standard error codes. We use `MethodNotFound`
 * for unknown MCP methods and `InvalidParams` for malformed params bodies.
 * The MCP layer never emits `ParseError` / `InvalidRequest` because the
 * outer control-protocol layer hands us pre-parsed JSON objects.
 */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;
