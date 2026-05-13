# Application wiring and startup

## Objective

Wire all Layers together in `main.ts`, parse the CLI, do startup terminal-workspace cleanup (§8.6), handle SIGINT/SIGTERM for coordinated shutdown, and exit with the correct codes per §17.7.

## Context

### Parent PRD

- **PRD**: Symphony v1 (Effect.ts + Claude Code)
- **PRD Path**: `.claude/prds/symphony-v1/PRD.md`

### Related Tasks

- **Depends on**: every other implementation task (this is the integrator).
- **Blocks**: only the test matrix.

## Acceptance Criteria

- [ ] CLI parsing per §17.7:
  - `bun run src/main.ts <path-to-WORKFLOW.md>` — positional argument is the workflow path.
  - `bun run src/main.ts` (no arg) — falls back to `./WORKFLOW.md` in cwd.
  - `--port <N>` — optional, overrides `server.port`.
  - Unknown args → exit non-zero with a clear usage message.
  - Nonexistent explicit path → exit non-zero with operator-visible error (§17.7 bullet).
  - Missing default `./WORKFLOW.md` → exit non-zero (§17.7 bullet).
- [ ] Layer composition (per PRD §Architecture's service graph):
  ```ts
  const AppLayer = Layer.mergeAll(
    LoggerLive, ClockLive, FileSystemLive,
  ).pipe(
    Layer.provideMerge(ConfigLive),
    Layer.provideMerge(WorkflowLoaderLive),
    Layer.provideMerge(LinearClientLive),
    Layer.provideMerge(WorkspaceManagerLive),
    Layer.provideMerge(WorkspaceHooksLive),
    Layer.provideMerge(SandboxLive),
    Layer.provideMerge(McpServerLive),
    Layer.provideMerge(OrchestratorLive),
    Layer.provideMerge(HttpServerLive),  // conditional inside the layer
  )
  ```
- [ ] Startup sequence (per §16.1):
  1. Load + validate workflow. If invalid → log + exit non-zero.
  2. Run startup terminal-workspace cleanup: fetch terminal-state issues via `LinearClient.fetchIssuesByStates(config.tracker.terminal_states)`, then `WorkspaceManager.startupTerminalCleanup(identifiers)`. On fetch failure: log warning and continue (§8.6).
  3. Run the orchestrator's first tick immediately, then continue at `polling.interval_ms` cadence.
- [ ] Shutdown sequence (on SIGINT / SIGTERM):
  - Catch signals, resolve a `Deferred<void, never>` the main fiber is blocked on.
  - The Layer scope closes; all forked fibers (tick, retry timers, running workers, HTTP listener, workflow watcher) are interrupted.
  - Worker fibers' interrupt should cause graceful claude-subprocess shutdown (stdin close → 5s grace → SIGTERM → 5s → SIGKILL).
  - Cap total shutdown at e.g. 15s; if not done, exit with a warning.
- [ ] Exit codes (per §17.7):
  - 0 on clean shutdown (SIGINT/SIGTERM-driven).
  - Non-zero on startup failure or abnormal exit.
- [ ] A 2-line `main.ts` header comment.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `src/main.ts` | Edit | Replace the bootstrap-task stub with the full wiring. |
| `src/cli.ts` | Create | Argv parsing (positional + `--port`). Pure function. |

### Technical Constraints

- Use Bun's `process.argv` (or `Bun.argv`); first two entries are the runtime + script path.
- Don't pull in a CLI library (commander/clap-style). The CLI is tiny — one positional + one `--port`. Hand-parse.
- `process.on('SIGINT', …)` and `process.on('SIGTERM', …)` are the signal hooks. Use `Effect.runFork(program)` and resolve a Deferred that `program` awaits.
- Effect provides `runMain` for similar use cases — use it if it has the right shutdown semantics.

### Relevant Code References

- Spec §16.1 (reference algorithm: `start_service`), §8.6 (startup cleanup), §17.7 (CLI behavior).
- PRD §Architecture → "Runtime shape", "Service graph", "Concurrency model".

## Testing Requirements

- [ ] No arg → looks for `./WORKFLOW.md`, fails clearly if missing.
- [ ] Existing `./WORKFLOW.md` (test fixture) → starts and exits cleanly on SIGTERM.
- [ ] Nonexistent explicit path → exits non-zero with stderr line referencing the missing file.
- [ ] `--port 0` → ephemeral HTTP server listening; healthcheck against `/api/v1/state` returns 200.
- [ ] Startup terminal cleanup is invoked once during boot (observed via spy/log).
- [ ] SIGTERM during a fake long-running tick triggers shutdown within 15s.

## Out of Scope

- Daemonization (`launchd`, `systemd`). Operator runs `bun run` directly in v1.
- A `--help` / `--version` flag. Add later if needed.
- `--workflow` named alias for the positional. Positional only.
- An interactive mode. Not a TUI.
