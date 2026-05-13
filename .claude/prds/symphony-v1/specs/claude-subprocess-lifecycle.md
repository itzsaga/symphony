# Claude subprocess lifecycle

## Objective

Spawn the `claude` CLI (via the `Sandbox` service) in streaming stream-json mode, manage the bidirectional stdin/stdout JSONL pipe, capture stderr separately, parse incoming frames with the StreamJson schemas, and shut down gracefully on scope close. Does NOT yet implement the §10.4 event mapping or the control-protocol RPC — those live in sibling tasks.

## Context

### Parent PRD

- **PRD**: Symphony v1 (Effect.ts + Claude Code)
- **PRD Path**: `.claude/prds/symphony-v1/PRD.md`

### Related Tasks

- **Depends on**: nono-sandbox-service.md, claude-stream-json-schemas.md, logger-service.md, path-safety.md.
- **Blocks**: claude-control-protocol.md (which mounts the RPC handler on this pipe), claude-event-mapping.md (which consumes the parsed frames).

## Acceptance Criteria

- [ ] `ClaudeSubprocess` `Context.Tag` (or a per-call `Effect.acquireRelease` resource) exposing:
  - `incoming: Stream<StreamJsonMessage>` — parsed frames from stdout. Forward-compat: unknown frames are logged + dropped.
  - `outgoing: Queue<OutboundFrame>` — frames Symphony sends to stdin. Backpressured.
  - `stderr: Stream<string>` — line-by-line stderr.
  - `awaitExit: Effect<{ code: number; signal: string | null }>` — resolves when the subprocess terminates.
- [ ] Construction (`spawn(opts: ClaudeSpawnOptions)`):
  - Builds the CLI argv per `research/claude-stream-json.md` §1 "Recommended Symphony invocation":
    ```
    claude [--bare]
           --output-format stream-json --verbose --input-format stream-json
           --permission-mode bypassPermissions
           --permission-prompt-tool stdio
           --add-dir <workspace>
           --mcp-config <mcp-config-json-or-path>
           [--resume <prior_session> [--fork-session]]
           [--session-id <uuid>]
           --max-turns <max_turns>
           [--include-partial-messages]
           [...extra_args]
    ```
  - **`--bare` is conditional on `config.agent_runner.bare`** (default `false`):
    - `bare === true`: include `--bare`. CLI ignores `~/.claude`, project `.mcp.json`, hooks, skills, plugins, auto memory, and CLAUDE.md. Auth MUST come from `ANTHROPIC_API_KEY` in the subprocess env. Reproducible across machines. Recommended for unattended/remote deployments.
    - `bare === false`: omit `--bare`. CLI reads `~/.claude/` for OAuth tokens — operator runs `claude /login` once and the daemon reuses the session. Also picks up whatever else is in `~/.claude` (auto memory, user CLAUDE.md, etc.) — operator's responsibility to keep that clean. Recommended for local development.
  - Wraps in `Sandbox.spawn` with `kind: "agent_runner"` policy. The policy's `claude_home_access` and `credentials` axes track the `bare` flag (see `nono-sandbox-service.md`): bare → `read`/inject keystore; non-bare → `allow`/no injection (so OAuth refresh writes succeed).
  - Sets `cwd = workspace.path`. Calls `PathSafety.assertCwdMatches(expected, actual)` before launch (§9.5 invariant 1, defense-in-depth: the sandbox enforces too).
  - Sets env: `CLAUDE_CODE_ENTRYPOINT=symphony`, `CLAUDE_AGENT_SDK_CLIENT_APP=symphony/<version>`, filters out `CLAUDECODE` (avoids the leak documented in `research/claude-stream-json.md` §1, issue #573).
- [ ] Stdout parsing:
  - Buffer-and-parse line-delimited JSON with a buffer-overflow ceiling (default 1 MiB per frame per `research/claude-stream-json.md` §9). Non-JSON lines (e.g. `[SandboxDebug]`) logged at debug, dropped.
  - Each parsed frame goes through `Schema.decodeUnknown(StreamJsonMessage)`. Decode failures count as `malformed` for §10.4 event mapping and are logged at warn — but stream continues.
  - Output frames emitted as `Stream`.
- [ ] Outbound writes:
  - Each `OutboundFrame` is `JSON.stringify`'d, terminated with `\n`, written to stdin. Writes are serialized through the queue's consumer.
- [ ] Stderr captured into a separate `Stream<string>` (line-buffered).
- [ ] Graceful shutdown (on scope close):
  - `outgoing.shutdown()` + `process.stdin.end()`.
  - Wait up to 5s for the process to exit on its own.
  - If still alive: `kill(SIGTERM)`. Wait 5s more.
  - If still alive: `kill(SIGKILL)`.
  - This sequence is mandatory — the CLI needs time to flush its session file (`research/claude-stream-json.md` §8 / issue #625).
- [ ] Errors: `ClaudeNotFound`, `InvalidWorkspaceCwd`, `SubprocessSpawnFailed`, `StreamDecodeError`, `SubprocessExited` (with code).
- [ ] CLI version check on startup: run `claude --version` (or read it from the first `system.init` frame's `model` field if surfaced); if `< 2.0.0` per `research/claude-stream-json.md` §1, fail spawn. Defer to integration test if static detection is unreliable.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `src/claude/ClaudeSubprocess.ts` | Create | The spawn primitive + scope handling + stream parser. |
| `src/claude/argv.ts` | Create | Pure argv-builder function (testable in isolation). |
| `src/claude/jsonlParser.ts` | Create | Line-delimited JSON parser with multi-line accumulator + buffer-size cap. |

### Technical Constraints

- Use the `Sandbox` service to spawn; never `Bun.spawn` directly here.
- The JSONL parser handles the SDK-documented case where the CLI emits multi-line pretty-printed JSON: accumulate bytes until a top-level object parses (`research/claude-stream-json.md` §1, `subprocess_cli.py:632-686`).
- Backpressure on the outgoing queue protects against scenarios where the CLI stalls reading stdin (e.g. during a long tool call).
- Don't lose the last frame: drain incoming stream until EOF after the process exits, in case the CLI flushes a final `result` between SIGTERM signal and actual exit.

### Relevant Code References

- `research/claude-stream-json.md` §1 (flags), §2 (frame types), §8 (subprocess lifetime), §9 (failure modes).
- `claude-stream-json-schemas.md` — the schemas this parser feeds.
- `nono-sandbox-service.md` — `Sandbox.spawn` contract.
- Spec §10.1 (Launch Contract), §10.6 (Timeouts and Error Mapping).

### Code Examples

```ts
// Sketch
const spawn = (opts: ClaudeSpawnOptions) => Effect.acquireRelease(
  Effect.gen(function*() {
    yield* PathSafety.assertCwdMatches(opts.workspace.path, opts.workspace.path)
    const argv = buildClaudeArgv(opts)
    const sandbox = yield* Sandbox
    const proc = yield* sandbox.spawn({
      command: argv,
      cwd: opts.workspace.path,
      policy: { kind: "agent_runner", workspace: opts.workspace.path, workflow_dir: …, network_profile: opts.config.agent_runner.network_profile, credentials: ["anthropic"] },
      env: { CLAUDE_CODE_ENTRYPOINT: "symphony", … },
      stdin: "pipe",
    })
    // wire stdout → jsonlParser → Stream<StreamJsonMessage>
    // wire stderr → Stream<string>
    // wire outgoing Queue → stdin writes
    return { incoming, outgoing, stderr, awaitExit }
  }),
  ({ proc, awaitExit }) => gracefulShutdown(proc, awaitExit),
)
```

## Testing Requirements

- [ ] argv builder with `bare: true` includes `--bare` (snapshot test).
- [ ] argv builder with `bare: false` omits `--bare` (snapshot test).
- [ ] argv builder routes `bare` into the Sandbox policy's `claude_home_access` axis correctly (bare → `"read"` + `credentials: ["anthropic"]`; non-bare → `"allow"` + `credentials: []`).
- [ ] JSONL parser handles single-line JSON, multi-line pretty-printed JSON, and dropped non-JSON lines.
- [ ] Buffer overflow surfaces `StreamDecodeError`.
- [ ] Graceful shutdown sequence is exercised against a stub child process that takes 3s to exit on its own (should exit cleanly without SIGTERM).
- [ ] Forced shutdown sequence is exercised against a stub that ignores SIGTERM (should SIGKILL after total grace).
- [ ] Path-safety failure (cwd mismatch) prevents spawn.

## Out of Scope

- Control-protocol RPC (separate task).
- Mapping frames to §10.4 events (separate task).
- The MCP server hosting (separate task; the `--mcp-config` value is passed in by the caller).
- Multi-subprocess pools. One subprocess per worker run.
