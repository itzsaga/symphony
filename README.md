# Symphony

Long-running local daemon that orchestrates Claude-based coding agents
against Linear issues. Implements the OpenAI Symphony Service Spec
([`SPEC.md`](SPEC.md)) on Bun + Effect.ts, with the `claude` CLI as the
per-issue agent runner in place of Codex's `app-server`.

Personal automation surface, not a distributed product: single Bun
process, in-memory orchestrator state, no built binary, no publish step.

## What it does

- Polls Linear for issues in configured "active" states (`Todo`,
  `In Progress`, …).
- Dispatches an isolated `claude` subprocess per eligible issue, running
  inside a `nono` sandbox with a per-issue workspace directory.
- Streams Claude's `stream-json` output back through an Effect-managed
  event pipeline, tracking turn counts, token usage, and rate limits.
- Reconciles tracker state between turns — issues that move to a
  terminal state interrupt the worker and clean up; issues that go
  inactive interrupt without cleanup.
- Optional HTTP dashboard + JSON API (§13.7) for observing live state.

## Quickstart

```sh
nix develop           # provides pinned bun, nono, claude-code, jq, yq-go
bun install
```

Create a `WORKFLOW.md` at the repo root (or any path you pass as
`argv[2]`). Minimum shape:

```md
---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: your-project-slug
workspace:
  root: ~/symphony-workspaces
agent_runner:
  kind: claude_code
  bare: false
---
You are working on an issue from Linear. Read the issue body and start.
```

Then run the daemon:

```sh
bun run src/main.ts ./WORKFLOW.md
# or, with the dashboard:
bun run src/main.ts ./WORKFLOW.md --port 8080
```

The CLI takes one positional (the workflow path; defaults to
`./WORKFLOW.md`) and an optional `--port <N>` that overrides
`server.port` from the workflow front matter. SIGINT/SIGTERM trigger a
graceful shutdown.

## Configuring

Front-matter schema lives in
[`src/config/WorkflowSchema.ts`](src/config/WorkflowSchema.ts) — that's
the authoritative source for every knob (polling cadence, concurrency
caps, retry backoff, hook scripts, sandbox profile, continuation prompt
template, …). Defaults match the spec §6.4 cheat sheet.

The body of `WORKFLOW.md` (everything after the closing `---`) is the
per-issue prompt template, rendered through strict Liquid with
`{{ issue.* }}` and `{{ attempt }}` in scope. Continuation prompts (used
between turns) default to a built-in fallback; override via
`agent_runner.continuation_prompt`.

Edits to `WORKFLOW.md` are picked up live for polling cadence and
concurrency limits; HTTP port changes require a restart per §13.7.

## Commands

Run inside `nix develop` (or with `direnv` loaded):

- `bun run dev` — watch-mode runner against `./WORKFLOW.md`.
- `bun run start` — one-shot runner; pass the workflow path as `argv[2]`.
- `bun test` — full test suite.
- `bun run test:integration` — integration tests under `test/integration/`
  (real-Linear tests gated on `LINEAR_API_KEY`; skipped without it).
- `bun run typecheck` — `tsc --noEmit`.
- `bun run audit:section-17` — verify §17 conformance coverage.

## Documentation

- [`AGENTS.md`](AGENTS.md) — coding conventions, project layout, the
  full command reference for working in this repo.
- [`TRUST.md`](TRUST.md) — sandbox model, secret handling, the two
  declared spec divergences (`claude` for Codex; `agent_runner.*` for
  `codex.*`), and an honest "what this doesn't defend against" list.
- [`SPEC.md`](SPEC.md) — upstream OpenAI Symphony spec, vendored at
  the repo root.
- [`.claude/prds/symphony-v1/PRD.md`](.claude/prds/symphony-v1/PRD.md)
  — v1 architecture and the design rationale behind the service graph.
- [`test/section-17-coverage.md`](test/section-17-coverage.md) —
  per-bullet conformance audit against spec §17.
