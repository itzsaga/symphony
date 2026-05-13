# Claude control-protocol RPC

## Objective

Implement the bidirectional control-protocol handler that runs over the same stdin/stdout pipe as conversation messages. Handles three inbound `control_request` subtypes: `can_use_tool` (always denies with `interrupt:true`), `mcp_message` (routes to the in-process MCP server), and `control_cancel_request` (cancels the in-flight turn fiber). Reference: `research/claude-stream-json.md` §6 and §7.b.

## Context

### Parent PRD

- **PRD**: Symphony v1 (Effect.ts + Claude Code)
- **PRD Path**: `.claude/prds/symphony-v1/PRD.md`

### Related Tasks

- **Depends on**: claude-subprocess-lifecycle.md, claude-stream-json-schemas.md, logger-service.md.
- **Blocks**: mcp-server-and-linear-graphql.md (which fulfills the `mcp_message` handler).

## Acceptance Criteria

- [ ] `ControlProtocol` service with method:
  ```ts
  serve(subprocess: ClaudeSubprocess, handlers: ControlHandlers): Effect<void, never, Scope>
  ```
  Forks a fiber that consumes `subprocess.incoming` for `control_request` frames, dispatches to handlers, and writes `control_response` frames back via `subprocess.outgoing`.
- [ ] `ControlHandlers` shape:
  ```ts
  type ControlHandlers = {
    canUseTool: (req: CanUseToolRequest) => Effect<CanUseToolDecision>
    mcpMessage:  (req: McpMessageRequest)  => Effect<McpMessageResult>
    onCancelRequest: (reqId: RequestId) => Effect<void>
  }
  ```
- [ ] Default `canUseTool` handler emits a §10.4 `turn_input_required` event via the EventMapping layer (separate task wires this) and returns `{ behavior: "deny", message: "Symphony v1: no human in loop", interrupt: true }`. This is v1's documented "treat user-input-required as hard failure" posture (§10.5).
- [ ] `mcpMessage` handler delegates to a `McpServer` service (separate task). If no MCP server is registered, returns `{ subtype: "error", error: "no MCP server available" }`.
- [ ] `control_cancel_request` matched by `request_id`: invoke `onCancelRequest`, which interrupts the matching outstanding handler if any. (Per `research/claude-stream-json.md` §6, these are rare but real.)
- [ ] Frame correlation by `request_id`: each `control_response` echoes the incoming `request_id`. Generated request IDs (for outbound `initialize` later) follow the format `req_<counter>_<4-hex>` per the SDK source.
- [ ] Error frames: a handler that returns a typed error produces a `control_response` with `subtype: "error"`, `error: <message>`.
- [ ] Concurrency: handlers can run concurrently. Each in-flight handler is a fiber stored in a map keyed by `request_id` so cancellation can target them.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `src/claude/ControlProtocol.ts` | Create | The protocol service + handler dispatcher + request-id correlation. |

### Technical Constraints

- The handlers receive already-decoded frames (the stream-json schemas have done the discriminated-union narrowing). No re-decoding in this layer.
- Stdin lifetime: `research/claude-stream-json.md` §6 — *"Symphony cannot `process.stdin.end()` immediately after writing its prompt — the CLI needs the channel for the entire turn."* This module doesn't close stdin; that's the subprocess-lifecycle's graceful-shutdown's job.
- Outbound `control_response` is always emitted within ~1s; if a handler takes longer (e.g. the `linear_graphql` tool waits on Linear's API), that's fine — the CLI is patient. Just don't deadlock.
- `can_use_tool` requests should be rare (`bypassPermissions` is set). If we see one, it's diagnostic; log INFO with the tool name, input, blocked_path before responding.

### Relevant Code References

- `research/claude-stream-json.md` §6 (entire), §7.b (MCP control routing), §3 (event-mapping recipient for can_use_tool).

### Code Examples

```ts
// Sketch
const serve = (subprocess, handlers) => Effect.gen(function*() {
  const inflight = yield* Ref.make(new Map<RequestId, Fiber.Fiber<unknown>>())

  yield* subprocess.incoming.pipe(
    Stream.runForEach((frame) => Effect.gen(function*() {
      if (frame.type === "control_request") {
        const fiber = yield* Effect.fork(handleOne(frame, handlers, subprocess.outgoing))
        yield* Ref.update(inflight, (m) => new Map(m).set(frame.request_id, fiber))
      } else if (frame.type === "control_cancel_request") {
        const m = yield* Ref.get(inflight)
        const f = m.get(frame.request_id)
        if (f) yield* Fiber.interrupt(f)
      }
    })),
  )
})
```

## Testing Requirements

- [ ] A fed-in `can_use_tool` request produces a `control_response` with `behavior:"deny", interrupt:true` and the matching `request_id`.
- [ ] A fed-in `mcp_message` request routes to the handler and emits a `control_response.success` with the handler's result.
- [ ] A `control_cancel_request` for an outstanding `mcp_message` handler interrupts the fiber; no `control_response` is sent for that ID.
- [ ] Handlers running concurrently don't interfere (two parallel `mcp_message` calls each produce their own response).
- [ ] Handler that fails returns `control_response.error`.

## Out of Scope

- The `initialize` control-request flow (from Symphony to CLI). The CLI's streaming mode does this transparently; we don't need to send it. Document this clearly.
- MCP `resources/list` / `prompts/list` methods — the Python SDK doesn't implement them and the spec's `linear_graphql` extension only needs `tools/list` + `tools/call`.
- A retry policy for handler failures. If `linear_graphql` fails, the tool result reports failure to Claude; Claude decides what to do.
