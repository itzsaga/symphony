# Project AGENTS.md and CLAUDE.md

## Objective

Author the repo's project-level memory files following the Anthropic convention: `AGENTS.md` carries the agent-agnostic instructions (read by Cursor, Windsurf, Claude Code, and other coding agents); `CLAUDE.md` is a one-line `@AGENTS.md` import that lets Claude Code pick it up without duplication. Reference: https://code.claude.com/docs/en/memory#agents-md.

## Context

### Parent PRD

- **PRD**: Symphony v1 (Effect.ts + Claude Code)
- **PRD Path**: `.claude/prds/symphony-v1/PRD.md`

### Related Tasks

- **Depends on**: Bun + TypeScript + Effect setup (so we know the layout we're documenting), Nix flake dev shell (so we know the build/run commands).
- **Blocks**: nothing technically, but every future agent that touches the repo reads these files first; they're foundational for collaboration.

## Acceptance Criteria

- [ ] `AGENTS.md` exists at repo root. Under 200 lines (per Anthropic guidance). Sections:
  - **Project overview** — 2-3 paragraph summary: what symphony is, the two declared spec divergences (Claude Code in place of Codex; `agent_runner.*` in place of `codex.*`), and where to find the upstream spec (`SPEC.md`).
  - **Quickstart** — `nix develop && bun install && bun run src/main.ts ./WORKFLOW.md`.
  - **Build, test, type-check commands** — `bun test`, `bun run typecheck`, `bun run dev`, `bun run start`.
  - **Project layout** — Brief tree mapping to PRD §Architecture's file layout.
  - **Coding conventions** — Effect.ts top-to-bottom, no `any`, no `!`, no `@ts-nocheck`; 2-line file header comments; tests live under `test/unit/` and `test/integration/`.
  - **Spec conformance** — One-paragraph pointer: `SPEC.md` is the source of truth; §18.1 is the conformance checklist; deliberate divergences are documented in `TRUST.md`.
  - **Where things live** — Pointers to `PRD.md` (active PRD), `TRUST.md` (security/divergence doc), `WORKFLOW.md` (example), `.claude/prds/` (PRD workflow artifacts).
- [ ] `CLAUDE.md` exists at repo root with the canonical reference pattern:
  ```markdown
  @AGENTS.md
  ```
  Add Claude-specific extras only if a need is identified during implementation (initial version may just be the single import line).
- [ ] No symlink in lieu of CLAUDE.md (the docs say symlinks work, but the import form survives Windows / Linux / macOS uniformly and travels through git the same way).
- [ ] Both files are committed (not gitignored).

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `AGENTS.md` | Create | Agent-agnostic project instructions. |
| `CLAUDE.md` | Create | `@AGENTS.md` import. |

### Technical Constraints

- Keep `AGENTS.md` under 200 lines. Move detailed topics to `TRUST.md` (security) or per-directory README files if it grows past that.
- Use markdown headers and bullets, not dense prose, per Anthropic's "Write effective instructions" guidance.
- Specific over vague: "Use 2-space indentation" not "format properly". "Run `nix develop --command bun test` before pushing" not "test your changes".
- Do NOT replicate `SPEC.md` content. Reference it.
- Do NOT replicate Seth's global `~/.claude/CLAUDE.md` rules — they load automatically. But it's fine to reiterate the most load-bearing ones (no `any`, no `!`, no `--no-verify`, never co-author commits as Claude) because new agents on shared CI without the user CLAUDE.md still need them.

### Relevant Code References

- https://code.claude.com/docs/en/memory#agents-md — the canonical AGENTS.md ↔ CLAUDE.md convention.
- PRD §Architecture and §Constraints — source material for the layout and conventions sections.
- `TRUST.md` (separate task) — for the security/divergence doc this references.

### Code Examples

```markdown
# Symphony

Long-running local daemon that orchestrates Claude-based coding agents
against Linear issues. Implements the OpenAI Symphony Service Spec
(see `SPEC.md`) on Bun + Effect.ts, with `claude` CLI as the agent
runner instead of Codex.

Two declared spec divergences (documented in `TRUST.md`):

1. `claude` CLI replaces Codex `app-server`. Same subprocess boundary
   and stream-json protocol, different program.
2. WORKFLOW.md front matter uses `agent_runner.*` instead of `codex.*`.

## Quickstart

    nix develop
    bun install
    bun run src/main.ts ./WORKFLOW.md

## Commands

- `bun test` — run the test suite
- `bun run typecheck` — TypeScript no-emit pass
- `bun run dev` — watch-mode runner against `./WORKFLOW.md`
- `bun run start` — production-mode runner

…
```

## Testing Requirements

- [ ] `AGENTS.md` parses as markdown (no broken refs).
- [ ] `CLAUDE.md` consists of exactly the import line (plus possibly a few Claude-specific lines).
- [ ] Running `claude` inside the repo loads CLAUDE.md without warning (manual smoke test — `/memory` shows both files).

## Out of Scope

- `.cursorrules`, `.windsurfrules` — generate later if/when another tool is actively used. The `AGENTS.md` convention plus those tools' AGENTS.md support is enough today.
- Path-scoped rules under `.claude/rules/`. Defer until a real need (e.g. test-files-only rules) emerges.
- Auto-memory configuration. Default behavior is fine.
- A README.md aimed at humans. That's a separate task if needed; `AGENTS.md` is the canonical doc for now.
