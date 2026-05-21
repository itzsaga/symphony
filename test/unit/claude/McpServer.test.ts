// Unit tests for src/claude/McpServer.ts and src/claude/linearGraphqlTool.ts.
// Exercises every JSON-RPC method, every result-mapping branch, and the log-redaction invariant.
import { describe, expect, it } from "bun:test";
import { Effect, Layer, Ref } from "effect";
import { LinearClient } from "../../../src/linear/LinearClient.ts";
import type {
  Issue,
  LinearClientError,
  MinimalIssue,
} from "../../../src/linear/schemas.ts";
import { WorkflowLoader } from "../../../src/config/WorkflowLoader.ts";
import type {
  TypedConfig,
  WorkflowDefinition,
} from "../../../src/config/WorkflowSchema.ts";
import {
  layer as loggerLayer,
  type LogRecord,
  type LogSink,
} from "../../../src/observability/Logger.ts";
import {
  McpServer,
  McpServerLive,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
} from "../../../src/claude/McpServer.ts";
import {
  countOperations,
  LINEAR_GRAPHQL_TOOL_NAME,
} from "../../../src/claude/linearGraphqlTool.ts";
import type {
  JsonRpcResponse,
  ToolCallResult,
} from "../../../src/claude/mcpSchemas.ts";

/* -------------------------------------------------------------------------- */
/* Test fixtures                                                              */
/* -------------------------------------------------------------------------- */

const ENDPOINT = "https://api.linear.app/graphql";
const API_KEY_SECRET = "lin_oauth_secret_value_do_not_log";
const PROJECT_SLUG = "my-project";

/** Build a TypedConfig override for the WorkflowLoader stub. */
const fakeConfig = (
  overrides?: Partial<TypedConfig["tracker"]>,
): TypedConfig => ({
  tracker: {
    kind: "linear",
    endpoint: ENDPOINT,
    api_key: API_KEY_SECRET,
    project_slug: PROJECT_SLUG,
    active_states: ["Todo"],
    terminal_states: ["Done"],
    ...overrides,
  },
  polling: { interval_ms: 30_000 },
  workspace: { root: "/tmp/ws" },
  hooks: {
    after_create: null,
    before_run: null,
    after_run: null,
    before_remove: null,
    timeout_ms: 60_000,
  },
  agent_runner: {
    kind: "claude_code",
    command: "claude",
    permission_mode: "bypassPermissions",
    max_turns: 20,
    turn_timeout_ms: 3_600_000,
    read_timeout_ms: 5_000,
    stall_timeout_ms: 300_000,
    network_profile: "claude-code",
    bare: false,
    extra_args: [],
    max_concurrent_agents: 10,
    max_concurrent_agents_by_state: {},
    max_retry_backoff_ms: 300_000,
    continuation_prompt: null,
  },
  server: null,
});

/**
 * Stubbed WorkflowLoader returning a fixed config. Mirrors the helper in
 * LinearClient.test.ts (kept local so this test stays self-contained).
 */
const stubWorkflowLoader = (
  config: TypedConfig,
): Layer.Layer<WorkflowLoader> =>
  Layer.effect(
    WorkflowLoader,
    Effect.gen(function* () {
      const ref = yield* Ref.make<WorkflowDefinition>({
        config,
        prompt_template: "x",
        source_path: "/tmp/WORKFLOW.md",
      });
      return {
        current: Ref.get(ref),
        changes: {
          [Symbol.iterator]: function* () {
            // unused
          },
        } as never,
        validateForDispatch: Effect.void,
      };
    }),
  );

/**
 * Programmable LinearClient stub. Each invocation of `executeRaw` returns the
 * next value from `script`, records the call args, and asserts no other
 * LinearClient method is invoked (those would indicate a bug in the MCP
 * wiring — the tool only calls `executeRaw`).
 */
interface ScriptedLinear {
  readonly layer: Layer.Layer<LinearClient>;
  readonly calls: ReadonlyArray<{
    query: string;
    variables: Record<string, unknown>;
  }>;
}

const scriptedLinear = (
  script: ReadonlyArray<
    | { kind: "ok"; envelope: unknown }
    | { kind: "fail"; error: LinearClientError }
  >,
): ScriptedLinear => {
  const calls: Array<{
    query: string;
    variables: Record<string, unknown>;
  }> = [];
  let cursor = 0;
  const layer = Layer.succeed(LinearClient, {
    fetchCandidateIssues: Effect.die("scripted LinearClient: fetchCandidateIssues unused"),
    fetchIssuesByStates: (_) =>
      Effect.die("scripted LinearClient: fetchIssuesByStates unused") as Effect.Effect<
        ReadonlyArray<Issue>,
        LinearClientError
      >,
    fetchIssueStatesByIds: (_) =>
      Effect.die("scripted LinearClient: fetchIssueStatesByIds unused") as Effect.Effect<
        ReadonlyArray<MinimalIssue>,
        LinearClientError
      >,
    executeRaw: (query, variables) =>
      Effect.suspend(() => {
        calls.push({ query, variables: variables ?? {} });
        const entry = script[cursor];
        cursor += 1;
        if (entry === undefined) {
          throw new Error(
            `scripted LinearClient: unexpected extra executeRaw call ${cursor}`,
          );
        }
        if (entry.kind === "fail") {
          return Effect.fail(entry.error);
        }
        return Effect.succeed(entry.envelope);
      }),
  });
  return {
    layer,
    get calls() {
      return calls;
    },
  };
};

/** Capture-sink for the Logger, so we can scan emitted lines for the secret. */
const captureSink = (): { sink: LogSink; lines: ReadonlyArray<string> } => {
  const lines: Array<string> = [];
  return {
    sink: { write: (line) => void lines.push(line) },
    get lines() {
      return lines;
    },
  };
};

/**
 * Build the full McpServerLive stack with the supplied LinearClient + config
 * + logger sink. Returns the composed Layer so each test can `Effect.provide`
 * it once.
 */
const mcpStack = (deps: {
  readonly linear: Layer.Layer<LinearClient>;
  readonly config: TypedConfig;
  readonly sink: LogSink;
}): Layer.Layer<McpServer> =>
  McpServerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        deps.linear,
        stubWorkflowLoader(deps.config),
        loggerLayer({ sink: deps.sink }),
      ),
    ),
  );

/* -------------------------------------------------------------------------- */
/* JSON-RPC helpers                                                            */
/* -------------------------------------------------------------------------- */

const initializeFrame = (id: number | string = 1): unknown => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {},
});

const toolsListFrame = (id: number | string = 2): unknown => ({
  jsonrpc: "2.0",
  id,
  method: "tools/list",
});

const toolsCallFrame = (
  args: unknown,
  toolName: string = LINEAR_GRAPHQL_TOOL_NAME,
  id: number | string = 3,
): unknown => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: toolName, arguments: args },
});

const notificationFrame = (
  method: string = "notifications/initialized",
): unknown => ({
  jsonrpc: "2.0",
  method,
});

/** Run an MCP handler with the supplied dependency layer. */
const callHandle = (
  msg: unknown,
  stack: Layer.Layer<McpServer>,
): Promise<JsonRpcResponse | null> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* McpServer;
      return yield* server.handle(msg);
    }).pipe(Effect.provide(stack)),
  );

/** Narrow a JsonRpcResponse | null into a success body's `result`. */
const successResult = (resp: JsonRpcResponse | null): unknown => {
  if (resp === null) throw new Error("expected response, got null");
  if (!("result" in resp)) {
    throw new Error(
      `expected success response, got error: ${JSON.stringify(resp)}`,
    );
  }
  return resp.result;
};

/** Narrow a tools/call result.body into its ToolCallResult shape. */
const callResult = (resp: JsonRpcResponse | null): ToolCallResult =>
  successResult(resp) as ToolCallResult;

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("McpServer — initialize", () => {
  it("returns the protocol version, server identity, and tools capability", async () => {
    const linear = scriptedLinear([]);
    const captured = captureSink();
    const stack = mcpStack({
      linear: linear.layer,
      config: fakeConfig(),
      sink: captured.sink,
    });

    const resp = await callHandle(initializeFrame(7), stack);
    expect(resp).not.toBeNull();
    const result = successResult(resp) as {
      readonly protocolVersion: string;
      readonly serverInfo: { readonly name: string; readonly version: string };
      readonly capabilities: { readonly tools: unknown };
    };
    expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(result.serverInfo.name).toBe(MCP_SERVER_NAME);
    expect(typeof result.serverInfo.version).toBe("string");
    expect(result.capabilities.tools).toEqual({});
    expect(linear.calls).toHaveLength(0);
  });
});

describe("McpServer — notifications/initialized", () => {
  it("returns null for notifications (no JSON-RPC id, no response)", async () => {
    const linear = scriptedLinear([]);
    const captured = captureSink();
    const stack = mcpStack({
      linear: linear.layer,
      config: fakeConfig(),
      sink: captured.sink,
    });
    const resp = await callHandle(notificationFrame(), stack);
    expect(resp).toBeNull();
  });
});

describe("McpServer — tools/list", () => {
  it("exposes only `linear_graphql`", async () => {
    const linear = scriptedLinear([]);
    const captured = captureSink();
    const stack = mcpStack({
      linear: linear.layer,
      config: fakeConfig(),
      sink: captured.sink,
    });
    const resp = await callHandle(toolsListFrame(), stack);
    const result = successResult(resp) as {
      readonly tools: ReadonlyArray<{
        readonly name: string;
        readonly description?: string;
        readonly inputSchema: { readonly required?: ReadonlyArray<string> };
      }>;
    };
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]!.name).toBe(LINEAR_GRAPHQL_TOOL_NAME);
    expect(result.tools[0]!.description ?? "").toContain("GraphQL");
    expect(result.tools[0]!.inputSchema.required).toEqual(["query"]);
  });
});

describe("McpServer — tools/call (linear_graphql)", () => {
  it("returns success=true with the GraphQL data on a clean response", async () => {
    const linear = scriptedLinear([
      { kind: "ok", envelope: { data: { issue: { id: "abc" } } } },
    ]);
    const captured = captureSink();
    const stack = mcpStack({
      linear: linear.layer,
      config: fakeConfig(),
      sink: captured.sink,
    });
    const resp = await callHandle(
      toolsCallFrame({
        query: "query GetIssue($id: ID!) { issue(id: $id) { id } }",
        variables: { id: "abc" },
      }),
      stack,
    );
    const tool = callResult(resp);
    expect(tool.isError).toBeFalsy();
    const structured = tool.structuredContent as {
      readonly success: boolean;
      readonly data: { readonly issue: { readonly id: string } };
    };
    expect(structured.success).toBe(true);
    expect(structured.data.issue.id).toBe("abc");

    // The single text block carries the data JSON for the model.
    expect(tool.content).toHaveLength(1);
    expect(tool.content[0]!.type).toBe("text");
    expect(tool.content[0]!.text).toContain("abc");

    expect(linear.calls).toHaveLength(1);
    expect(linear.calls[0]!.variables).toEqual({ id: "abc" });
  });

  it("preserves GraphQL errors with success=false and isError=false", async () => {
    const linear = scriptedLinear([
      {
        kind: "ok",
        envelope: {
          data: null,
          errors: [
            { message: "Not authorized to perform this mutation" },
            { message: "Issue not found" },
          ],
        },
      },
    ]);
    const captured = captureSink();
    const stack = mcpStack({
      linear: linear.layer,
      config: fakeConfig(),
      sink: captured.sink,
    });
    const resp = await callHandle(
      toolsCallFrame({ query: "mutation { x }" }),
      stack,
    );
    const tool = callResult(resp);
    // §10.5: the tool itself ran, so isError stays false. success=false in
    // the structured body signals the GraphQL-level failure.
    expect(tool.isError).toBeFalsy();
    const structured = tool.structuredContent as {
      readonly success: boolean;
      readonly errors: ReadonlyArray<{ readonly message: string }>;
      readonly data: unknown;
    };
    expect(structured.success).toBe(false);
    expect(structured.errors).toHaveLength(2);
    expect(structured.errors[0]!.message).toContain("Not authorized");
    // Body preserved verbatim.
    expect(tool.content[0]!.text).toContain("Not authorized");
  });

  it("rejects an empty query with missing_query / isError=true", async () => {
    const linear = scriptedLinear([]);
    const captured = captureSink();
    const stack = mcpStack({
      linear: linear.layer,
      config: fakeConfig(),
      sink: captured.sink,
    });
    const resp = await callHandle(
      toolsCallFrame({ query: "   " }),
      stack,
    );
    const tool = callResult(resp);
    expect(tool.isError).toBe(true);
    const structured = tool.structuredContent as {
      readonly success: boolean;
      readonly error: { readonly code: string };
    };
    expect(structured.success).toBe(false);
    expect(structured.error.code).toBe("missing_query");
    expect(linear.calls).toHaveLength(0);
  });

  it("rejects a multi-operation document with multiple_operations", async () => {
    const linear = scriptedLinear([]);
    const captured = captureSink();
    const stack = mcpStack({
      linear: linear.layer,
      config: fakeConfig(),
      sink: captured.sink,
    });
    const resp = await callHandle(
      toolsCallFrame({
        query: "query A { a } query B { b }",
      }),
      stack,
    );
    const tool = callResult(resp);
    expect(tool.isError).toBe(true);
    const structured = tool.structuredContent as {
      readonly error: { readonly code: string };
    };
    expect(structured.error.code).toBe("multiple_operations");
    expect(linear.calls).toHaveLength(0);
  });

  it("accepts the raw-string shorthand input form", async () => {
    const linear = scriptedLinear([
      { kind: "ok", envelope: { data: { viewer: { id: "u1" } } } },
    ]);
    const captured = captureSink();
    const stack = mcpStack({
      linear: linear.layer,
      config: fakeConfig(),
      sink: captured.sink,
    });
    const resp = await callHandle(
      toolsCallFrame("query { viewer { id } }"),
      stack,
    );
    const tool = callResult(resp);
    expect(tool.isError).toBeFalsy();
    expect(linear.calls).toHaveLength(1);
    expect(linear.calls[0]!.query).toBe("query { viewer { id } }");
    // No variables on the shorthand path → empty object on the wire.
    expect(linear.calls[0]!.variables).toEqual({});
  });

  it("rejects missing auth with missing_auth before any HTTP call", async () => {
    const linear = scriptedLinear([]);
    const captured = captureSink();
    const stack = mcpStack({
      linear: linear.layer,
      config: fakeConfig({ api_key: null }),
      sink: captured.sink,
    });
    const resp = await callHandle(
      toolsCallFrame({ query: "query { viewer { id } }" }),
      stack,
    );
    const tool = callResult(resp);
    expect(tool.isError).toBe(true);
    const structured = tool.structuredContent as {
      readonly error: { readonly code: string };
    };
    expect(structured.error.code).toBe("missing_auth");
    expect(linear.calls).toHaveLength(0);
  });

  it("maps LinearRequestFail into a transport_error tool failure", async () => {
    const linear = scriptedLinear([
      {
        kind: "fail",
        error: {
          _tag: "LinearRequestFail",
          endpoint: ENDPOINT,
          message: "ECONNRESET",
        } as LinearClientError,
      },
    ]);
    const captured = captureSink();
    const stack = mcpStack({
      linear: linear.layer,
      config: fakeConfig(),
      sink: captured.sink,
    });
    const resp = await callHandle(
      toolsCallFrame({ query: "query { viewer { id } }" }),
      stack,
    );
    const tool = callResult(resp);
    expect(tool.isError).toBe(true);
    const structured = tool.structuredContent as {
      readonly error: { readonly code: string };
    };
    expect(structured.error.code).toBe("transport_error");
  });

  it("returns a tool-level failure (not a JSON-RPC error) for unknown tool names", async () => {
    const linear = scriptedLinear([]);
    const captured = captureSink();
    const stack = mcpStack({
      linear: linear.layer,
      config: fakeConfig(),
      sink: captured.sink,
    });
    const resp = await callHandle(
      toolsCallFrame({ query: "x" }, "frobnicate"),
      stack,
    );
    // The §10.5 / §7.d contract: the JSON-RPC response is a *success*
    // envelope; the tool-level failure lives in `isError: true`.
    expect(resp).not.toBeNull();
    if (resp === null) throw new Error("unreachable");
    expect("result" in resp).toBe(true);
    const tool = callResult(resp);
    expect(tool.isError).toBe(true);
    const structured = tool.structuredContent as {
      readonly error: { readonly code: string };
    };
    expect(structured.error.code).toBe("unknown_tool");
  });

  it("never logs the tracker.api_key", async () => {
    const linear = scriptedLinear([
      { kind: "ok", envelope: { data: { ok: true } } },
    ]);
    const captured = captureSink();
    const stack = mcpStack({
      linear: linear.layer,
      config: fakeConfig(),
      sink: captured.sink,
    });
    // Exercise every JSON-RPC method that touches the loader / linear path.
    await callHandle(initializeFrame(), stack);
    await callHandle(toolsListFrame(), stack);
    await callHandle(
      toolsCallFrame({ query: "query { viewer { id } }" }),
      stack,
    );
    await callHandle(
      toolsCallFrame({ query: "" }), // triggers error logging
      stack,
    );
    await callHandle(
      toolsCallFrame({ query: "x" }, "frobnicate"),
      stack,
    );

    // Scan the captured lines for the secret literal.
    for (const line of captured.lines) {
      expect(line.includes(API_KEY_SECRET)).toBe(false);
      // Also parse and walk for safety in case some sub-field carries it.
      const parsed = JSON.parse(line) as LogRecord;
      const text = JSON.stringify(parsed);
      expect(text.includes(API_KEY_SECRET)).toBe(false);
    }
  });
});

describe("McpServer — unknown methods", () => {
  it("returns a JSON-RPC method-not-found error", async () => {
    const linear = scriptedLinear([]);
    const captured = captureSink();
    const stack = mcpStack({
      linear: linear.layer,
      config: fakeConfig(),
      sink: captured.sink,
    });
    const resp = await callHandle(
      { jsonrpc: "2.0", id: 99, method: "resources/list" },
      stack,
    );
    expect(resp).not.toBeNull();
    if (resp === null) throw new Error("unreachable");
    if (!("error" in resp)) throw new Error("expected JSON-RPC error response");
    const errBody = (resp as { error: { code: number; message: string } }).error;
    expect(errBody.code).toBe(-32601);
    expect(errBody.message).toContain("resources/list");
  });

  it("returns a JSON-RPC invalid-request error for malformed envelopes", async () => {
    const linear = scriptedLinear([]);
    const captured = captureSink();
    const stack = mcpStack({
      linear: linear.layer,
      config: fakeConfig(),
      sink: captured.sink,
    });
    const resp = await callHandle({ not: "a json-rpc message" }, stack);
    expect(resp).not.toBeNull();
    if (resp === null) throw new Error("unreachable");
    if (!("error" in resp)) throw new Error("expected JSON-RPC error response");
    const errBody = (resp as { error: { code: number } }).error;
    expect(errBody.code).toBe(-32600);
  });
});

/* -------------------------------------------------------------------------- */
/* countOperations                                                            */
/* -------------------------------------------------------------------------- */

describe("linearGraphqlTool.countOperations", () => {
  it("counts named queries / mutations / subscriptions", () => {
    expect(countOperations("query GetIssue { issue { id } }")).toBe(1);
    expect(countOperations("mutation MakeIssue { x { y } }")).toBe(1);
    expect(
      countOperations("subscription Live { events { tick } }"),
    ).toBe(1);
  });

  it("counts the anonymous shorthand `{ … }` as one operation", () => {
    expect(countOperations("{ viewer { id } }")).toBe(1);
  });

  it("counts multiple top-level operations", () => {
    expect(countOperations("query A { a } query B { b }")).toBe(2);
    expect(
      countOperations("query A { a } mutation B { b } query C { c }"),
    ).toBe(3);
  });

  it("returns zero for empty / whitespace / comment-only documents", () => {
    expect(countOperations("")).toBe(0);
    expect(countOperations("   ")).toBe(0);
    expect(countOperations("# this is a comment\n# more comments\n")).toBe(0);
  });

  it("does not count operation keywords inside string arguments", () => {
    expect(
      countOperations('query A { search(text: "query B { b }") { hits } }'),
    ).toBe(1);
    expect(
      countOperations('query A { search(text: """ query B { b } """) { hits } }'),
    ).toBe(1);
  });

  it("does not count operation keywords inside selection sets (field names)", () => {
    // `query` as a field name inside another operation — counts only the
    // outer one.
    expect(countOperations("query Outer { query }")).toBe(1);
  });

  it("ignores comments", () => {
    expect(
      countOperations("# query Hidden { x }\nquery Real { y }"),
    ).toBe(1);
  });
});
