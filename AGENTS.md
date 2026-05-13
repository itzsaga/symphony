# Symphony

Long-running local daemon that orchestrates Claude-based coding agents
against Linear issues. Implements the OpenAI Symphony Service Spec
(see `SPEC.md` at the repo root) on Bun + Effect.ts.

Two declared spec divergences (rationale and full detail in `TRUST.md`):

1. **Claude Code (`claude` CLI) replaces Codex `app-server`** as the per-issue
   agent runner. Same subprocess boundary, same stream-json wire shape,
   different program.
2. **`agent_runner.*` replaces `codex.*`** in `WORKFLOW.md` front matter.
   The Codex-specific keys (`approval_policy`, `thread_sandbox`,
   `turn_sandbox_policy`) do not port to Claude Code, so a Codex
   `WORKFLOW.md` will not load as-is — by design.

Symphony is a personal automation surface, not a distributed product:
single Bun process, in-memory orchestrator state, no built binary, no
publish step. Run it with `bun run` against a real Linear project; edit
`WORKFLOW.md` and watch the change pick up live.

## Quickstart

```sh
nix develop
bun install
bun run src/main.ts ./WORKFLOW.md
```

`nix develop` provides pinned `bun`, `nono`, `claude-code`, `git`, `jq`,
and `yq-go` via `flake.nix`. `direnv` users get this automatically from
`.envrc` (`use flake`).

## Commands

Run inside `nix develop` (or with direnv loaded):

- `bun test` — full test suite (`@effect/vitest` under `bun test`).
- `bun run typecheck` — `tsc --noEmit` against `src/` and `test/`.
- `bun run dev` — watch-mode runner against `./WORKFLOW.md`.
- `bun run start` — one-shot runner; pass the workflow path as `argv[2]`.

Always run `nix develop --command bun test` and
`nix develop --command bun run typecheck` before pushing.

## Project layout

```
/
├── flake.nix, flake.lock              # bun + nono + claude-code pins
├── package.json, bun.lock             # Bun project + lockfile
├── tsconfig.json                      # strict TS, ESM, bundler resolution
├── SPEC.md                            # upstream OpenAI Symphony spec (vendored)
├── TRUST.md                           # sandbox model + the two divergences
├── WORKFLOW.md                        # example/dev workflow
├── AGENTS.md, CLAUDE.md               # project memory (this file + import)
└── src/
    ├── main.ts                        # CLI parse, layer composition, Layer.launch
    ├── config/                        # WorkflowLoader, TypedConfig, PathSafety
    ├── linear/                        # LinearClient, queries, normalize
    ├── workspace/                     # WorkspaceManager, Hooks
    ├── sandbox/                       # nono argv builder
    ├── claude/                        # ClaudeRunner, StreamJson, McpServer, EventMapping
    ├── prompt/                        # liquidjs strict wrapper
    ├── orchestrator/                  # State, Dispatch, Reconcile, Retry
    ├── http/                          # Server, Dashboard, Api (§13.7 extension)
    └── observability/                 # Logger (JSONL stderr), Snapshot
test/
├── unit/                              # per spec §17.1–17.7
├── integration/                       # per §17.8 (LINEAR_API_KEY-gated)
└── fixtures/                          # WORKFLOW.md samples, recorded stream-json
```

The full architectural rationale lives in `.claude/prds/symphony-v1/PRD.md`
under §Architecture.

## Coding conventions

- **Effect.ts top to bottom.** Every service is a `Context.Tag` with a
  `Live` layer; orchestration paths use `Effect`, fibers, `Ref`/`Queue`,
  and tagged errors via `Data.TaggedError`. Plain TS is fine for pure data
  transforms (prompt rendering, normalization) where Effect adds nothing.
- **No `any`. No non-null assertion (`!`). No `@ts-nocheck`.** Use
  `unknown` and refine, or model with `@effect/schema`. `tsconfig.json`
  enables `strict`, `noUncheckedIndexedAccess`, and
  `exactOptionalPropertyTypes` — write code that respects them.
- **2-line header comment on every code/config file** (`.ts`, `.nix`,
  `.json` where comments are legal, etc.) describing what the file does.
  Markdown files are exempt.
- **Match the surrounding style.** Consistency within a file beats
  external style guides. Don't reformat unrelated code.
- **Tests live under `test/unit/` and `test/integration/`.** Unit tests
  map to spec §17.1–§17.7; integration tests map to §17.8 and are gated
  behind `LINEAR_API_KEY` (skipped, not failed, when unset). Use
  `@effect/vitest`'s `it.effect` / `it.live` for Effect-bearing tests.
- **Schema-validate every wire boundary.** Linear GraphQL responses,
  Claude stream-json frames, MCP control-protocol RPC frames, WORKFLOW.md
  front matter, and HTTP API responses all go through `@effect/schema`.

## Spec conformance

`SPEC.md` (vendored at the repo root) is the source of truth for §§4–18.
The acceptance gate for v1 is the **§18.1 Core Conformance checklist**,
plus two opted-in extensions: the §13.7 HTTP server and the §10.5
`linear_graphql` client-side tool. Deliberate divergences from the spec
(currently the two listed above) are documented in `TRUST.md` per the
§15.1 trust-model requirement; do not introduce new divergences without
recording them there.

## Where things live

- **Active PRD** — `.claude/prds/symphony-v1/PRD.md`. Architecture,
  constraints, and open design questions for v1.
- **PRD workflow artifacts** — `.claude/prds/`. Specs, research notes,
  task breakdowns. Per-task scratch belongs in
  `.claude/tasks/<task>/` (per the global `~/.claude/CLAUDE.md` rules).
- **Trust model + divergences** — `TRUST.md` at the repo root. Sandbox
  policy (`nono` profiles, credentials, filesystem grants), Claude's
  in-session approval surface, and every deliberate spec divergence.
- **Example workflow** — `WORKFLOW.md` at the repo root. Exercises the
  `agent_runner.*` namespace and is what `bun run dev` watches.
- **Upstream spec** — `SPEC.md` at the repo root.
- **Protocol research** — `.claude/prds/symphony-v1/research/` covers
  the `claude` stream-json wire format and the `nono` CLI in depth.

## Git and CI hygiene

- **Never use `--no-verify` when committing.** Pre-commit hooks exist for
  a reason; if one fails, fix the root cause.
- **Never co-author commits as Claude / Claude Code / any AI.** Do not
  add `Co-Authored-By: Claude …` trailers, and do not mention "Generated
  with Claude Code" in commit messages.
- **`git pull --rebase`** when integrating remote changes.
- Specific files only when staging — avoid `git add -A` or `git add .`
  to keep secrets and stray artifacts out of commits.
