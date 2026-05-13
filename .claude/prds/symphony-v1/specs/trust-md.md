# TRUST.md

## Objective

Author `TRUST.md` at repo root. The Symphony spec §15.1 explicitly mandates implementations "state clearly" their trust posture, and §10.5 mandates documenting approval/user-input policy. This doc is the deliverable — *not* an afterthought (the spec literally calls this "part of the core safety model rather than an optional afterthought", §15.5).

## Context

### Parent PRD

- **PRD**: Symphony v1 (Effect.ts + Claude Code)
- **PRD Path**: `.claude/prds/symphony-v1/PRD.md`

### Related Tasks

- **Depends on**: nono-sandbox-service.md (so the actual policy strings exist), agents-md.md (for cross-reference patterns).
- **Blocks**: nothing technically, but conformance is incomplete without this.

## Acceptance Criteria

- [ ] `TRUST.md` exists at repo root. Sections:
  1. **Trust model summary** — One-paragraph statement: Symphony is built for a trusted single-operator environment; the safety boundary is the OS-level sandbox (`nono`), not the agent's in-CLI approval prompts.
  2. **Sandbox profile** — The exact `nono run` policy this implementation uses for `claude` invocations. Two argv-shapes depending on `agent_runner.bare`:

     **`bare: true` (reproducible / unattended posture):**
     ```
     nono run --network-profile claude-code --credential anthropic \
              --allow <workspace> --read <workflow_dir> --read ~/.claude \
              --read /usr/bin --read /bin --read /usr/local/bin --read /opt/homebrew \
       -- claude --bare …
     ```

     **`bare: false` (local-OAuth / interactive posture, the v1 default):**
     ```
     nono run --network-profile claude-code \
              --allow <workspace> --read <workflow_dir> --allow ~/.claude \
              --read /usr/bin --read /bin --read /usr/local/bin --read /opt/homebrew \
       -- claude …
     ```

     Differences:
     - `--credential anthropic` is omitted in non-bare mode because the CLI reads OAuth tokens from `~/.claude/` directly (operator runs `claude /login` once).
     - `~/.claude` is read+write in non-bare mode so OAuth-token refresh on 401 can persist; read-only in bare mode (no writes happen there).
     - In bare mode the CLI ignores everything in `~/.claude` at runtime — hooks, skills, plugins, MCP servers, auto memory, CLAUDE.md. In non-bare mode it consumes them. **Operator responsibility in non-bare mode: keep `~/.claude` tidy; anything you put there leaks into Symphony's per-issue runs.**

     Spell out what's allowed (filesystem read paths, the `claude-code` network profile's surface), what's denied (everything else by default), and the rationale. Acknowledge what the `claude-code` profile contains is opaque to us — we trust the upstream profile authors. For hooks, document the `developer` profile choice.
  3. **Agent approval policy** — Claude runs with `--permission-mode bypassPermissions --permission-prompt-tool stdio` regardless of bare mode. Under bypass, no `can_use_tool` requests fire; the stdio prompt is defense-in-depth. Any request that does fire is treated as a hard failure (deny with interrupt). Rationale: if the sandbox is doing its job, prompt-level approvals add friction without safety; if it isn't, prompt-level approvals won't save us. With `--bare`, the CLI also ignores `~/.claude`/project auto-discovery so the only inputs Claude sees are those Symphony passed explicitly. Without `--bare`, the operator is responsible for ensuring `~/.claude` doesn't contain surprises (rogue hooks, MCP servers, plugins).
  4. **User-input-required handling** — Per spec §10.5: any `turn_input_required` event fails the run immediately. Symphony does not surface to a human; future versions may. Currently the orchestrator schedules a retry on failure, so transient causes don't permanently fail issues.
  5. **`linear_graphql` scoping** — The tool is bound to Symphony's configured Linear API key and project. The agent can read/write anything that key allows on Linear, including issues outside the configured `tracker.project_slug`. v1 does NOT enforce project-level scoping at the tool layer (§15.5 RECOMMENDED hardening; deferred). Operators should provision an API key with the minimum needed scope.
  6. **Hook script trust assumption** — Per spec §15.4: workflow hook scripts are fully trusted configuration. They run inside the sandbox but the operator is responsible for what's in `WORKFLOW.md`. The sandbox limits blast radius; it doesn't protect against malicious `WORKFLOW.md`.
  7. **Spec divergences** — Two intentional divergences from the Symphony Service Specification Draft v1:
     - **Agent runner program**: `claude` CLI (stream-json, streaming mode) replaces Codex `app-server`. Same subprocess boundary, same `bash -lc <command>` launch contract, same `--input-format stream-json` / `--output-format stream-json` JSONL framing, but the program and its event taxonomy differ (mapping documented in `.claude/prds/symphony-v1/research/claude-stream-json.md`).
     - **Front-matter namespace**: `agent_runner.*` replaces `codex.*`. The Codex-specific config keys (`approval_policy`, `thread_sandbox`, `turn_sandbox_policy`) don't translate to Claude. The schema is runner-agnostic to leave room for future kinds.
  8. **Secret handling** — `tracker.api_key` is resolved from env via `$VAR` indirection (or literal). Never logged. The MCP `linear_graphql` tool executes against the same key but never exposes it to Claude (only the GraphQL surface).

     Claude authentication has two modes (per `agent_runner.bare`):
     - **`bare: true`**: `ANTHROPIC_API_KEY` is injected by `nono --credential anthropic` from the system keystore. `--bare` disables Claude's OAuth/keychain reads so this env-var path is required. Keystore injection keeps the key out of Symphony's process env and out of logs.
     - **`bare: false`** (v1 default): Claude reads OAuth tokens from `~/.claude/` (whatever `claude /login` deposited there). Symphony never touches these files. Token refresh on 401 writes back to `~/.claude/` via the nono `--allow ~/.claude` grant. Symphony's logs never contain the tokens.
  9. **What this implementation does NOT defend against** — Honest list: prompt injection in issue descriptions, malicious GraphQL responses, supply-chain compromise of `claude` or `nono` itself, dependency hijacking via `bun install` (sandbox limits damage; trust your `bun.lockb`).
- [ ] Document is under ~200 lines and structured for skim-readability (headers, bullets, code blocks).
- [ ] Cross-references: link to relevant SPEC.md sections and `research/` docs by repo-relative path.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `TRUST.md` | Create | The trust document. |

### Technical Constraints

- The actual sandbox argv MUST match what `src/sandbox/Nono.ts` produces. If the code changes, this doc changes. A test (in section-17-audit.md) can snapshot-compare to enforce.
- Don't claim hardening we don't do. Honesty section #9 is required.

### Relevant Code References

- Spec §15 (entire section), §10.5 (approval documentation), §18.1 (conformance).
- `.claude/prds/symphony-v1/research/nono-sh.md`, `research/claude-stream-json.md`.
- PRD §Discussion → "Trust posture and sandboxing", "Spec divergences to document".

## Testing Requirements

- [ ] A test verifies `TRUST.md` exists and contains the literal `nono run --network-profile claude-code` argv line, so refactoring the sandbox layer can't silently drift from the doc.
- [ ] A test verifies the doc references both spec divergences.

## Out of Scope

- A formal threat model. v1 is "trusted operator, sandboxed agent"; that's the model.
- An auditor's perspective. Internal use only.
- Cryptographic signing of `WORKFLOW.md`. Out.
