# Nono sandbox service

## Objective

Build an Effect service that runs arbitrary commands inside `nono run` with a Symphony-curated policy. Used by `ClaudeRunner` to wrap each `claude` invocation and by `WorkspaceHooks` to wrap each hook script. Captures stdin/stdout/stderr properly and surfaces sandbox-denial failures as a typed error.

## Context

### Parent PRD

- **PRD**: Symphony v1 (Effect.ts + Claude Code)
- **PRD Path**: `.claude/prds/symphony-v1/PRD.md`

### Related Tasks

- **Depends on**: Bun + TypeScript + Effect setup, logger-service.md.
- **Blocks**: workspace-hooks.md, claude-subprocess-lifecycle.md.

## Acceptance Criteria

- [ ] `Sandbox` `Context.Tag` exposes one method:
  ```ts
  spawn(opts: SandboxSpawnOptions): Effect.Effect<SandboxProcess, SandboxError, Scope>
  ```
  Returns a `Scope`-bound handle the caller drives (stdin writer, stdout/stderr streams, exit-code Effect).
- [ ] `SandboxSpawnOptions` includes:
  - `command: string[]` — argv to run (no shell).
  - `cwd: AbsolutePath` — sandbox subject's cwd. Must be inside the granted filesystem set.
  - `policy: SandboxPolicy` — see below.
  - `env: Record<string, string>` — extra env vars (merged onto inherited).
  - `stdin: "pipe" | "inherit" | "null"` — default `"pipe"`.
- [ ] `SandboxPolicy` is a discriminated union with two variants:
  - `{ kind: "agent_runner"; workspace: AbsolutePath; workflow_dir: AbsolutePath; network_profile: string; credentials: ReadonlyArray<string>; claude_home_access: "read" | "allow" }` — for `claude` invocations. The `claude_home_access` axis depends on `agent_runner.bare`:
    - `"read"` (when `bare === true`) → `--read ~/.claude` (token store is not mutated; auth comes from injected `ANTHROPIC_API_KEY` env). `credentials` SHOULD include `"anthropic"`.
    - `"allow"` (when `bare === false`) → `--allow ~/.claude` so the CLI can refresh OAuth tokens on 401 (a documented mid-session behavior). `credentials` SHOULD be empty (no keystore injection; auth lives in `~/.claude/`).
    Maps to:
    `nono run --network-profile <network_profile> [--credential <c> …] --allow <workspace> --read <workflow_dir> [--read|--allow] ~/.claude --read /usr/bin --read /bin --read /usr/local/bin --read /opt/homebrew -- <command>`.
  - `{ kind: "hook"; workspace: AbsolutePath; workflow_dir: AbsolutePath; profile: string }` — for hooks. Maps to:
    `nono run --profile <profile> --allow <workspace> --read <workflow_dir> -- <command>`.
- [ ] Supervised mode only (`nono run`), not `nono wrap`. See `research/nono-sh.md` for rationale.
- [ ] Stderr captured separately and streamed to the caller; on `SandboxDenied` failure (best-effort detection: looking for nono's denial line on stderr or a specific non-zero exit code), surface a `SandboxError.AccessDenied` with the denied syscall / path included in the message.
- [ ] On signal-driven shutdown of the parent Effect's scope, send SIGTERM to the nono process and wait up to a configurable grace (5s default), then SIGKILL.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `src/sandbox/Nono.ts` | Create | The Sandbox service Tag + Live Layer + argv builder + signal handling. |
| `src/sandbox/policies.ts` | Create | Pure functions that turn `SandboxPolicy` into `string[]` argv prefixes. |

### Technical Constraints

- Use `@effect/platform`'s `CommandExecutor` (or `Bun.spawn` directly) — pick one and stick with it. `CommandExecutor` integrates naturally with Effect.
- Don't pass anything through a shell. The argv builder constructs the full `nono run -- <command…>` array with no shell interpolation.
- The base filesystem `--read` set (`/usr/bin`, `/bin`, `/usr/local/bin`, `/opt/homebrew`) is hard-coded in `policies.ts` for the `agent_runner` policy. The `~/.claude` grant is conditional (read-only when `bare`, read+write when not). Document the rationale in TRUST.md.
- `--credential anthropic` is passed to nono only when `agent_runner.bare === true` (which mandates an env-var-shaped key). When `bare === false`, the CLI reads OAuth tokens from `~/.claude/` directly and no keystore injection is needed.
- Verify the env var name the nono `anthropic` preset injects (expected: `ANTHROPIC_API_KEY`); document if different.

### Relevant Code References

- `research/nono-sh.md` (whole document; especially "Symphony invocation pattern" and "CLI reference (relevant subset)").
- PRD §Architecture → "Sandbox integration".
- Spec §15 (Security and Operational Safety), §15.4 (hook trust).

### Code Examples

```ts
// Sketch of agent_runner argv build
function agentRunnerArgv(policy: { workspace; workflow_dir; network_profile; credentials }, command: string[]): string[] {
  const args = ["run", "--network-profile", policy.network_profile]
  for (const c of policy.credentials) args.push("--credential", c)
  args.push("--allow", policy.workspace)
  args.push("--read", policy.workflow_dir)
  args.push("--read", path.join(os.homedir(), ".claude"))
  args.push("--read", "/usr/bin", "--read", "/bin", "--read", "/usr/local/bin", "--read", "/opt/homebrew")
  return ["nono", ...args, "--", ...command]
}
```

## Testing Requirements

- [ ] `agentRunnerArgv` with `claude_home_access: "read"` + `credentials: ["anthropic"]` builds the expected `--bare`-compatible argv (snapshot).
- [ ] `agentRunnerArgv` with `claude_home_access: "allow"` + `credentials: []` builds the OAuth-compatible argv (snapshot).
- [ ] `hookArgv` builds the expected argv.
- [ ] Spawn with `--dry-run` confirms both policies are parseable by `nono`.
- [ ] Stdin pipe round-trip: write a JSON line, read it back via `cat` (sanity test).
- [ ] Scope cancellation terminates the child process within 5s.

## Out of Scope

- Inspecting nono's effective policy (the `claude-code` profile contents). Treat as a black box.
- The Python/TypeScript in-process Nono SDK. We use the CLI path only.
- Adding new network profiles to nono. Symphony uses the built-ins.
