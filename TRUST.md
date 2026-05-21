# TRUST.md

Per Symphony spec §15.1, an implementation MUST state its trust posture
clearly; per §10.5, it MUST document its approval and user-input policy.
This file is that statement.

## 1. Trust model summary

Symphony is built for a **trusted single-operator environment**: one
human runs the daemon against their own Linear project on their own
machine. The safety boundary is the **OS-level sandbox** (`nono run`)
wrapping every `claude` invocation and every workflow hook, *not* the
agent's in-CLI approval prompts. If the sandbox is doing its job,
prompt-level approvals add friction without safety; if it isn't,
prompt-level approvals are not what's going to save us.

## 2. Sandbox profile

Every `claude` invocation goes through `nono run …` with the
`agent_runner` policy. Hooks use the `hook` policy. Both are built by
pure functions in [`src/sandbox/policies.ts`](src/sandbox/policies.ts);
the exact argv is asserted by
[`test/unit/sandbox/policies.test.ts`](test/unit/sandbox/policies.test.ts).

### 2.1 `agent_runner` policy — `bare: true` (reproducible / unattended)

```
nono run --network-profile claude-code --credential anthropic \
         --allow <workspace> --read <workflow_dir> \
         --read ~/.claude \
         --read /usr/bin --read /bin --read /usr/local/bin --read /opt/homebrew \
  -- claude --bare …
```

### 2.2 `agent_runner` policy — `bare: false` (local OAuth, v1 default)

```
nono run --network-profile claude-code \
         --allow <workspace> --read <workflow_dir> \
         --allow ~/.claude \
         --read /usr/bin --read /bin --read /usr/local/bin --read /opt/homebrew \
  -- claude …
```

Differences and rationale:

- `--credential anthropic` is emitted only when `agent_runner.bare` is
  `true`. In bare mode the CLI ignores `~/.claude` at runtime and
  authenticates from `ANTHROPIC_API_KEY`, which `nono` injects from the
  system keystore. In non-bare mode the CLI reads OAuth tokens out of
  `~/.claude/` (whatever `claude /login` deposited), so no keystore
  injection is needed.
- `~/.claude` is mounted **read-only** in bare mode (the CLI doesn't
  write there) and **read+write** (`--allow`) in non-bare mode so the
  CLI can persist OAuth-token refreshes on 401.
- The four system-bin reads (`/usr/bin`, `/bin`, `/usr/local/bin`,
  `/opt/homebrew`) are hard-coded in
  [`AGENT_RUNNER_BASE_READS`](src/sandbox/policies.ts) so Claude's tool
  subprocesses can find executables. Order matches the constant.

What the sandbox allows:

- Filesystem: read+write on the per-issue workspace; read on the workflow
  directory, `~/.claude` (with write in non-bare mode), and the four
  system bin paths above.
- Network: whatever the `claude-code` profile in `nono` permits
  (Anthropic API egress, calibrated upstream — see
  [`research/nono-sh.md`](.claude/prds/symphony-v1/research/nono-sh.md)).
  Hooks use the `developer` profile instead.

What the sandbox denies: everything else by default. We trust the
upstream `nono` profile authors for the exact contents of the
`claude-code` and `developer` profiles; that surface is opaque to us.

### 2.3 `hook` policy

```
nono run --profile <profile> --allow <workspace> --read <workflow_dir> -- <hook-cmd>
```

Default profile is `developer` (broader filesystem surface; needs `git
clone`, `bun install`, etc.). Per-workflow override is permitted.

## 3. Agent approval policy

Claude runs with `--permission-mode bypassPermissions
--permission-prompt-tool stdio` regardless of bare mode. Bypass mode
auto-grants tool calls; no `can_use_tool` requests should ever fire.

The stdio prompt-tool is defense-in-depth: if a request *does* fire
(future SDK change, hook downgrade), Symphony surfaces it as a §10.4
`turn_input_required` event and responds `{behavior:"deny",
interrupt:true}` to fail the turn. See
[`src/claude/ControlProtocol.ts`](src/claude/ControlProtocol.ts) and
[`src/claude/EventMapping.ts`](src/claude/EventMapping.ts).

With `--bare`, the CLI also ignores `~/.claude` / project auto-discovery
(hooks, skills, plugins, MCP servers, auto-memory, CLAUDE.md). The only
inputs Claude sees are what Symphony passed explicitly. **Without
`--bare`, the operator is responsible for keeping `~/.claude` tidy** —
anything you put there (rogue hooks, MCP servers, plugins) leaks into
every Symphony run.

## 4. User-input-required handling

Per spec §10.5: any `turn_input_required` event fails the run
immediately. Symphony does not surface to a human in v1. The
orchestrator's exponential-backoff retry (§8.4) handles transient
causes; permanent ones surface in the dashboard and structured log.

## 5. `linear_graphql` scoping

The MCP-exposed `linear_graphql` tool is bound to Symphony's configured
Linear API key and project. The agent can read/write **anything that
key permits on Linear**, including issues outside the configured
`tracker.project_slug`. v1 does NOT enforce project-level scoping at
the tool layer; spec §15.5 lists this as RECOMMENDED hardening and we
defer it. **Operators MUST provision API keys with the minimum scope
they're willing to grant the agent.**

## 6. Hook script trust assumption

Per spec §15.4: workflow hook scripts (`after_create`, `before_run`,
`after_run`, `before_remove`) are fully trusted configuration. They run
inside the sandbox so the blast radius is bounded, but the sandbox does
not protect against a malicious `WORKFLOW.md`. The operator owns
`WORKFLOW.md` and is responsible for its contents.

## 7. Spec divergences

Two intentional divergences from the Symphony Service Specification
Draft v1 (see [`SPEC.md`](SPEC.md) at the repo root):

- **Agent runner program — claude CLI replaces Codex `app-server`.**
  The `claude` CLI in stream-json streaming mode replaces `codex
  app-server` as the per-issue coding-agent subprocess. Same subprocess
  boundary, same `bash -lc <command>` launch contract, same
  `--input-format stream-json` / `--output-format stream-json` JSONL
  framing. The program and its event taxonomy differ; the wire-format
  mapping to spec §10.4 lives in
  [`research/claude-stream-json.md`](.claude/prds/symphony-v1/research/claude-stream-json.md)
  and is implemented in
  [`src/claude/EventMapping.ts`](src/claude/EventMapping.ts).
- **Front-matter namespace — `agent_runner.*` replaces `codex.*`.** The
  Codex-specific keys (`approval_policy`, `thread_sandbox`,
  `turn_sandbox_policy`) don't port to Claude Code; the schema is
  runner-agnostic to leave room for future kinds. A Codex `WORKFLOW.md`
  will not load as-is, by design.

## 8. Secret handling

- `tracker.api_key` resolves from env via `$VAR` indirection (or
  literal). Never logged; never exposed to Claude. The in-process MCP
  server uses it to back the `linear_graphql` tool but only surfaces
  the GraphQL result, not the key.
- Claude authentication has two modes (per `agent_runner.bare`):
  - **`bare: true`**: `ANTHROPIC_API_KEY` is injected by
    `nono --credential anthropic` from the system keystore. `--bare`
    disables Claude's OAuth/keychain reads, so this env-var path is
    required. Keystore injection keeps the key out of Symphony's
    process env and out of logs.
  - **`bare: false`** (v1 default): Claude reads OAuth tokens from
    `~/.claude/`. Symphony never touches these files. Token refresh on
    401 writes back via the `--allow ~/.claude` grant. Symphony's logs
    never contain the tokens.

## 9. What this implementation does NOT defend against

Honest list — these are real exposures, not hypothetical:

- **Prompt injection in issue descriptions / Linear comments.** Anything
  the API key can read becomes part of the prompt context. A malicious
  issue body can attempt to redirect the agent.
- **Malicious GraphQL responses.** A compromised Linear tenant or MITM
  on the API path can feed crafted data into the agent's view of the
  world. (Mitigated by TLS and the API key scope, not by Symphony.)
- **Supply-chain compromise of `claude`, `nono`, or `bun` themselves.**
  We pin versions via `flake.lock` and `bun.lock` but do not verify
  signatures. Trust your lockfiles.
- **Dependency hijacking via `bun install`.** The sandbox limits damage
  to the workspace; the host node_modules outside the sandbox is on
  you.
- **Operator mistakes in `WORKFLOW.md`.** Hooks are trusted code (§15.4).
  A misconfigured `before_run` is functionally a self-inflicted breach.
- **Anything in `~/.claude` in non-bare mode.** Hooks, skills, plugins,
  MCP servers, and auto-memory entries you put there are visible to
  every Symphony run.

v1 is not auditor-grade. It's a personal automation surface with a
sandbox as its safety boundary. Treat it accordingly.
