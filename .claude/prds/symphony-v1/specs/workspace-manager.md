# Workspace creation and reuse

## Objective

Implement `WorkspaceManager` as an Effect service that maps each issue identifier to a deterministic per-issue workspace path, creates the directory idempotently, enforces the §9.5 invariants, and exposes terminal-state cleanup. This is the workspace half of §9; hooks are a sibling task.

## Context

### Parent PRD

- **PRD**: Symphony v1 (Effect.ts + Claude Code)
- **PRD Path**: `.claude/prds/symphony-v1/PRD.md`

### Related Tasks

- **Depends on**: path-safety.md, workflow-loader-and-watch.md, logger-service.md.
- **Blocks**: workspace-hooks.md, orchestrator-state.md, application-wiring.md.

## Acceptance Criteria

- [ ] `Context.Tag<WorkspaceManager>` with methods:
  - `prepareForIssue(issue: Issue): Effect<Workspace, WorkspaceError>` — returns `{ path, workspace_key, created_now }`. Idempotent.
  - `cleanWorkspaceFor(identifier: string): Effect<void, WorkspaceError>` — used by §8.6 terminal cleanup and §8.5 reconciliation on terminal-state transition.
  - `startupTerminalCleanup(identifiers: ReadonlyArray<string>): Effect<void>` — sweep called once at startup (§8.6).
- [ ] `prepareForIssue` algorithm (§9.2):
  1. Sanitize identifier via `PathSafety.sanitizeWorkspaceKey`.
  2. Compute path via `PathSafety.resolveWorkspacePath(config.workspace.root, identifier)`.
  3. Run `PathSafety.assertUnderRoot`.
  4. Use `mkdir` with `recursive: true`. Detect "created" vs "already existed" via a pre-check: stat, if `ENOENT` → create + `created_now=true`; if dir exists → `created_now=false`; if non-dir → fail with `NonDirectoryAtWorkspacePath` (caller decides policy per §17.2 bullet "Existing non-directory path at workspace location is handled safely").
  5. If `created_now === true`, the caller (orchestrator dispatch) is responsible for invoking `after_create` via WorkspaceHooks. (Splitting hook execution out keeps this service stateless about run lifecycle.)
- [ ] `cleanWorkspaceFor`: `rm -rf` the per-issue workspace directory. Guard with `assertUnderRoot` before deleting. The `before_remove` hook is the WorkspaceHooks service's job, called by the caller before this method.
- [ ] `startupTerminalCleanup(identifiers)`: for each identifier, call `cleanWorkspaceFor` best-effort (log + continue on failure, per §8.6).
- [ ] Errors: `WorkspaceCreationFailed`, `PathEscape` (relayed from PathSafety), `NonDirectoryAtWorkspacePath`, `CleanupFailed`. All `Data.TaggedError`.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `src/workspace/WorkspaceManager.ts` | Create | Service Tag + Live Layer + error types + Workspace record. |

### Technical Constraints

- Reads `workspace.root` via `WorkflowLoader.current` on every call (not at Layer init), so a dynamic reload that changes the root is honored on the next dispatch (§6.2).
- Workspaces are never auto-deleted on successful run (§9.1: *"Workspaces are reused across runs for the same issue. Successful runs do not auto-delete workspaces."*). Deletion happens only via terminal-cleanup paths.
- `rm -rf` implementation: prefer `node:fs/promises rm(path, { recursive: true, force: true })`. Wrap in `Effect.tryPromise`.
- Path-safety check before EVERY filesystem mutation. No exceptions.

### Relevant Code References

- Spec §9.1 (workspace layout), §9.2 (creation/reuse), §9.5 (invariants), §8.6 (startup sweep), §17.2 (test bullets).
- `path-safety.md` — the validators this calls.

## Testing Requirements

- [ ] First `prepareForIssue("MT-1")` creates the directory and returns `created_now=true`.
- [ ] Second `prepareForIssue("MT-1")` reuses; `created_now=false`.
- [ ] Sanitization happens (identifier `foo/bar` becomes workspace key `foo_bar`).
- [ ] `prepareForIssue` on an identifier whose resolved path escapes root fails with `PathEscape`. (Belt-and-suspenders; sanitization should prevent.)
- [ ] Non-directory at workspace location yields `NonDirectoryAtWorkspacePath`.
- [ ] `cleanWorkspaceFor` removes the directory tree.
- [ ] `cleanWorkspaceFor` on a path outside root rejects without deleting.
- [ ] `startupTerminalCleanup` skips and logs on individual failures, continues with the rest.

## Out of Scope

- Hook execution (separate task: workspace-hooks.md).
- Repository/VCS bootstrap (§9.3 explicitly: "implementation-defined; typically handled via hooks"). v1 doesn't ship a built-in.
- Disk-space monitoring or workspace quota enforcement.
- Locking semantics for the workspace directory. The orchestrator's single-authority claim prevents concurrent access by design.
