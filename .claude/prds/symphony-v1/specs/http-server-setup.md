# HTTP server setup and port handling

## Objective

Stand up the `@effect/platform` HTTP server with the spec §13.7 port-handling and bind semantics. The server itself is conditional on `server.port` (or CLI `--port`) being set; if neither is set, this task's Layer is a no-op.

## Context

### Parent PRD

- **PRD**: Symphony v1 (Effect.ts + Claude Code)
- **PRD Path**: `.claude/prds/symphony-v1/PRD.md`

### Related Tasks

- **Depends on**: Bun + TypeScript + Effect setup, workflow-loader-and-watch.md, logger-service.md.
- **Blocks**: http-api-and-dashboard.md (which defines the routes).

## Acceptance Criteria

- [ ] `HttpServer` Layer mounted conditionally:
  - If neither CLI `--port` nor `server.port` is set: no server starts.
  - If both set: CLI `--port` wins (§13.7 "CLI `--port` overrides `server.port`").
  - `port === 0`: bind to an ephemeral port; log the chosen port at startup.
  - Positive port: bind that port.
- [ ] Bind address: loopback by default (`127.0.0.1`). Configurable later but v1 hardcodes loopback per §13.7 "Implementations SHOULD bind loopback by default".
- [ ] Use `@effect/platform`'s `HttpServer` with the Bun adapter (or whatever this stack provides). Construct it inside a `Layer.scoped` so the listener is torn down on shutdown.
- [ ] Logger integration: every request logs a single JSONL line at info level with method, path, status, duration_ms.
- [ ] Port changes via `WorkflowLoader.changes` do NOT hot-rebind. §13.7: "Changes to HTTP listener settings (for example server.port) do not need to hot-rebind; restart-required behavior is conformant." Log a warn that the change won't take effect until restart.
- [ ] CLI `--port <N>` is parsed in `application-wiring.md` and surfaced via a `CliFlags` service this Layer reads from.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `src/http/Server.ts` | Create | The Layer + the routing-stub that http-api-and-dashboard.md plugs into. |

### Technical Constraints

- Use `@effect/platform-bun`'s HTTP server (or `@effect/platform-node` if Bun adapter is unavailable; Bun is Node-compat for `http` module).
- Listener errors (port in use, permission denied) surface as `HttpServerError` and cause startup failure with operator-visible log. Don't crash silently.
- Don't enable CORS in v1. Loopback-only; same-origin assumed.
- Set `server.headersTimeout` to a reasonable value (e.g. 5s) to limit slowloris-style hangs.

### Relevant Code References

- Spec §13.7 (HTTP server extension, especially "Enablement (extension)", "Implementations SHOULD bind loopback by default").
- `workflow-loader-and-watch.md` — port config source.

## Testing Requirements

- [ ] No port set → server doesn't start; no listener fd opened.
- [ ] `--port 8080` overrides `server.port = 9090`.
- [ ] `port = 0` binds and logs the ephemeral port.
- [ ] Listener tears down when the Layer scope closes.
- [ ] Workflow reload that changes `server.port` produces a warn log; old port still listening.

## Out of Scope

- TLS / HTTPS.
- Auth on the dashboard. Loopback bind is the auth boundary.
- Bind address configurability.
- Hot-rebinding the listener on port change.
