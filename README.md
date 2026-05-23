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

## How it works

Symphony is a single long-running Bun process driving an Effect service
graph. Every `polling.interval_ms` (default 30s) it runs one tick:

1. **Reconcile running workers.** Refetch tracker state for every
   in-flight issue. Terminal → interrupt + remove workspace.
   Non-active-non-terminal → interrupt and leave the workspace.
   Stalled past `agent_runner.stall_timeout_ms` → interrupt + queue a
   retry. (`src/orchestrator/Reconcile.ts`)
2. **Fetch candidates.** Linear GraphQL query for issues in
   `tracker.active_states`, scoped to `tracker.project_slug`.
   (`src/linear/queries.ts`)
3. **Select a batch.** Sort by priority → created_at → identifier; drop
   anything already running/claimed, anything blocked (the `Todo` blocker
   rule, §8.2), or anything over a global/per-state concurrency cap.
   (`src/orchestrator/Dispatch.ts`)
4. **Dispatch.** For each selected issue: ensure the per-issue workspace
   directory exists under `workspace.root` (`after_create` hook fires
   on first creation), run `before_run`, then spawn
   `nono run … -- claude --input-format stream-json --output-format
   stream-json` and feed the rendered prompt in over stdin.
5. **Stream and react.** Decode `stream-json` frames into spec §10.4
   events, update orchestrator state (turns, tokens, rate-limit reset),
   and feed continuation prompts between turns until the issue moves out
   of `active_states`, hits a terminal state, errors, or stalls.

The orchestrator owns no persistent state — restart and Symphony rebuilds
its picture of the world from Linear plus on-disk workspaces.

## Where you (the human) plug in

There is no prompt-time approval surface inside a run. Your control
points are all *outside* the agent loop:

- **Linear is the control plane.** Creating, prioritizing, and moving
  issues drives everything. Moving an issue *into* an active state
  queues it for the next tick; moving it *out* (to any non-active,
  non-terminal state) interrupts the worker cleanly and **keeps the
  workspace**; moving it to a terminal state interrupts + removes the
  workspace. Issue body and comments are part of the prompt context, so
  comments are how you "talk to" an in-flight agent across turn
  boundaries.
- **The `Human Review` handoff pattern.** Define a non-terminal state
  outside `active_states` (e.g. `Human Review`, `Needs Input`,
  `Blocked`). Instruct the agent in `WORKFLOW.md` to transition the
  issue there when it wants you. Symphony's reconciler will interrupt
  the worker without cleanup so you can inspect the workspace, then
  pick the run back up the moment you move the issue back into an
  active state. This is the spec-blessed escape hatch (§3) and the
  intended way to do HITL.
- **`WORKFLOW.md` is your config + prompt.** The front matter sets
  polling cadence, concurrency caps, retry/backoff, active/terminal
  state names, sandbox profile, hooks, and continuation-prompt
  template. The body is the per-issue prompt, rendered through strict
  Liquid. Edits land live on the next tick — no restart — for
  everything except `--port`.
- **Workspace hooks** (`hooks.after_create`, `before_run`, `after_run`,
  `before_remove`). The standard place to `git clone`, install deps,
  run formatters, drop status comments back into Linear, etc. Hooks
  are trusted code (§15.4) and run inside the sandbox under the `hook`
  policy. `after_create` / `before_run` failures abort; `after_run` /
  `before_remove` failures are logged and ignored.
- **`tracker.active_states` / `terminal_states`.** The bouncer at the
  door. Anything in `active_states` is fair game; the agent is
  expected to move issues out of it when work is done. Defaults are
  `["Todo", "In Progress"]` active and
  `["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]` terminal.
- **No in-CLI approvals.** Claude runs `--permission-mode
  bypassPermissions --permission-prompt-tool stdio`; if a
  `can_use_tool` request ever fires (it shouldn't) Symphony returns
  `{behavior:"deny", interrupt:true}` and the run fails into the
  exponential-backoff retry path. The sandbox (`nono`) is the safety
  boundary, not prompt approvals — see [`TRUST.md`](TRUST.md) §1, §3.
- **Observability surfaces.** Structured JSONL on stderr is always on;
  the optional HTTP server (`--port <N>` or `server.port` in front
  matter) serves a live dashboard at `/` and a JSON API for poking at
  orchestrator state from scripts.

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
