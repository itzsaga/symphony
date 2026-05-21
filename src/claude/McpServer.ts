// In-process MCP server hosted by the orchestrator: serves `initialize`,
// `tools/list`, `tools/call`, `notifications/initialized` for the `linear_graphql` tool per spec §10.5 + research §7.b.
import { Context, Effect, Layer, Schema, type ParseResult } from "effect";
import { LinearClient } from "../linear/LinearClient.ts";
import { Logger } from "../observability/Logger.ts";
import { WorkflowLoader } from "../config/WorkflowLoader.ts";
import {
  executeLinearGraphql,
  linearGraphqlToolDescriptor,
  LINEAR_GRAPHQL_TOOL_NAME,
} from "./linearGraphqlTool.ts";
import {
  JsonRpcErrorCode,
  JsonRpcRequest,
  ToolsCallParams,
  type InitializeResult,
  type JsonRpcErrorResponse,
  type JsonRpcId,
  type JsonRpcResponse,
  type JsonRpcSuccessResponse,
  type ToolCallResult,
  type ToolDescriptor,
} from "./mcpSchemas.ts";

/* -------------------------------------------------------------------------- */
/* Server identity                                                            */
/* -------------------------------------------------------------------------- */

/**
 * MCP protocol version we advertise on `initialize`. Matches the version the
 * Claude CLI's MCP transport expects (per `research/claude-stream-json.md`
 * §7.b — the SDK uses this revision in its `_internal/query.py` MCP routing).
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** The wire name of this in-process server. Must match the `--mcp-config` advertisement. */
export const MCP_SERVER_NAME = "symphony";

/**
 * Read the Symphony version once at module load. Mirrors the pattern used by
 * `ClaudeSubprocess.ts` so the MCP `serverInfo.version` matches the value
 * advertised elsewhere. Falls back to `"dev"` on read failure.
 */
const SYMPHONY_VERSION: string = await readSymphonyVersion();

async function readSymphonyVersion(): Promise<string> {
  try {
    const here = new URL(".", import.meta.url).pathname;
    const root = new URL("../../package.json", `file://${here}`).pathname;
    const text = await Bun.file(root).text();
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      typeof (parsed as { version: unknown }).version === "string"
    ) {
      return (parsed as { version: string }).version;
    }
  } catch {
    // Fall through.
  }
  return "dev";
}

/* -------------------------------------------------------------------------- */
/* Service interface + Tag                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Public MCP server API. `handle` takes a raw (already-JSON-parsed) MCP
 * message and returns either a JSON-RPC response or `null` when the inbound
 * message is a notification (`notifications/initialized` carries no `id` and
 * therefore receives no response — that's the JSON-RPC 2.0 rule, codified in
 * the MCP spec too).
 *
 * `handle` returns `never` as its failure channel: every error path — invalid
 * params, unknown method, tool execution failure — is folded into the
 * outbound JSON-RPC envelope (success or error response), so callers can
 * synchronously forward the result onto the wire without further pattern
 * matching.
 */
export interface McpServerService {
  readonly handle: (
    msg: unknown,
  ) => Effect.Effect<JsonRpcResponse | null, never>;
}

/** The McpServer service tag. */
export class McpServer extends Context.Tag("symphony/claude/McpServer")<
  McpServer,
  McpServerService
>() {}

/* -------------------------------------------------------------------------- */
/* Frame builders                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Echo the JSON-RPC id slot verbatim into an outbound success envelope. We
 * default `id` to `null` for the (unlikely) case where the inbound request
 * omits it but still expects a response — JSON-RPC permits `id: null` on
 * responses to malformed requests.
 */
const buildSuccess = (
  id: JsonRpcId,
  result: unknown,
): JsonRpcSuccessResponse => ({
  jsonrpc: "2.0",
  id,
  result,
});

const buildError = (
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse => ({
  jsonrpc: "2.0",
  id,
  error: {
    code,
    message,
    ...(data !== undefined ? { data } : {}),
  },
});

/* -------------------------------------------------------------------------- */
/* Method handlers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `initialize` handler. Returns the protocol version, server identity, and
 * an empty `capabilities.tools` map signaling that tools are available (the
 * exact contents are method-specific — for tools, the map is conventionally
 * empty and the client discovers tools via `tools/list`).
 */
const handleInitialize = (id: JsonRpcId): Effect.Effect<JsonRpcResponse> => {
  const result: InitializeResult = {
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverInfo: {
      name: MCP_SERVER_NAME,
      version: SYMPHONY_VERSION,
    },
    capabilities: {
      tools: {},
    },
  };
  return Effect.succeed(buildSuccess(id, result));
};

/**
 * `tools/list` handler. Advertises the single tool this server exposes;
 * future tools (a `notify_human`, an `update_workflow`) would be added here.
 */
const handleToolsList = (id: JsonRpcId): Effect.Effect<JsonRpcResponse> =>
  Effect.succeed(
    buildSuccess(id, {
      tools: [linearGraphqlToolDescriptor] satisfies ReadonlyArray<ToolDescriptor>,
    }),
  );

/**
 * `tools/call` handler. Decodes the params envelope, routes by tool name,
 * and folds tool results — including tool-level errors (`isError: true`) —
 * into a JSON-RPC success response. The §10.5 "unsupported tool names SHOULD
 * still return a failure result and continue the session" requirement is met
 * by returning a success-shaped JSON-RPC response whose payload sets
 * `isError: true` rather than emitting a JSON-RPC error frame for the
 * unknown-tool case.
 */
const handleToolsCall = (
  id: JsonRpcId,
  rawParams: unknown,
): Effect.Effect<JsonRpcResponse, never, LinearClient | WorkflowLoader | Logger> =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknown(ToolsCallParams)(rawParams).pipe(
      Effect.either,
    );
    if (decoded._tag === "Left") {
      return buildError(
        id,
        JsonRpcErrorCode.InvalidParams,
        `tools/call: malformed params: ${describeDecodeError(decoded.left)}`,
      );
    }
    const params = decoded.right;
    if (params.name !== LINEAR_GRAPHQL_TOOL_NAME) {
      // §10.5 / §7.d: unknown tool names return a tool-level failure rather
      // than a JSON-RPC error so the session continues. We log at info
      // level so unexpected tool calls are visible in the operator stream.
      const log = yield* Logger;
      yield* log.info({
        msg: "mcp tools/call for unknown tool; returning tool-level failure",
        tool: params.name,
      });
      const result: ToolCallResult = {
        content: [
          {
            type: "text",
            text: `linear_graphql is the only tool advertised by this MCP server; received tools/call for unknown tool "${params.name}"`,
          },
        ],
        isError: true,
        structuredContent: {
          success: false,
          error: { code: "unknown_tool", message: params.name },
        },
      };
      return buildSuccess(id, result);
    }
    const result = yield* executeLinearGraphql(params.arguments);
    return buildSuccess(id, result);
  });

/* -------------------------------------------------------------------------- */
/* Decode-error formatter                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One-line rendering of a `ParseError`. Matches the helper in LinearClient —
 * we want short messages for wire-bound error frames, not the full
 * `formatError` tree.
 */
const describeDecodeError = (err: unknown): string => {
  if (err === null || err === undefined) return "unknown decode error";
  if (typeof err === "object" && "message" in err) {
    const msg = (err as { message: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  return String(err);
};

/* -------------------------------------------------------------------------- */
/* Top-level dispatcher                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Build the McpServerService instance. Exposed as a free function so tests
 * can construct one without going through the Layer when they want to inject
 * fake LinearClient + Logger + WorkflowLoader contexts via `Effect.provide`.
 *
 * The returned `handle` decodes the inbound envelope as a JsonRpcRequest,
 * dispatches by `method`, and folds every outcome into either a JSON-RPC
 * response or `null` (for notifications). Failure-channel is `never`
 * because the dispatcher cannot meaningfully fail at this layer — any
 * structural issue with the inbound envelope becomes a JSON-RPC error
 * response.
 */
export const makeService =
  (deps: {
    readonly linear: LinearClient["Type"];
    readonly logger: Logger["Type"];
    readonly loader: WorkflowLoader["Type"];
  }): McpServerService => ({
    handle: (msg: unknown) =>
      handleMessage(msg).pipe(
        Effect.provideService(LinearClient, deps.linear),
        Effect.provideService(Logger, deps.logger),
        Effect.provideService(WorkflowLoader, deps.loader),
      ),
  });

/**
 * Core message dispatch — kept separate from {@link makeService} so the
 * Live Layer below can wire dependencies in via `Effect.gen` rather than
 * threading them through manually.
 */
const handleMessage = (
  msg: unknown,
): Effect.Effect<
  JsonRpcResponse | null,
  never,
  LinearClient | WorkflowLoader | Logger
> =>
  Effect.gen(function* () {
    // Decode the JSON-RPC envelope. We treat decode failures as
    // `InvalidRequest` errors with `id: null` (per JSON-RPC 2.0). A
    // missing/mistyped `jsonrpc` field, missing `method`, etc. all land
    // here.
    const decoded = yield* Schema.decodeUnknown(JsonRpcRequest)(msg).pipe(
      Effect.either,
    );
    if (decoded._tag === "Left") {
      return buildError(
        null,
        JsonRpcErrorCode.InvalidRequest,
        `mcp: malformed JSON-RPC request: ${describeDecodeError(decoded.left)}`,
      );
    }
    const req = decoded.right;
    // Notifications carry no `id` and elicit no response. Per the MCP spec
    // the only notification the host receives is `notifications/initialized`;
    // we ignore any other notification method too (the JSON-RPC 2.0 rule is
    // "no response").
    const isNotification = req.id === undefined;
    if (isNotification) {
      return null;
    }
    const id: JsonRpcId = req.id ?? null;

    switch (req.method) {
      case "initialize":
        return yield* handleInitialize(id);
      case "tools/list":
        return yield* handleToolsList(id);
      case "tools/call":
        return yield* handleToolsCall(id, req.params);
      default:
        return buildError(
          id,
          JsonRpcErrorCode.MethodNotFound,
          `mcp: method not found: ${req.method}`,
          { method: req.method },
        );
    }
  });

/* -------------------------------------------------------------------------- */
/* Live Layer                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Wire the McpServer against an already-provided `LinearClient`, `Logger`,
 * and `WorkflowLoader`. The Layer requires those three from its environment;
 * production wiring composes them in `main.ts`, and tests inject fakes via
 * `Layer.succeed` / `Layer.effect` as needed.
 *
 * The service object closes over the three dependencies at Layer-construct
 * time so `handle` does not need to re-read them on every call.
 */
export const McpServerLive: Layer.Layer<
  McpServer,
  never,
  LinearClient | Logger | WorkflowLoader
> = Layer.effect(
  McpServer,
  Effect.gen(function* () {
    const linear = yield* LinearClient;
    const logger = yield* Logger;
    const loader = yield* WorkflowLoader;
    return makeService({ linear, logger, loader });
  }),
);

/* -------------------------------------------------------------------------- */
/* Re-exports                                                                 */
/* -------------------------------------------------------------------------- */

// Convenience re-exports for callers (the orchestrator wires these into the
// ControlProtocol `mcpMessage` handler).
export {
  LINEAR_GRAPHQL_TOOL_NAME,
  linearGraphqlToolDescriptor,
} from "./linearGraphqlTool.ts";

// Type-only re-export so callers don't reach into mcpSchemas just to pattern
// match on the outbound envelope.
export type {
  JsonRpcResponse,
  JsonRpcErrorResponse,
  JsonRpcSuccessResponse,
} from "./mcpSchemas.ts";

// Re-export ParseResult to keep the public surface explicit; the decoder
// internals are an implementation detail otherwise.
export type { ParseResult };
