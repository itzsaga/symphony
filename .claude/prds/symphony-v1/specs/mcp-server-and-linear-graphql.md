# In-process MCP server and linear_graphql tool

## Objective

Host an in-process (SDK-type) MCP server inside the orchestrator that exposes one tool: `linear_graphql`. The server speaks MCP JSON-RPC (just enough: `initialize`, `tools/list`, `tools/call`, `notifications/initialized`) and is reachable from Claude through the control-protocol `mcp_message` channel. Tool calls execute via `LinearClient.executeRaw` using Symphony's configured Linear auth. Matches spec §10.5 `linear_graphql` extension contract and `research/claude-stream-json.md` §7.b.

## Context

### Parent PRD

- **PRD**: Symphony v1 (Effect.ts + Claude Code)
- **PRD Path**: `.claude/prds/symphony-v1/PRD.md`

### Related Tasks

- **Depends on**: linear-client.md, claude-control-protocol.md, claude-stream-json-schemas.md, logger-service.md.
- **Blocks**: orchestrator-state.md (orchestrator wires this into Claude spawn).

## Acceptance Criteria

- [ ] `McpServer` `Context.Tag` with one method:
  ```ts
  handle(msg: McpMessage): Effect<McpMessage, never>
  ```
  Implements the JSON-RPC routing for these methods (per `research/claude-stream-json.md` §7.b):
  - `initialize` — returns `{ protocolVersion: "2025-06-18", serverInfo: { name: "symphony", version: <…> }, capabilities: { tools: {} } }`. Whatever version Anthropic's CLI implements is what we match; pick the value in the SDK.
  - `notifications/initialized` — no-op.
  - `tools/list` — returns one tool: `linear_graphql`.
  - `tools/call` with `name === "linear_graphql"` — runs the tool.
  - Anything else: standard MCP error response (method not found).
- [ ] `linear_graphql` tool spec (advertised via `tools/list`):
  - Name: `linear_graphql`.
  - Description: spec §10.5 — *"Execute a raw GraphQL query or mutation against Linear using Symphony's configured tracker auth."*
  - Input JSON Schema:
    ```json
    {
      "type": "object",
      "properties": {
        "query": { "type": "string", "minLength": 1 },
        "variables": { "type": "object" }
      },
      "required": ["query"]
    }
    ```
  - Additionally accept a raw GraphQL string as shorthand (§10.5 "Implementations MAY additionally accept a raw GraphQL query string as shorthand input").
- [ ] `linear_graphql` invocation (§10.5 semantics):
  - Validate `query` non-empty. Reject empty/missing with structured error result (`isError: true`).
  - Validate that the document contains exactly one operation. Reject multi-operation docs.
  - Reject if no Linear auth is configured (`success=false, error.code="missing_auth"`).
  - Execute via `LinearClient.executeRaw(query, variables)`.
  - Result mapping:
    - Transport success + no `errors` array in response → tool result `{ content: [{ type: "text", text: JSON.stringify(data) }], isError: false, structuredContent: { success: true, data } }`. (Or whatever the MCP `tools/call` response shape is — match Anthropic's CLI expectations.)
    - GraphQL `errors` array present → `{ isError: false, structuredContent: { success: false, errors, data } }` — note `isError: false` at the MCP level because the tool itself ran; the underlying GraphQL failed. Per §10.5 *"preserve the GraphQL response body for debugging"*.
    - Invalid input / missing auth / transport failure → `{ isError: true, content: [{ type: "text", text: "<reason>" }], structuredContent: { success: false, error: { code, message } } }`.
- [ ] Don't expose the raw `tracker.api_key` to Claude — only the GraphQL surface. Never log the key (§15.3).
- [ ] Wire-up: the orchestrator passes the MCP config to `ClaudeSubprocess.spawn` as `--mcp-config <inline-json>` declaring this server with `{ type: "sdk", name: "symphony" }`. The control-protocol layer's `mcpMessage` handler delegates to this service.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `src/claude/McpServer.ts` | Create | The MCP service Tag + Live Layer + JSON-RPC dispatcher. |
| `src/claude/mcpSchemas.ts` | Create | `@effect/schema` for MCP JSON-RPC frames (request, response, error, tool definitions). |
| `src/claude/linearGraphqlTool.ts` | Create | The tool's input validation + execution + result mapping. |

### Technical Constraints

- The MCP server runs entirely in-process. No subprocess.
- Argument validation uses the `@effect/schema` input JSON-Schema. Reject with a structured MCP error if the input doesn't conform.
- "Exactly one operation" check: use a lightweight regex / GraphQL document parser. If pulling in `graphql` (the reference implementation) is overkill, write a small `countOperations` helper that scans for top-level `query`/`mutation`/`subscription` keywords outside string literals. Document the trade-off.
- The MCP protocol version we advertise should match what the Claude CLI version we pin against expects. Inspect a captured `tools/list` request from a real `claude` session to confirm.

### Relevant Code References

- Spec §10.5 (linear_graphql extension contract).
- `research/claude-stream-json.md` §7.b (SDK-type MCP servers, control-protocol routing), §7.d (tool naming `mcp__<serverName>__<toolName>`).
- `linear-client.md` — the underlying executor.

### Code Examples

```ts
const linearGraphqlTool = {
  name: "linear_graphql",
  description: "Execute a raw GraphQL query or mutation against Linear …",
  inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1 }, variables: { type: "object" } }, required: ["query"] },
}

const handleToolCall = (req) => Effect.gen(function*() {
  if (req.params.name !== "linear_graphql") return mcpError(req, "tool not found")
  const args = req.params.arguments
  const query = typeof args === "string" ? args : args?.query
  if (!query || query.trim() === "") return toolError(req, "missing_query")
  if (countOperations(query) !== 1) return toolError(req, "exactly_one_operation_required")
  const linear = yield* LinearClient
  const result = yield* linear.executeRaw(query, args?.variables ?? {}).pipe(Effect.either)
  return result._tag === "Left" ? toolError(req, result.left) : toolResult(req, result.right)
})
```

## Testing Requirements

- [ ] `initialize` → expected handshake response.
- [ ] `tools/list` → exposes only `linear_graphql`.
- [ ] `tools/call` with valid `{ query, variables }` against a stubbed `LinearClient` returns `success: true`.
- [ ] `tools/call` with a GraphQL response containing `errors` returns `success: false` and preserves the body.
- [ ] Empty `query` rejected with `success: false, error.code: "missing_query"`.
- [ ] Multi-operation document rejected.
- [ ] Raw-string shorthand input accepted.
- [ ] An unknown tool name returns a `tools/call` failure but does not stall — the §10.5 "unsupported tool names SHOULD still return a failure result using the targeted protocol and continue the session" requirement.
- [ ] No tracker API key appears in any log line.

## Out of Scope

- MCP `resources/*` or `prompts/*` methods.
- Tools beyond `linear_graphql`. Future tools (a `notify_human`, an `update_workflow`) are separate PRDs.
- Caching tool results.
- Multi-tenant scope (one Linear project per workflow).
- A general MCP library. Roll just what we need.
