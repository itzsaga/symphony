# Symphony v1 (Effect.ts + Claude Code)

## Objective

Implement the [Symphony Service Specification](https://github.com/openai/symphony/blob/main/SPEC.md) (Draft v1) as a long-running local daemon that orchestrates Claude-based coding agents against issues in a Linear project. The implementation diverges from the upstream reference in two deliberate ways:

1. The agent runner drives **Claude Code** (the `claude` CLI) as the per-issue coding-agent app-server, instead of `codex app-server`.
2. The entire service is written in **TypeScript on Bun, with Effect.ts as the foundation** for concurrency, configuration, error modeling, scheduling, HTTP, and resource lifetimes.

v1 covers the spec's **Section 18.1 Core Conformance checklist** plus two optional extensions:

- The HTTP server extension defined in §13.7 (`/`, `/api/v1/state`, `/api/v1/<identifier>`, `POST /api/v1/refresh`).
- The `linear_graphql` client-side tool extension defined in §10.5, advertised into the Claude session.

Success looks like: I can run the service locally against a real Linear project, edit `WORKFLOW.md` and see the changes pick up live, watch issues get dispatched into per-issue workspaces under bounded concurrency, observe Claude turns streaming back through structured logs and the HTTP dashboard, and have failed runs back off exponentially while terminal-state issues stop and clean up cleanly.

## Motivation

Symphony solves a problem I have today: turning Linear issues into actual work without me kicking off scripts by hand. The upstream OpenAI reference is the right shape — workflow-as-repo, isolated workspaces, bounded concurrency, dynamic reload — but it's tied to Codex and written in a stack I don't want to maintain. By porting to **Claude Code + Effect.ts + Bun**, I get:

- **The agent I actually use.** I drive Claude Code daily and have a working mental model of its permission system, tools, and streaming output. Codex would be a parallel toolchain to maintain.
- **A type-safe orchestrator I trust.** The spec is dense with state machines, retry math, reconciliation invariants, and "MUST/MUST NOT" path-safety rules. Effect's typed errors, `Layer`-based DI, fibers, and structured concurrency map directly onto the spec's coordination/execution/integration layering and make the safety invariants enforceable at the type level rather than by convention.
- **A daemon that's mine.** Running locally now, then on a remote Linux box over SSH later. No need to package or distribute — just `bun run`. The whole point is that this is *my* automation surface for *my* tickets.

The end state is a daemon I leave running while I work on bigger things, that quietly grinds through Todo/In Progress tickets in the background and hands work back to me at a `Human Review` state.

## Implementation Details

### Architecture

#### Runtime shape

Bun + TypeScript, single package at the repo root, no monorepo, no built binary. Entry point: `bun run src/main.ts <path-to-WORKFLOW.md>`. Dependencies managed via a project `flake.nix` (provides `bun`, `nono`, `claude` CLI versions, anything else needed in the dev shell). `bun.lockb` is checked in.

The program is an `Effect.gen` that builds and `Layer.launch`es the service graph. The main fiber blocks on a never-completing `Deferred` that signals shutdown; `SIGINT`/`SIGTERM` resolve it, triggering coordinated teardown of all child fibers (orchestrator tick, workflow watcher, HTTP server, running agent subprocesses).

#### Service graph (Effect Layers)

Every service is a `Context.Tag`; layers compose top-down. Sketch:

```
Layer.mergeAll(
  LoggerLive,                         // stderr JSONL sink + in-memory ring buffer (for HTTP)
  ClockLive, FileSystemLive,          // @effect/platform
)
  ⊳ ConfigLive                        // selects WORKFLOW.md path; effective TypedConfig
  ⊳ WorkflowLoaderLive                // Layer.scoped: file watch fiber + reload Queue
  ⊳ LinearClientLive                  // @effect/platform HttpClient w/ Linear-shaped queries
  ⊳ WorkspaceManagerLive              // sanitize, create, hook execution, path-safety invariants
  ⊳ SandboxLive                       // nono CLI wrapper service
  ⊳ ClaudeRunnerLive                  // stream-json subprocess + control-protocol RPC
  ⊳ McpServerLive                     // in-process MCP server exposing linear_graphql
  ⊳ OrchestratorLive                  // single-authority state + tick fiber
  ⊳ HttpServerLive                    // @effect/platform HTTP, conditional on server.port
```

#### Concurrency model

- **Orchestrator state** is the only shared mutable. Held in an `Effect.Ref` (or `SubscriptionRef` so HTTP observers can subscribe to changes). All mutations route through `Orchestrator.dispatch(event)` — a single fiber that consumes a `Queue<OrchestratorEvent>` and serializes state transitions. This realizes spec §7's "single authority" requirement.
- **Each worker run** is one fiber: `WorkspaceManager.prepare → before_run hook → ClaudeRunner.runSession → after_run hook`. The fiber sends events to the orchestrator via the event queue. The orchestrator owns the supervisor handle to interrupt it on reconciliation/stall.
- **Workflow watcher** is a separate fiber subscribed to `fs.watch(WORKFLOW.md)`; on change it `WorkflowLoader.load()`s and enqueues `WorkflowReloaded` for the orchestrator to absorb.
- **HTTP server** is a fiber hosted by `@effect/platform`'s HTTP runtime. Read-only access to orchestrator state via the `SubscriptionRef`; the only write is `POST /api/v1/refresh` which enqueues an `ImmediateTick` event.
- **Retry timers** are `Effect.sleep(delay).fork`'d fibers stored in `retry_attempts: Map<issueId, Fiber>`. Canceling a retry is `Fiber.interrupt` — no separate `clearTimeout` bookkeeping. Spec §8.4's "Cancel any existing retry timer for the same issue" is `interrupt(existing) <* set(new)`.

#### Error model

Every service exposes a tagged error union (Effect's `Data.TaggedError`). Examples:

- `WorkflowLoaderError = MissingFile | ParseError | FrontMatterNotMap | TemplateError`
- `LinearClientError = LinearRequestFail | LinearStatusFail | LinearGraphqlErrors | LinearMalformedPayload | LinearMissingEndCursor | MissingApiKey | MissingProjectSlug`
- `ClaudeRunnerError = ClaudeNotFound | InvalidWorkspaceCwd | StartupFailed | TurnTimeout | TurnFailed | TurnCancelled | TurnInputRequired | SubprocessExit | StallTimeout`
- `WorkspaceError = SanitizationFailure | PathEscape | HookFailed | HookTimeout`

These map directly to spec §10.6 normalized categories and §11.4 tracker errors. The orchestrator's worker-failure handler is `Match.value(error).pipe(Match.tags({…}))` — exhaustive at the type level.

#### Schemas

`@effect/schema` for all wire types: Linear GraphQL responses, Claude stream-json frames (`user | assistant | system | result | stream_event | rate_limit_event | control_request | control_response`), MCP control-protocol RPC frames, WORKFLOW.md front matter, HTTP API response shapes. Schemas double as runtime validators and TypeScript type generators.

#### Claude integration (per `research/claude-stream-json.md`)

- Each worker run spawns one long-lived `claude` subprocess (streaming mode, NOT `-p` one-shot). One subprocess per Symphony "run"; continuation turns within a run reuse the same subprocess and the same `session_id`. Continuation across runs uses `--resume <session-id>`.
- Wire flags (final):
  ```
  claude [--bare] \
         --output-format stream-json --verbose --input-format stream-json \
         --permission-mode bypassPermissions \
         --permission-prompt-tool stdio \
         --add-dir <workspace> \
         --mcp-config <symphony-mcp-config.json> \
         [--session-id <uuid>] [--resume <prior-session> [--fork-session]] \
         --max-turns <config.agent_runner.max_turns>
  ```
  `--bare` is gated on the WORKFLOW.md `agent_runner.bare` field (default `false`). With `bare: true` (upstream-recommended for scripted/SDK use) the CLI ignores auto-discovery of `~/.claude`, project `.mcp.json`, hooks, skills, plugins, auto memory, and CLAUDE.md — auth must come from `ANTHROPIC_API_KEY` (injected by `nono --credential anthropic` from the keystore). With `bare: false` (v1 default) the CLI reads OAuth tokens from `~/.claude/`, so the operator can run `claude /login` once and Symphony reuses the session; the trade-off is that whatever else lives in `~/.claude/` leaks into per-issue runs.
- **Permission surface:** `bypassPermissions` plus a stdio permission-prompt-tool. The bypass mode means tool calls auto-approve in practice; the stdio prompt is there as a defense-in-depth channel — if Claude ever produces a `can_use_tool` request (e.g., a future hook explicitly downgrades), Symphony sees it as a §10.4 `turn_input_required` event and rejects with `{behavior:"deny", interrupt:true}` to fail the turn.
- **Session/turn IDs:** Claude exposes `session_id` (UUID, stable across `--continue`/`--resume`) but no `turn_id`. Spec §4.2 needs `<thread_id>-<turn_id>`. Synthesize: `thread_id = session_id`, `turn_id = result.num_turns` (the running integer count from the latest `result` message).
- **Token accounting:** prefer `result.usage` (turn aggregate) and `result.modelUsage` (per-model breakdown) over `assistant.message.usage`. Track deltas against `last_reported_*_tokens` per spec §13.5 to avoid double-counting.
- **Stdin lifetime:** stdin stays open for the duration of the worker run. Graceful close on shutdown: `process.stdin.end()`, wait up to 5s, then `SIGTERM`, then `SIGKILL` (matches the Python SDK's behavior, fixes Claude session-file flush race).
- **`linear_graphql` tool** is exposed as an SDK-type MCP server (`{type:"sdk", name:"symphony"}`). Tool calls arrive over the control protocol as `control_request{subtype:"mcp_message"}` and Symphony's orchestrator-resident MCP server handles them using its already-configured Linear auth. No separate stdio child.

#### Sandbox integration (per `research/nono-sh.md`)

- Every `claude` invocation and every workflow hook is wrapped by `nono run --` (Supervised mode — signal forwarding intact across grandchildren).
- Base policy for `claude`:
  ```
  nono run \
    --network-profile claude-code \
    --credential anthropic \
    --allow <workspace> \
    --read <WORKFLOW.md parent dir> \
    --read ~/.claude --read /usr/bin --read /bin --read /usr/local/bin --read /opt/homebrew \
    -- claude …
  ```
  The `claude-code` network profile is a nono built-in already calibrated for Anthropic API egress. The `anthropic` credential is auto-injected from the system keystore.
- Hooks use a similar wrapper, but the host environment may need a broader filesystem allow-list (`git clone`, `bun install`, etc.). Default to nono's `developer` profile for hooks, override per workflow if needed.
- Sandbox failure modes are surfaced as a `WorkspaceError | ClaudeRunnerError` depending on which phase tripped them.

#### Front matter schema rename

The spec's `codex.*` namespace is Codex-specific. v1 replaces it with **`agent_runner.*`** in WORKFLOW.md front matter:

```yaml
agent_runner:
  kind: claude_code              # forward-compat for future runners
  command: claude                # default; overridden if `which claude` isn't right
  permission_mode: bypassPermissions
  max_turns: 20                  # was agent.max_turns
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
  network_profile: claude-code   # nono profile name
  extra_args: []                 # passthrough for ad-hoc CLI flags
```

This is one of the two declared spec divergences (`TRUST.md` documents both).

#### File layout

```
/
├── flake.nix                         # bun, nono, claude pins
├── flake.lock
├── package.json, bun.lockb, tsconfig.json
├── SPEC.md                           # upstream OpenAI Symphony spec (vendored)
├── TRUST.md                          # divergences + sandbox-first model (per §15.1)
├── WORKFLOW.md                       # example/dev workflow
├── README.md
└── src/
    ├── main.ts                        # CLI parse, wiring, Layer.launch
    ├── config/
    │   ├── WorkflowLoader.ts
    │   ├── TypedConfig.ts             # schema + defaults + $VAR resolution
    │   └── PathSafety.ts              # §9.5 invariants
    ├── linear/
    │   ├── LinearClient.ts
    │   ├── queries.ts                 # GraphQL strings + Schema-typed responses
    │   └── normalize.ts               # tracker payload → spec §4.1.1 Issue
    ├── workspace/
    │   ├── WorkspaceManager.ts
    │   └── Hooks.ts                   # after_create/before_run/after_run/before_remove
    ├── sandbox/
    │   └── Nono.ts                    # `nono run` argv builder + invocation
    ├── claude/
    │   ├── ClaudeRunner.ts            # subprocess + stream-json + control-protocol
    │   ├── StreamJson.ts              # Schema for every frame type
    │   ├── McpServer.ts               # in-process MCP server (linear_graphql)
    │   └── EventMapping.ts             # Claude stream → §10.4 event taxonomy
    ├── orchestrator/
    │   ├── Orchestrator.ts            # single-authority state machine
    │   ├── State.ts                   # OrchestratorRuntimeState + reducer
    │   ├── Dispatch.ts                # §8.2 candidate selection + §8.3 slots
    │   ├── Reconcile.ts               # §8.5 stall + tracker state refresh
    │   └── Retry.ts                   # §8.4 backoff + timers (Fiber-based)
    ├── prompt/
    │   └── Render.ts                  # liquidjs strict mode wrapper
    ├── http/
    │   ├── Server.ts                  # @effect/platform HTTP server
    │   ├── Dashboard.ts                # server-rendered HTML at `/`
    │   └── Api.ts                     # /api/v1/state, /api/v1/<id>, POST /refresh
    └── observability/
        ├── Logger.ts                  # stderr JSONL + ring buffer
        └── Snapshot.ts                # SubscriptionRef → JSON snapshot for HTTP
test/
├── unit/                              # per spec §17.1–17.7 (Core Conformance)
├── integration/                       # per §17.8 (LINEAR_API_KEY gated)
└── fixtures/                          # WORKFLOW.md samples, recorded stream-json, etc.
```

### Constraints

- **Spec conformance, with two documented divergences.** The implementation MUST satisfy Section 18.1 of `SPEC.md` (vendored at repo root). The two intentional divergences MUST be documented in `TRUST.md`:
  1. Claude Code (`claude` CLI in stream-json streaming mode) in place of Codex `app-server`.
  2. `agent_runner.*` front-matter namespace in place of `codex.*` (the Codex-specific keys `approval_policy`, `thread_sandbox`, `turn_sandbox_policy` are not portable to Claude Code). The two namespaces are not interchangeable; a Codex `WORKFLOW.md` won't load as-is, by design.
- **TypeScript, Bun, Effect.ts.** No alternate runtimes, no plain async/await for orchestration paths. Plain TS is fine for pure data transforms (prompt rendering, normalization) when Effect adds nothing.
- **Dependencies pinned in `flake.nix`.** The dev shell provides `bun`, `nono`, `claude` and any other host tooling needed (e.g. `git`). `flake.lock` is checked in.
- **No `any`, no non-null assertions, no `@ts-nocheck`.** (Global rule from CLAUDE.md; restating because Effect-heavy code tempts both.) Use `unknown` and refine, or model with `Schema`.
- **Single package, no published artifact.** Run with `bun run`. No `bun build` to a binary, no npm publish. Local-first; deployable to a personal Linux host via SSH + systemd or a `screen`/`tmux` session — that integration is out of scope for v1.
- **Linear is the only tracker.** Section 11 implementation targets Linear's GraphQL API. Adapter shape SHOULD leave room for other trackers later (Section 18.2 TODO) but no second adapter is built.
- **Claude Code subprocess is the only agent runner shape in v1.** The Anthropic SDK option and the Agent SDK option were considered and rejected for v1 to preserve the spec's subprocess boundary and per-workspace `cwd` invariant. **Streaming mode** (`--input-format stream-json`) is mandatory — the historical `-p`/`--print` one-shot mode is not supported; the first-party SDKs no longer use it and it lacks the control protocol the orchestrator needs.
- **`nono.sh` (CLI, Supervised mode) is the sandbox layer.** All `claude` invocations and all workflow hook executions (`after_create`, `before_run`, `after_run`, `before_remove`) run as `nono run -- …`. Base policy for `claude`: `--network-profile claude-code --credential anthropic` plus per-workspace filesystem grants. Spec divergence vs. `nono.sh`-isn't-on-the-spec path is documented in `TRUST.md`.
- **High-trust agent approvals with observability.** Inside the sandbox, Claude runs with `--permission-mode bypassPermissions --permission-prompt-tool stdio`. The bypass mode does the real work; the stdio prompt-tool gives Symphony a §10.4 `turn_input_required` event channel if any `can_use_tool` request ever appears (treated as hard failure with `{behavior:"deny", interrupt:true}`).
- **Dynamic reload is mandatory.** Per §6.2, `WORKFLOW.md` changes MUST be detected and re-applied to polling cadence, concurrency limits, state lists, `agent_runner.*` settings, workspace paths, hooks, and the prompt template, without a restart. This is non-negotiable for the developer loop. HTTP listener (`server.port`) is the spec-permitted exception — restart required.
- **In-memory orchestrator state.** No durable scheduler database (matches the spec). Restart recovery is tracker-driven plus filesystem-driven.
- **Path safety invariants from §9.5 are enforced before every agent launch and every hook execution**, not just at config load.
- **Strict Liquid templating** for the prompt body via `liquidjs` with `strictVariables: true` and `strictFilters: true` (per §5.4).
- **Logging:** structured JSONL to stderr, plus an in-memory ring buffer the HTTP dashboard reads for recent events. Single sink; no log files owned by the daemon.
- **Tests over manual verification.** The Section 17 test matrix is the acceptance gate. Test framework: `bun test` with `@effect/vitest` (`it.effect` / `it.live`) for Effect-bearing tests. Real Linear integration tests (§17.8) are gated behind `LINEAR_API_KEY` and skipped without one, but MUST be runnable.

### Relevant Guides

- `SPEC.md` (vendored at repo root) — upstream OpenAI Symphony Service Specification, Draft v1. The source of truth for §§4–18.
- `.claude/prds/symphony-v1/research/claude-stream-json.md` — protocol reference for the `claude` CLI in stream-json mode: invocation flags, wire format for every frame type, mapping to spec §10.4 events, session/turn ID strategy, token accounting, control protocol for permission requests and MCP routing, failure modes.
- `.claude/prds/symphony-v1/research/nono-sh.md` — nono CLI reference: install via `nix shell nixpkgs#nono`, Supervised vs Direct execution modes, filesystem/network flags, the `claude-code` and `developer` network profiles, `--credential anthropic` keystore injection.
- `/Users/seth/.claude/CLAUDE.md` — global development rules (no `any`, no `!`, no `--no-verify`, etc.).

### Relevant Files

Will all be created during implementation; structure documented in the Architecture section. High-priority files in dependency order:

- `flake.nix`, `flake.lock` — (Create) Nix dev shell pinning bun, nono, claude.
- `package.json`, `tsconfig.json`, `bun.lockb` — (Create) Bun + TypeScript + Effect deps.
- `TRUST.md` — (Create) Sandbox model, the two declared spec divergences, hook trust assumptions per §15.1 and §15.4.
- `WORKFLOW.md` — (Create) Example workflow exercising the `agent_runner.*` namespace.
- `SPEC.md` — (Review) Already vendored. Read-only reference.
- `src/main.ts` — (Create) CLI parse, layer composition, `Layer.launch`, SIGINT/SIGTERM teardown.
- `src/config/{WorkflowLoader,TypedConfig,PathSafety}.ts` — (Create) §5, §6, §9.5.
- `src/linear/{LinearClient,queries,normalize}.ts` — (Create) §11.
- `src/workspace/{WorkspaceManager,Hooks}.ts` — (Create) §9.
- `src/sandbox/Nono.ts` — (Create) `nono run` argv builder.
- `src/claude/{ClaudeRunner,StreamJson,McpServer,EventMapping}.ts` — (Create) §10 + the two divergences.
- `src/prompt/Render.ts` — (Create) liquidjs strict wrapper, §5.4 / §12.
- `src/orchestrator/{Orchestrator,State,Dispatch,Reconcile,Retry}.ts` — (Create) §§7–8, §14.
- `src/http/{Server,Dashboard,Api}.ts` — (Create) §13.7.
- `src/observability/{Logger,Snapshot}.ts` — (Create) §13.
- `test/unit/**` — (Create) Maps to §17.1–§17.7.
- `test/integration/**` — (Create) `LINEAR_API_KEY`-gated, §17.8.

## Discussion

### Agent integration shape

_The spec is built around a Codex app-server subprocess with a stdio protocol. Claude has three viable integration shapes: (a) the `claude` CLI run as a subprocess driven via its `stream-json` mode, (b) the in-process `@anthropic-ai/claude-agent-sdk`, or (c) raw Anthropic Messages API with a hand-rolled tool loop. Which one matches Symphony's architectural assumptions best?_

Use the `claude` CLI as the app-server. It preserves the subprocess boundary the spec is designed around (workspace `cwd` invariant, OS-level sandboxing, per-issue process lifecycle, stdio framing). The Agent SDK would dissolve the boundary into in-process function calls and force us to re-implement the workspace-isolation invariants ourselves; the raw API would force us to re-implement the entire turn/tool loop. The CLI approach is the smallest divergence from the spec.

### Effect.ts depth

_Effect.ts can be used as anywhere from a tactical retry/concurrency utility up to the full app framework with `Layer`, `Context`, typed errors, and `Schema`. Where on that spectrum should v1 sit?_

End-to-end. The spec is essentially a precise specification of effectful, concurrent, fallible coordination — exactly Effect's wheelhouse. Half-measures mean two competing concurrency models in the same codebase. Going all-in pays for itself in the orchestrator state machine (§7), reconciliation (§8.5), retry math (§8.4), and dynamic reload (§6.2), all of which are tedious in plain async/await and natural in Effect.

### v1 scope

_The spec defines a Core Conformance checklist (§18.1), Recommended Extensions (§18.2: HTTP server, linear_graphql tool, persistence, more tracker adapters, first-class write APIs), and a Real Integration Profile (§18.3). What's in v1?_

Core conformance + HTTP server extension (§13.7) + `linear_graphql` client-side tool (§10.5). The HTTP dashboard is how I actually want to observe what's happening day-to-day; structured logs alone aren't enough. The `linear_graphql` tool gives Claude a clean way to update issues, write comments, and link PRs without me building a one-off tool layer. Skipped for v1: persistent retry queue (TODO in §18.2), SSH worker extension (Appendix A — interesting later but adds a whole second execution path), additional tracker adapters, first-class orchestrator write APIs.

### Runtime

_Node, Bun, or Deno?_

Bun. Fast cold start matters for a daemon I'll restart often during development. Native TypeScript, native subprocess, native filesystem watchers, native HTTP. Effect.ts is supported on Bun. Trade-off acknowledged: smaller ecosystem of battle-tested production deploys than Node — but this isn't a production service, it's my personal automation.

### Trust posture and sandboxing

_Per §10.5 and §15.1, the implementation MUST document its approval/sandbox posture. With Claude Code we have two layers: the in-CLI permission system (analogous to Codex `approval_policy`) and an external OS sandbox. Which carries the safety weight?_

The **sandbox** is the boundary, not Claude's permission prompts. v1 wraps every `claude` invocation (and every workflow hook) in `nono.sh` and runs Claude itself with all in-session approvals auto-granted. Rationale: if the sandbox is doing its job, prompt-level approvals add friction without adding safety; if the sandbox isn't doing its job, prompt-level approvals are not what's going to save us. The base `nono.sh` permission set — what's read/write/network-allowed, what's denied — is itself a planning deliverable and a place where we'll need to find the line between "safe" and "doesn't choke the agent". This will be documented in `TRUST.md` per spec §15.1.

### Naming and distribution

_Should this be branded as a separate fork (e.g. `symphony-claude`) to avoid confusion with OpenAI's `symphony`, and should it be packaged for distribution?_

Keep the name `symphony` locally. It's not getting distributed — it runs out of `/Users/seth/dev/symphony` on my laptop and (later) on a remote Linux box I SSH into. No npm package, no compiled binary, no install script. The repo's `README.md` will be explicit that this is a from-scratch Effect.ts + Claude implementation of the OpenAI Symphony spec, not a fork of their codebase.

### Spec divergences to document

_§15.1 requires implementations to "state clearly" their trust model, and §10.5 requires implementations to document the approval/user-input policy. What needs to live in the repo as durable documentation?_

A `TRUST.md` at the repo root, covering: (1) the sandbox-first model and what `nono.sh`'s base permission set allows/denies; (2) Claude's in-session approval policy (auto-approve everything) and the rationale; (3) user-input-required handling (fail the turn); (4) how `linear_graphql` is scoped to the configured project; (5) the assumption that `WORKFLOW.md` hook scripts are fully trusted configuration (per §15.4). The spec itself calls this "part of the core safety model rather than an optional afterthought" — it's not docs-as-afterthought, it's a deliverable.

### Dependency management

_How are host-level dependencies (Bun, the `claude` CLI, `nono`, anything else the daemon shells out to) installed and pinned, given this runs locally now and on a Linux box later?_

A project `flake.nix` provides the dev shell with all binaries pinned. `nono` is in `nixpkgs` (`pkgs.nono`); `bun` is in `nixpkgs`; the `claude` CLI is fetched from Anthropic's release channel (or, if it's not packaged in nixpkgs, vendored as a derivation in the flake). `flake.lock` is checked in for reproducibility. The same flake works on macOS now and Linux later. This avoids the entire class of "works on my laptop" problems for a daemon meant to keep running unattended.

### Front matter namespace rename

_The spec's front matter has a `codex.*` section with Codex-specific keys (`approval_policy`, `thread_sandbox`, `turn_sandbox_policy`) that don't translate to Claude. Keep the namespace name, rename to `claude.*`, or generalize to `agent_runner.*`?_

`agent_runner.*`. Generalizing leaves room for a future second runner (Codex, Aider, an in-house thing) without another rename or shim. The keys are runner-typed under the hood — `agent_runner.permission_mode` reads Claude's permission-mode literals today; it'd read something else if the kind switches. This is one of the two declared spec divergences and goes in `TRUST.md`.

### Test framework

_Effect.ts has several test-helper options. Pick one._

`bun test` as the runner, `@effect/vitest` for `it.effect` / `it.live` helpers (its API is Jest/Vitest-compatible and `bun test` honors that). Effects-as-tests pay off in the orchestrator state machine where each test wants its own `TestClock` and `Layer`-injected mocks.

### Logging destination

_Stderr, file, syslog, mixed?_

Stderr as JSONL. The HTTP server's dashboard reads from an in-memory ring buffer of recent events for the operator-facing view. Single sink keeps `bun run` ergonomic — pipe to `tee`, `jq`, or a file as the operator sees fit. Matches §13.2's "operator-visible without a debugger" requirement.

### Claude approval surface

_With `--permission-mode bypassPermissions`, the CLI never asks. Do we wire the stdio permission-prompt tool anyway, for observability and future human-in-the-loop?_

Yes — `bypassPermissions` + `--permission-prompt-tool stdio`. The bypass mode does the real work in v1; the stdio prompt is a defense-in-depth observability channel. If any tool call somehow surfaces a `can_use_tool` request (a workflow hook downgrades, a future SDK update changes default behavior), Symphony sees it as a §10.4 `turn_input_required` event and responds `{behavior:"deny", interrupt:true}` to fail the turn. Cost is ~100 LOC of control-protocol JSON-RPC, which we need to build anyway for the SDK-MCP-routed `linear_graphql` tool.

### Prompt template engine

_Spec §5.4 mandates Liquid-compatible strict templating._

`liquidjs` with `strictVariables: true` and `strictFilters: true`. Widely used, full Liquid surface, strict-mode flags map exactly to §5.4's "unknown variables MUST fail rendering" / "unknown filters MUST fail rendering" requirements.

### Workspace root default

_Where do per-issue workspaces live?_

`<system-temp>/symphony_workspaces` (the spec default). On macOS this is `$TMPDIR/symphony_workspaces`, which OS purges at reboot — actually nice for fresh starts. Override per-workflow via `workspace.root` if a particular workflow needs persistence.
