# Lifecycle hooks execution

## Objective

Implement `WorkspaceHooks` as an Effect service that runs the four workflow lifecycle hooks (`after_create`, `before_run`, `after_run`, `before_remove`) inside the nono sandbox, with timeout, with the workspace directory as cwd, and with failure semantics per §9.4.

## Context

### Parent PRD

- **PRD**: Symphony v1 (Effect.ts + Claude Code)
- **PRD Path**: `.claude/prds/symphony-v1/PRD.md`

### Related Tasks

- **Depends on**: nono-sandbox-service.md, workspace-manager.md, workflow-loader-and-watch.md, logger-service.md.
- **Blocks**: orchestrator-state.md (orchestrator dispatch composes WorkspaceManager + Hooks + ClaudeRunner).

## Acceptance Criteria

- [ ] `Context.Tag<WorkspaceHooks>` with methods:
  - `runAfterCreate(workspace: Workspace): Effect<void, HookError>` — only called when `Workspace.created_now === true`.
  - `runBeforeRun(workspace: Workspace): Effect<void, HookError>`
  - `runAfterRun(workspace: Workspace): Effect<void, never>` — failures swallowed + logged.
  - `runBeforeRemove(workspace: Workspace): Effect<void, never>` — failures swallowed + logged.
- [ ] Each method:
  - Reads the corresponding script string from `WorkflowLoader.current`.
  - If null/empty, no-ops successfully.
  - Otherwise spawns via `Sandbox.spawn` with `kind: "hook"` policy. Command is `["bash", "-lc", script]`. Cwd is `workspace.path`.
  - Applies a timeout of `config.hooks.timeout_ms` (default 60,000 ms). Timeout treated as failure for `after_create` / `before_run`, ignored for `after_run` / `before_remove`.
  - Logs hook start, stdout/stderr (truncated to a few KB per §15.4), exit code, duration.
- [ ] Failure semantics (§9.4):
  - `after_create` failure or timeout → `HookError.AfterCreateFailed` — caller (WorkspaceManager) must consider this fatal to workspace creation; partial workspace MAY be cleaned up at caller discretion.
  - `before_run` failure or timeout → `HookError.BeforeRunFailed` — fatal to current attempt; caller fails the run.
  - `after_run` failure or timeout → log only, return success.
  - `before_remove` failure or timeout → log only, return success; cleanup proceeds.
- [ ] Hooks run inside `nono run --profile developer …` by default (so `git clone` / `bun install` etc. work), but the profile is configurable per workflow via a future `hooks.sandbox_profile` field (out of scope for v1; document as a TODO).

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `src/workspace/Hooks.ts` | Create | Service Tag + Live Layer + per-hook methods + error types. |

### Technical Constraints

- Hook output is captured; the first ~4 KB of stdout and ~4 KB of stderr go into the failure log entry. Larger output is truncated (§15.4 guidance).
- Per-hook timeout is enforced via Effect's `Effect.timeout` combinator wrapping the sandbox spawn.
- The hook script is passed to `bash -lc <script>` — preserves login-shell behavior and pipelines per §9.4. Don't shell-escape; the script is opaque content the user wrote.
- `WORKFLOW.md` hooks are fully trusted configuration (§15.4). The sandbox is defense-in-depth, not a trust gate.

### Relevant Code References

- Spec §9.4 (execution contract + failure semantics), §15.4 (hook trust).
- `nono-sandbox-service.md` — the `kind: "hook"` policy this uses.
- `workspace-manager.md` — `Workspace` record this consumes.

### Code Examples

```ts
// Sketch
const runBeforeRun = (workspace: Workspace) => Effect.gen(function*() {
  const wf = yield* WorkflowLoader
  const def = yield* wf.current
  if (def.config.hooks.before_run == null) return
  const sandbox = yield* Sandbox
  const proc = yield* sandbox.spawn({
    command: ["bash", "-lc", def.config.hooks.before_run],
    cwd: workspace.path,
    policy: { kind: "hook", workspace: workspace.path, workflow_dir: …, profile: "developer" },
    stdin: "null",
  })
  yield* proc.exit.pipe(Effect.timeout(`${def.config.hooks.timeout_ms} millis`))
})
```

## Testing Requirements

- [ ] `runBeforeRun` with no hook configured: succeeds, no spawn.
- [ ] `runBeforeRun` with a passing hook: succeeds, log entry recorded.
- [ ] `runBeforeRun` with a failing hook (`exit 1`): fails with `BeforeRunFailed`, error includes the hook's truncated output.
- [ ] `runBeforeRun` with a timeout-exceeding hook: fails with `BeforeRunFailed.Timeout`.
- [ ] `runAfterRun` with a failing hook: returns success; warning logged.
- [ ] Hook cwd is the workspace directory (test: hook writes `$PWD` to a file and we check it).

## Out of Scope

- Per-hook sandbox profile override (deferred until proven needed).
- Hook output retention beyond the truncated log entry (no `~/.symphony/hooks/<issue>/<hook>.log` files in v1).
- Cancellation of an in-flight hook on orchestrator shutdown beyond the sandbox's own SIGTERM grace.
