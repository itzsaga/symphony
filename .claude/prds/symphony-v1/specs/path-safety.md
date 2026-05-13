# Path safety invariants

## Objective

Implement the three §9.5 invariants as pure, testable functions used everywhere workspaces are addressed: workspace key sanitization, workspace-path-inside-root containment check, and absolute cwd validation before agent launch. These are the spec's "most important portability constraint".

## Context

### Parent PRD

- **PRD**: Symphony v1 (Effect.ts + Claude Code)
- **PRD Path**: `.claude/prds/symphony-v1/PRD.md`

### Related Tasks

- **Depends on**: Bun + TypeScript + Effect setup.
- **Blocks**: workspace-manager.md, workspace-hooks.md, claude-subprocess-lifecycle.md (each calls the validators before launch).

## Acceptance Criteria

- [ ] `sanitizeWorkspaceKey(identifier: string): string` — replaces every character not in `[A-Za-z0-9._-]` with `_`. Pure.
- [ ] `resolveWorkspacePath(root: AbsolutePath, identifier: string): AbsolutePath` — returns `path.join(root, sanitizeWorkspaceKey(identifier))`. Asserts result is still under `root`.
- [ ] `assertCwdMatches(expected: AbsolutePath, actual: AbsolutePath): Effect<void, InvalidWorkspaceCwd>` — invariant 1.
- [ ] `assertUnderRoot(root: AbsolutePath, candidate: AbsolutePath): Effect<void, PathEscape>` — invariant 2. Uses `path.resolve` to canonicalize before prefix check. Prefix check is *directory-aware* (`/foo` is not a prefix of `/foobar`).
- [ ] All functions reject relative paths with a typed error rather than silently resolving against cwd.
- [ ] A branded type `AbsolutePath = string & { readonly _brand: "AbsolutePath" }` is exported so the rest of the codebase can't accidentally pass a raw string.
- [ ] Symlink handling: do NOT auto-`realpath` the input; the spec says "Normalize both paths to absolute" but does not require following symlinks. Reject if the candidate's parent path contains a symlink that points outside `root` (best-effort: `fs.realpath` and re-check). This guards against the basic symlink-escape attack.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `src/config/PathSafety.ts` | Create | All four functions + the `AbsolutePath` brand + error types. |

### Technical Constraints

- Pure module. No Effect dependency for the synchronous parts (sanitize, resolve); only `assertCwdMatches`/`assertUnderRoot` are `Effect` because they're checks at runtime boundaries that should emit typed errors.
- Use `node:path` (Bun has node compat).
- Errors: `InvalidWorkspaceCwd`, `PathEscape`, `RelativePathNotAllowed`. Use `Data.TaggedError`.

### Relevant Code References

- Spec §9.5 (the three invariants), §4.2 ("Workspace Key" derivation rule).
- PRD §Architecture → "Path safety invariants are enforced before every agent launch and every hook execution".

### Code Examples

```ts
declare const __brand: unique symbol
export type AbsolutePath = string & { readonly [__brand]: "AbsolutePath" }

export const sanitizeWorkspaceKey = (id: string): string =>
  id.replace(/[^A-Za-z0-9._-]/g, "_")

export const resolveWorkspacePath = (
  root: AbsolutePath,
  identifier: string,
): AbsolutePath => {
  const key = sanitizeWorkspaceKey(identifier)
  const resolved = path.resolve(root, key)
  // Invariant: resolved must start with root + separator.
  // (asserted unconditionally; sanitization should make this impossible to fail.)
  return resolved as AbsolutePath
}
```

## Testing Requirements

- [ ] `sanitizeWorkspaceKey("MT-649")` → `"MT-649"` (unchanged).
- [ ] `sanitizeWorkspaceKey("../escape")` → `".._escape"`.
- [ ] `sanitizeWorkspaceKey("foo bar/baz")` → `"foo_bar_baz"`.
- [ ] `assertUnderRoot("/tmp/ws", "/tmp/ws-other")` rejects with `PathEscape` (directory-aware prefix check).
- [ ] `assertUnderRoot("/tmp/ws", "/tmp/ws/abc")` accepts.
- [ ] `assertCwdMatches` rejects when paths differ even by trailing slash (after normalization).
- [ ] A `..` in the identifier never escapes the root (composition test of sanitize + resolve + assertUnderRoot).

## Out of Scope

- Filesystem permission enforcement (`chmod` etc.). The sandbox layer (nono) handles that.
- Atomic move semantics. WorkspaceManager handles directory creation.
- Validating that `root` itself exists / is writable. That's the WorkspaceManager's job.
