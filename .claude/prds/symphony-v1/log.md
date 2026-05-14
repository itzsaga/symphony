# Implementation Log

Reverse-chronological. Newest entries at the top.

## 2026-05-14T00:48Z — Claude Code stream-json runner (top-level group, 4 subtasks)

**Status**: Completed (all 4 subtasks). Suite total: 221 pass / 0 fail across 18 files.

### Stream-json frame schemas
- `src/claude/StreamJson.ts` — Single discriminated `Schema.Union` of all wire frame variants (`UserMessage`, `AssistantMessage`, `SystemMessage` with init/api_retry/plugin_install/etc. sub-discrimination, `ResultMessage`, `StreamEvent`, `RateLimitEvent`, `ControlRequest` with can_use_tool/mcp_message/initialize sub-discrimination, `ControlResponse`, `ControlCancelRequest`, `TranscriptMirror`, `UnknownFrame` catch-all). Branded types (`SessionId`, `TurnId`, `MessageUuid`, `ToolUseId`, `RequestId`). Outbound frames (`OutboundUserMessage`, `OutboundControlResponse`, `OutboundControlCancelRequest`).
- `test/unit/claude/StreamJson.test.ts` — 25 tests, including round-trip per `system.api_retry.error` value and forward-compat decode of unknown `type`.
- Notes: Used index-signature `{ key: Schema.String, value: Schema.Unknown }` for excess-key tolerance (Effect's bundled `Schema.Struct` doesn't have `exact: false`). `rate_limit_info` decoded via `Schema.fromKey("resetsAt")` etc. so wire stays camelCase but internal shape is snake_case.

### Claude subprocess lifecycle
- `src/claude/argv.ts` — Pure builders for inner `claude` argv + matching `agent_runner` Sandbox policy (bare-flag flips both argv and policy axes).
- `src/claude/jsonlParser.ts` — Stateful line-delimited JSON parser with multi-line accumulation (bracket+string-aware), 1 MiB per-frame cap, sticky `StreamDecodeError` on overflow.
- `src/claude/ClaudeSubprocess.ts` — `spawn(opts)` factory returning a scope-bound resource (`incoming: Stream<StreamJsonMessage>`, `outgoing: Queue<OutboundFrame>` (bounded 16), `awaitExit`, `stderrTail`). Layered finalizer: stdin EOF → grace wait → Sandbox SIGTERM/SIGKILL.
- `test/unit/claude/{argv,jsonlParser,ClaudeSubprocess}.test.ts` — 30 new tests across 3 files. Integration tests use `Bun.spawn`-backed fake `Sandbox` Layer.
- Decisions: Per-call resource (not Tag); config injected directly (not via `WorkflowLoader`) to keep Layer deps light; stderr exposed as `Stream.empty<string>` + `stderrTail` Effect (live streaming deferred — would require extending Sandbox interface). `--bare` deferred to runtime config; static `claude --version` skipped (flake pins claude-code 2.1.137).
- **Latent bug discovered**: `src/sandbox/Nono.ts:294` has the same finalizer-interruptibility issue the subprocess hit — `Effect.timeoutOption` inside `Effect.addFinalizer` won't time out at the configured deadline because finalizers run uninterruptibly. Fix is `awaitExit.pipe(Effect.disconnect, Effect.timeoutOption(grace), Effect.interruptible)`. Currently latent (existing tests use SIGTERM-honoring children); would manifest if any caller hands the Sandbox a SIGTERM-ignoring child.

### Control-protocol RPC
- `src/claude/ControlProtocol.ts` — `serve(subprocess, handlers)` dispatcher; `defaultHandlers` (deny `can_use_tool` with `interrupt: true` + emit `TurnInputRequiredEvent` to optional Queue; default `mcpMessage` returns "no MCP server available"); `makeRequestIdGenerator()` for `req_<counter>_<4-hex>`.
- `test/unit/claude/ControlProtocol.test.ts` — 11 tests: deny-with-interrupt, blocked_path propagation, mcp_message routing, parallel handlers, cancel-interrupts-no-response, request-id format, initialize ack, etc.
- Decisions: Module-level `serve` function (not Tag — no shared state); `Effect.forkScoped` not `Effect.fork` for handlers (load-bearing — `fork` would interrupt handlers when consumer fiber EOFs); cancel removes inflight entry before `Fiber.interrupt` to avoid race with natural completion; `turn_input_required` event emitted by dispatcher (not handler) so custom `canUseTool` overrides still trigger it.

### Event mapping + token accounting
- `src/claude/sessionState.ts` — `ClaudeSessionState` record + `initialClaudeSessionState`. `claude_*_tokens` absolute totals + `last_reported_*_tokens` mirrors per §13.5.
- `src/claude/EventMapping.ts` — Pure `mapFrame(frame, state) → { events, newState }`, `synthesizeSessionId(threadId, turnId)`, `RuntimeEvent` discriminated union (19 variants via `Data.TaggedClass`), constructors for synthesized events (`TurnCancelled`, `TurnInputRequired`, `UnsupportedToolCall`, `Malformed`, `ProcessExited`).
- `test/unit/claude/EventMapping.test.ts` — 22 tests / 35 expects. Init + plugin_errors, success/error results, assistant.error, api_retry, token deltas, rate_limit, forward-compat, session-id synthesis, cache-token totals.
- Decisions: Pure module — plugin_errors surface as `Notification` events with `level: "warn"` (orchestrator turns into Logger calls); `claude_*_tokens` are absolute totals replaced (not added) from `result.usage`; `last_reported_*` is reducer-untouched, orchestrator computes deltas + writes back; `UnsupportedToolCall` constructor exported but not synthesized in v1 (orchestrator can correlate later).

## 2026-05-14T00:48Z — Interim entries (top-level tasks #3-#6)

Compact entries for tasks completed between the WorkflowLoader top-level group and the Claude runner top-level group:

### #3 Linear tracker client (1 leaf)
- `src/linear/{LinearClient,queries,schemas,normalize}.ts` + `test/unit/linear/{LinearClient,queries,normalize}.test.ts`. `Context.Tag` with `fetchCandidateIssues` / `fetchIssuesByStates` (empty-input shortcut, no HTTP) / `fetchIssueStatesByIds` (literal `[ID!]`) / `executeRaw` (raw passthrough for the future `linear_graphql` MCP tool). `@effect/platform` HttpClient with `Schedule.exponential(250ms) ⊕ Schedule.recurs(4)`. Auth via raw `Authorization: <api_key>` (no `Bearer`). Normalization per §11.3 (lowercased+deduped labels, blockers from inverse `blocks` relations, integer-only priority, ISO-8601 timestamps). Tests inject a `scriptedClient(...)` HttpClient stub. +34 tests.

### #4 Nono sandbox service (1 leaf)
- `src/sandbox/{policies,Nono}.ts` + `test/unit/sandbox/{policies,Nono}.test.ts`. `Sandbox` Tag with `spawn(opts)` returning a scope-bound `SandboxProcess`. Two policy variants — `agent_runner` (with bare-flag-driven `claude_home_access` + `credentials` axes) and `hook` — argv built by pure `agentRunnerArgv` / `hookArgv` in `policies.ts`. Uses `@effect/platform` `CommandExecutor` via `BunContext.layer`. Layered SIGTERM-grace-SIGKILL finalizer (default 5s grace). Stderr captured to a rolling ~8 KiB tail Effect (live `Stream.empty`). Best-effort `SandboxAccessDenied` detection via stderr regex. +12 tests, including real-`nono`-binary integration tests guarded by PATH check.
- **Research-doc correction**: `developer` is NOT a built-in nono profile. Actual built-ins: `default`, `claude-code`, `claude-no-kc`, `codex`, `node-dev`, `python-dev`, `rust-dev`, `go-dev`, `linux-host-compat`, `opencode`, `openclaw`, `swival`. WorkspaceHooks task uses `default` as a deliberate spec divergence.

### #5 Workspace manager + lifecycle hooks (2 subtasks, sequential)
- `src/workspace/WorkspaceManager.ts` — `prepareForIssue` (stat-classify, three-way creation), `cleanWorkspaceFor` (assertUnderRoot before mutation), `startupTerminalCleanup` (best-effort sweep). Reads `workspace.root` per call so dynamic reloads are honored. Errors: `WorkspaceCreationFailed | NonDirectoryAtWorkspacePath | CleanupFailed | PathEscape`. +11 tests.
- `src/workspace/Hooks.ts` — `runAfterCreate | runBeforeRun | runAfterRun | runBeforeRemove`. Reads scripts from `WorkflowLoader.current.config.hooks.*`; null/empty → no-op success. Spawns via `Sandbox.spawn` with `kind: "hook"` policy, `bash -lc <script>`, cwd = workspace.path, stdin = "null". `Effect.timeout(hooks.timeout_ms)` wrapper. Failure semantics per §9.4. `HookError` payload truncates stdout/stderr to 4 KiB head. Uses `default` profile (see correction above). +8 tests.

### #6 Prompt renderer (1 leaf)
- `src/prompt/Render.ts` + `test/unit/prompt/Render.test.ts`. Module-scoped `Liquid` engine with `{ strictVariables: true, strictFilters: true }`. Empty-body → `"You are working on an issue from Linear."` fallback. Errors disambiguated by liquidjs class + message: `TokenizationError` and `ParseError` (non-`undefined filter:`) → `TemplateParseError`; `UndefinedVariableError`, `RenderError`, `ParseError` (`undefined filter:`) → `TemplateRenderError`. +9 tests.

## 2026-05-13T23:50Z — WorkflowLoader service with file watch

**Status**: Completed

**Summary**: Effect service holding the current `WorkflowDefinition` in a `SubscriptionRef`, watching `WORKFLOW.md` (via parent dir + filename filter to handle rename-on-save editors), debouncing reloads (250ms), preserving last-known-good on invalid reload, broadcasting on a `changes` Stream. 7 new tests; suite total now 57 / 0.

**Changes Made**:
- `src/config/WorkflowLoader.ts` — Created. Service Tag + `WorkflowLoaderLive` Layer factory, scoped fiber teardown, realpath-resolved watch target, `Stream.debounce` over a `Queue.unbounded`, info log with diff summary on valid reload.
- `test/unit/config/WorkflowLoader.test.ts` — Created. Startup load, preflight + missing-file build failures, valid reload emits/updates, invalid reload preserves + warns, `validateForDispatch` post-reload, no-fd-leak teardown.

**Notes**:
- `SubscriptionRef` (not `Ref + Hub`) — its `changes` stream replays latest-on-subscribe, which matches dashboard/orchestrator subscriber needs.
- `fs.watch(dirname, { persistent: false })` — non-persistent so the watcher doesn't hold the Bun process alive; the scope is the lifetime owner.
- Diff summary tracks `agent_runner.max_turns`, `polling.interval_ms`, `server.port`, and `prompt_template changed`.

## 2026-05-13T23:42Z — Path safety invariants

**Status**: Completed

**Summary**: Pure §9.5 invariants module. `AbsolutePath` brand, `sanitizeWorkspaceKey`, `resolveWorkspacePath`, `assertCwdMatches`, `assertUnderRoot`. Best-effort symlink check via `realpath` on the candidate's parent. 21 unit tests.

**Changes Made**:
- `src/config/PathSafety.ts` — Created. Brand + constructors (`toAbsolutePath` Effect form + sync form), sanitization, containment with directory-aware prefix check, three `Data.TaggedError` types.
- `test/unit/config/PathSafety.test.ts` — Created. Sanitization, prefix-check semantics, `..` escape resistance via composition, trailing-slash normalization in `assertCwdMatches`.

**Notes**:
- `resolveWorkspacePath` containment is asserted unconditionally (sanitization should make it impossible) — escape is a defect, not an Effect failure.
- Symlink check `realpath`s the candidate's parent (not the candidate, which may not exist yet); skips silently if realpath fails (root-existence is WorkspaceManager's job).

## 2026-05-13T23:42Z — WORKFLOW.md schema and parser

**Status**: Completed

**Summary**: Pure parser for WORKFLOW.md — front-matter split, YAML decode, `$VAR` resolution, `~`/relative-path expansion (filesystem fields only), schema-driven defaults via Effect 3.21's bundled `Schema`, dispatch-preflight validator. `codex.*`-keyed workflows fail parse explicitly. 20 unit tests.

**Changes Made**:
- `src/config/WorkflowSchema.ts` — Created. Schemas, error types, `TypedConfig`/`WorkflowDefinition` interfaces, `REJECTED_TOP_LEVEL_KEYS` (`codex.*`).
- `src/config/parseWorkflow.ts` — Created. `parseWorkflow` + `validateForDispatch` (aggregates failures into `ValidationError.checks`).
- `src/config/envResolution.ts` — Created. `$VAR` indirection.
- `test/unit/config/parseWorkflow.test.ts` — Created. Round-trip, defaults, indirection, expansion, codex rejection, malformed YAML, integer/enum validation, all four §6.3 preflight checks.
- `src/config/.gitkeep` — Removed.

**Notes**:
- YAML via Bun's built-in `Bun.YAML.parse` (no new dep).
- Bundled `Schema` from `effect` (the deprecated `@effect/schema` dep remains in `package.json` for now; cleanup is a future task).
- `$VAR` and path resolution happen pre-schema so unresolved env errors get field-specific messages.
- Empty `$VAR` resolution for `tracker.api_key` is silently mapped to absence (per §6.4); only the dispatch preflight gates on its presence.

## 2026-05-13T23:25Z — AGENTS.md and CLAUDE.md

**Status**: Completed

**Summary**: Authored project-level memory files. `AGENTS.md` is 135 lines covering project overview, the two declared spec divergences, quickstart, commands, layout, coding conventions, spec conformance, where things live, and git/CI hygiene. `CLAUDE.md` is the canonical single-line `@AGENTS.md` import.

**Changes Made**:
- `AGENTS.md` — Created. 135 lines, well under the 200-line cap.
- `CLAUDE.md` — Created. Single line: `@AGENTS.md`.

**Notes**:
- Reiterated load-bearing global CLAUDE.md rules (no `any`/`!`/`@ts-nocheck`, no `--no-verify`, no Claude co-author trailers) so CI agents without `~/.claude/CLAUDE.md` still see them — without duplicating the full global rules file.
- Layout section references the actual `bun.lock` (text), not the spec's older `bun.lockb`.
- `TRUST.md` is referenced as a pointer; authoring it is its own task.

## 2026-05-13T23:25Z — Logger service

**Status**: Completed

**Summary**: Implemented the Effect Logger service with FiberRef-scoped context, JSONL stderr emission, in-memory ring buffer (default 500), and sink-failure isolation. 9 unit tests pass.

**Changes Made**:
- `src/observability/Logger.ts` — Created. `Logger` Tag, `LoggerLive` Layer + `layer({ sink, capacity })` test factory, `withContext` / `withIssue` / `withSession` helpers backed by a module-private FiberRef, `LogRecord` schema (Effect 3.21's built-in `Schema`), `recentEvents` accessor, `CircularBuffer` (FIFO), `safeStringify` (drops `undefined`, swaps cycles for `"<circular>"`).
- `test/unit/observability/Logger.test.ts` — Created. 9 tests covering JSONL emission, scoped context (`withIssue` + `withSession`), nested context merging, ring-buffer eviction, sink-failure isolation, snapshot semantics, default capacity, circular-ref serialization. Uses `bun:test` runner with `Effect.runPromise` (equivalent to `it.effect`, no extra binary).
- `src/observability/.gitkeep` — Deleted (replaced by real source file).

**Notes**:
- Used `Context.Tag` class form per the PRD's preference.
- `withContext`/`withIssue`/`withSession` are module-level helpers that depend only on the FiberRef (not on the service), so callers can establish context before the Logger Layer is provided. Helpers no-op cleanly when no Logger is installed.
- Field precedence in emitted records: `{ ...payload, ...ctx, timestamp, level }` — operator-set tracing context wins over caller-supplied keys; `timestamp`/`level` are always authoritative.
- Used Effect 3.21's bundled `Schema` rather than the deprecated `@effect/schema` package. `@effect/schema` is still in `package.json` deps for now — cleanup is a future task.

## 2026-05-13T23:14Z — Bun + TypeScript + Effect setup

**Status**: Completed

**Summary**: Stood up the TypeScript/Bun project skeleton. `bun install`, `bun run typecheck`, and `bun test` all exit 0. `src/main.ts` stub validates the WORKFLOW.md arg, logs startup to stderr, and exits 1 (missing file) / 2 (missing arg).

**Changes Made**:
- `package.json` — Created. Deps: effect ^3.21.2, @effect/platform ^0.96.1, @effect/platform-bun ^0.89.0, @effect/schema ^0.75.5, liquidjs ^10.25.7. Dev: @effect/vitest ^0.29.0, @types/bun ^1.3.14, typescript ^5.7.0. Scripts: dev/start/test/typecheck per spec.
- `tsconfig.json` — Created. Strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + bundler resolution + ESNext + verbatimModuleSyntax.
- `bun.lock` — Created via `bun install` (note: bun v1.2+ defaults to text `bun.lock` instead of binary `bun.lockb`).
- `.gitignore` — Created. Covers node_modules/, build artifacts, .direnv/, result*.
- `src/main.ts` — Created. CLI entry stub.
- `src/{config,linear,workspace,sandbox,claude,prompt,orchestrator,http,observability}/.gitkeep` — Created. Service-graph skeleton from PRD §Architecture.

**Notes**:
- Spec called for `bun.lockb`; actual artifact is `bun.lock` (text-based) — current bun default. Functionally equivalent for lockfile purposes.
- Subagent hit an internal API error after producing all files but before reporting back; verification was completed externally.

## 2026-05-13T23:08Z — Nix flake dev shell

**Status**: Completed

**Summary**: Authored `flake.nix` + `flake.lock` + `.envrc` providing a reproducible dev shell with `bun`, `nono`, `claude-code`, `git`, `jq`, `yq-go` for `aarch64-darwin` and `x86_64-linux`.

**Changes Made**:
- `flake.nix` — Created. Pins nixpkgs to `da5ad661ba4e5ef59ba743f0d112cbc30e474f32`, builds `devShells.default` via `flake-utils.lib.eachSystem`, gates unfree allowlist to `claude-code` only.
- `flake.lock` — Created via `nix flake lock`. Locks nixpkgs + flake-utils + flake-utils/systems.
- `.envrc` — Created with `use flake` for direnv users.

**Notes**:
- `pkgs.claude-code` exists in nixpkgs at the pinned commit (v2.1.137); did not need a custom derivation.
- Used `eachSystem ["aarch64-darwin" "x86_64-linux"]` rather than `eachDefaultSystem` so `nix flake check --all-systems` is honest about supported platforms.
- `nix flake check --all-systems` and all `nix develop --command <tool> --version` invocations exited 0.
