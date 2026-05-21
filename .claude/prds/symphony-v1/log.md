# Implementation Log

Reverse-chronological. Newest entries at the top.

## 2026-05-21T14:19Z — TRUST.md (top-level, 1 leaf)

**Status**: Completed. Suite total: 413 pass / 0 fail across 32 files (+5 tests, +1 file).

### Changes
- `TRUST.md` — 190-line trust-model document at repo root. Eight numbered sections: (1) trust model summary (single-operator, sandbox-first), (2) the actual `nono` policy for `claude` invocations split by `agent_runner.bare`, including `~/.claude` access semantics + hook profile choice, (3) agent approval policy (`--permission-mode bypassPermissions --permission-prompt-tool stdio`; `can_use_tool` denied with `interrupt: true`), (4) user-input-required handling (fail run + orchestrator retry), (5) `linear_graphql` scoping caveats (operator provisions minimum-scope API key), (6) hook-script trust assumption per §15.4, (7) the two declared spec divergences (`claude` replaces `app-server`; `agent_runner.*` replaces `codex.*`), (8) secret handling per-mode, (9) honest "what this does NOT defend against" list (prompt injection in issue descriptions, malicious GraphQL responses, supply-chain compromise, etc.).
- `test/unit/docs/TRUST.md.test.ts` — 5 tests covering: file exists, contains the literal sentinel `nono run --network-profile claude-code` (so sandbox-argv drift surfaces as a test failure), references both spec divergences with regex matching that tolerates light copy-editing, references `agent_runner.bare` semantics, and notes the §15.4 hook-script trust assumption.

### Decisions
- **Doc reflects code reality, not the spec's illustrative argv.** Verified that `src/sandbox/policies.ts::agentRunnerArgv` emits in the same order as the spec example (credentials → workspace → workflow-dir read → `~/.claude` read|allow → system-bin reads → `--`). No drift detected.
- **`test/unit/docs/` is a new directory** for doc-invariant tests. Future SPEC.md vendor-freshness checks or AGENTS.md invariants belong here.
- **Sentinel-argv test uses literal `toContain`** because that's the tie to sandbox argv shape; divergence assertions use bounded regex so light copy-editing of TRUST.md §7 doesn't break the test, but losing either divergence will.

## 2026-05-21T13:58Z — Application wiring and startup (top-level, 1 leaf)

**Status**: Completed. Suite total: 408 pass / 0 fail across 31 files (+25 tests across 2 new files).

### Changes
- `src/main.ts` — Replaced the bootstrap stub with the full daemon entrypoint: parse argv via `parseCli`, build the layer graph bottom-up, run the §8.6 startup terminal-workspace cleanup, then block on a `Deferred<void>` so the orchestrator's tick fiber owns the lifetime. `BunRuntime.runMain` handles signal-as-interrupt and exit codes; custom `teardown` maps both Success and Interrupt cause to exit 0 per §17.7.
- `src/cli.ts` — Pure `parseCli(argv)` returning `{ workflowPath, port, errors }`. Hand-parsed: positional first, then `--port <N>` / `--port=<N>`. Rejects unknown flags, malformed values, out-of-range ports, multiple positionals. Exports `USAGE`. No CLI library dependency.
- `src/orchestrator/Orchestrator.ts` — Fixed the `workspace_path` bug flagged by the HTTP task: `forkOneWorker` now computes the per-issue path via `resolveWorkspacePath(root, identifier)` (the same resolver `WorkspaceManager.prepareForIssue` uses) and threads it into `newRunningEntry`. The §13.7.2 dashboard/JSON now surfaces e.g. `/tmp/symphony_workspaces/MT-649` instead of the bare workspace root.
- `test/unit/cli.test.ts` — 18 tests covering positional/`--port`/`--port=`/port-0/max-port/both-args, unknown long & short flags, missing port value, non-numeric/out-of-range/negative/non-integer/empty port values, second-positional error, and multi-error collection.
- `test/integration/startup.test.ts` — 7 subprocess-driven tests: nonexistent explicit path → exit nonzero with stderr referencing the missing file; missing default `./WORKFLOW.md`; unknown flag; malformed `--port`; clean SIGTERM exit (no HTTP); `--port 0` ephemeral HTTP serving `/api/v1/state` returning 200; clean SIGINT exit.

### Layer composition (final shape)
- `LoggerLive` at the root.
- `Sandbox.Live` → `LinearClient.Live`, `WorkspaceManager.Live`, `WorkspaceHooks.Live`, `Prompt` (pure), `WorkflowLoader.Live`.
- `McpServerLive` depends on `LinearClient` + `Logger`.
- `OrchestratorLive` depends on `WorkflowLoader`, `LinearClient`, `WorkspaceManager`, `WorkspaceHooks`, `Sandbox`, `McpServer`, `Logger`.
- `ServerLive` + `RoutesLive` peer-merged via `Layer.mergeAll(ServerLive, RoutesLive)` (the load-bearing rule from the HTTP task) so both share the same `SymphonyHttpRouter.Live` instance and the routes actually land in the served snapshot.
- `CliFlags` is built per-startup as `Layer.succeed(CliFlags, { port })` from the already-parsed CLI value, so argv is only parsed once (not re-parsed by `CliFlagsLive`).

### Startup sequence (§16.1)
1. `parseCli(argv)`. Bad CLI → exit nonzero with usage and stderr error.
2. Layer build (includes `WorkflowLoader` preflight). Bad workflow → `Effect.tapErrorCause` writes `startup failure: <cause>` to stderr, exit nonzero.
3. §8.6 startup cleanup: `LinearClient.fetchIssuesByStates(config.tracker.terminal_states)` → `WorkspaceManager.startupTerminalCleanup(identifiers)`. Fetch failure logs warn and continues; cleanup failure logs warn per-workspace and continues.
4. Block on `Deferred<void>` until interrupted.

### Decisions
- **`BunRuntime.runMain` over hand-rolled signal hooks.** Already handles signal-as-interrupt + exit codes; rolling our own would duplicate the logic and risk drift.
- **CliFlags stays in `src/http/Server.ts`** because `--port` is the only HTTP flag and the Tag stays single-purpose. `main.ts` builds its own `Layer.succeed(CliFlags, { port })` from `parseCli`'s output.
- **Workspace-path fix uses the pure resolver** rather than threading the value out of `WorkspaceManager.prepareForIssue`. `newRunningEntry` must be built BEFORE `WorkerStarted` fires, but `prepareForIssue` runs inside `runWorker` later in the fiber lifecycle. Both sides agree because they share `resolveWorkspacePath`.
- **`test/integration/` is a new directory.** Startup tests aren't `LINEAR_API_KEY`-gated because they use a fake key in fixtures; they exercise startup/signals/HTTP, not §17.8 real-Linear behavior. §17.8 gating belongs to the next top-level task.

### Latent observations
- `bun test`'s default discovery picks up `test/integration/**` automatically. The §17.8 audit task will need to either gate at the `it` level or split test patterns in `package.json`. Startup tests should keep running unconditionally.

## 2026-05-21T13:46Z — HTTP server extension (top-level group, 2 subtasks)

**Status**: Completed. Suite total: 383 pass / 0 fail across 29 files (+46 tests across 4 new files).

### HTTP server setup and port handling
- `src/http/Server.ts` — `ServerLive` Layer (scoped via `BunHttpServer.layer` from `@effect/platform-bun`), `CliFlags` Tag + `CliFlagsLive` (parses `--port <N>` and `--port=<N>` from `Bun.argv.slice(2)`) + `CliFlagsTest(port)` for tests, `SymphonyHttpRouter` Tag built on `HttpRouter.Tag("symphony/http/Router")<SymphonyHttpRouter>()`, request-logging middleware (one JSONL info line per request: method/path/status/duration_ms), workflow-reload watcher that emits a warn record when `server.port` changes (restart-required, no hot-rebind). Loopback bind only. 5s idle timeout. No-op when neither CLI `--port` nor `server.port` is set (still provides the `SymphonyHttpRouter.Live` Tag so dependent Layers typecheck; logs an info record explaining).
- `test/unit/http/Server.test.ts` — 9 tests: `parsePortFlag` (4 forms), `ServerLive` no-port no-op, CLI override, ephemeral port logging, listener teardown, workflow-reload warn.

### JSON API and dashboard
- `src/http/snapshot.ts` — `OrchestratorRuntimeState → ApiState` translator. Performs the spec-mandated boundary renames `claude_totals → codex_totals` and `*_session_logs → codex_session_logs` (the internal `claude_*` field names stay per `TRUST.md` divergence; only the HTTP wire surface uses `codex_*`). ISO-8601 timestamps via `Date.toISOString()`. `findByIdentifier` resolves a path segment to either a `RunningEntry` or `RetryEntry`, accepting both `issue_identifier` and raw `issue_id`.
- `src/http/Dashboard.ts` — Server-rendered HTML for `/`. Tagged-template `html\`...\`` helper escapes every interpolated string through `escapeHtml`. Includes `<meta http-equiv="refresh" content="5">` (v1 polls via meta-refresh; no JS, no WebSocket/SSE), summary cards (running/retrying counts, token totals, cumulative runtime), running/retry/rate-limit/recent-event tables, inline stylesheet.
- `src/http/Api.ts` — `RoutesLive` Layer contributing four routes via `SymphonyHttpRouter.use(...)`: `GET /`, `GET /api/v1/state` (§13.7.1 shape with the rename), `GET /api/v1/<identifier>` (§13.7.2 shape; resolves by identifier or id; 404 on miss), `POST /api/v1/refresh` (enqueues `ImmediateTickRequested`; coalesces within 1s via `Effect.Ref<{ lastQueuedAt: Date | null }>` and returns `{ queued: false, coalesced: true }` for duplicates). JSON error envelope `{ "error": { "code", "message" } }`. 405 + `Allow` header for unsupported methods on defined routes.
- `test/unit/http/{snapshot,Dashboard,Api}.test.ts` — 36 tests: 13 snapshot (rename, ISO-8601 conversion, lookup-by-identifier-or-id), 13 Dashboard (`escapeHtml`, tagged template, full markup, XSS payload in identifier is not interpreted), 10 Api end-to-end against a real ephemeral-port server with stub Orchestrator/Logger (state shape, per-issue running view, per-issue retry view, 404 envelope, refresh enqueue + 1s coalescing, 405 for `PATCH /refresh` and `POST /state`, dashboard HTML, XSS guard).

### Decisions
- **Boundary rename location.** `claude_totals → codex_totals` and `codex_session_logs` happen exclusively in `snapshot.ts`; internal types unchanged. Documented inline.
- **Single `/api/v1/:identifier` route with internal dispatch.** `find-my-way` (the router under `HttpRouter.Tag`) refuses to register both a method-specific route and an `all` route for the same path, and 405-with-Allow couldn't otherwise be expressed cleanly. `state` / `refresh` / `<identifier>` dispatch happens in the handler.
- **Composition contract: `Layer.mergeAll(ServerLive, RoutesLive)`, not `Layer.provideMerge`.** `application-wiring.md` must use the merge form so both Layers share the same `SymphonyHttpRouter.Live` instance via the outer memoMap — otherwise the `serve` Layer captures an empty route snapshot. Documented in `RoutesLive`'s JSDoc. Worth a smoke test in the wiring task.
- **`logs.codex_session_logs`** is always an explicit empty array in v1 (we don't persist session logs to file), not an omitted field.
- **`attempts.restart_count`** hardcoded to 0 in v1 — we only track retry attempts, no separate restart counter. §18.2 persistence work would change that.

### Latent observations (out of scope, flagged for follow-up)
- **`RunningEntry.workspace_path` is the workspace ROOT, not the per-issue directory.** Origin: `src/orchestrator/Orchestrator.ts:397` writes `workspace_path: workflow.config.workspace.root` into `newRunningEntry`. The §13.7.2 example shows the per-issue path (e.g. `/tmp/symphony_workspaces/MT-649`). Fix is one of: (a) orchestrator resolves the per-issue path and stores that, or (b) `snapshot.ts` derives `<root>/<sanitize(identifier)>` at the boundary. Address in application-wiring or a follow-up.
- **`recent_events[].event` field** falls back from `last_event` → `msg` (the Logger's actual wire field) because there's no §10.4-kind tag on log records today. Higher-fidelity feed would require the orchestrator/worker to attach `event_kind` to each log call.
- **`@effect/platform-bun`'s server finalizer** doesn't await `server.stop()` — fine for clean shutdowns at v1 scale, but a long-lived keep-alive connection could delay teardown. Documented in `Server.test.ts`'s teardown comment.

## 2026-05-21T02:52Z — Orchestrator (top-level group, 4 subtasks)

**Status**: Completed. Suite total: 337 pass / 0 fail across 25 files (+70 tests across 6 new files).

### State and reducer
- `src/orchestrator/State.ts` — `OrchestratorRuntimeState` matching §4.1.8 with our internal `claude_*` token field names; `RunningEntry` per §4.1.5–§4.1.6 (issue snapshot, started_at, session_id, thread_id, last_event/timestamp/message, token counters incl. `last_reported_*`, retry_attempt, turn_count); `RetryEntry` per §4.1.7 (`Fiber.Fiber<void, never>` for `timer_handle`); pure `reduce(state, event): { state, sideEffects }` using `Match.value(event).pipe(Match.tagsExhaustive({...}))` so unhandled variants are a compile error. Exported constants `CONTINUATION_RETRY_DELAY_MS = 1000`, `DEFAULT_MAX_RETRY_BACKOFF_MS = 300_000`, `DEFAULT_MAX_CONCURRENT_AGENTS = 10`.
- `src/orchestrator/events.ts` — `OrchestratorEvent` tagged union (9 variants per §7.3 + the two non-§7.3 events: `WorkflowReloaded`, `ImmediateTickRequested`).
- `src/orchestrator/sideEffects.ts` — `SideEffect` tagged union (`DispatchWorker`, `InterruptWorker`, `ScheduleRetry`, `CancelRetry`, `CleanupWorkspace`, `UpdateIssueSnapshot`, `Log`, `EmitMetric`).
- `test/unit/orchestrator/State.test.ts` — 25 tests (initial state, every event variant, exhaustiveness sweep, token delta math, retry cancel on WorkerStarted, normal-vs-abnormal exit retry scheduling, case-insensitive state match).

### Dispatch
- `src/orchestrator/Dispatch.ts` — `selectDispatchBatch(candidates, state, config): { toDispatch, reasons_skipped }`, pure. Eligibility per §8.2: required fields, active-not-terminal state, not-running, not-claimed, todo-blocker-non-terminal, global slot (recomputed as `toDispatch` accumulates), per-state slot fallback to global. `SkipReason` discriminated union (6 variants: `StateNotActive | AlreadyRunning | AlreadyClaimed | TodoBlocked | NoGlobalSlot | NoPerStateSlot`). Stable §8.2 sort: priority asc (null last), `created_at` oldest first, `identifier` lex tie-breaker.
- `test/unit/orchestrator/Dispatch.test.ts` — 25 tests including the §8.2 regression "blockers exist but all terminal is eligible".

### Reconcile
- `src/orchestrator/Reconcile.ts` — `reconcileStalled(state, config, now)` (Part A: `elapsed_ms > stall_timeout_ms` with `last_event_at ?? started_at`, disabled when `stall_timeout_ms <= 0`) and `reconcileTrackerStates(state, refreshed, terminal_states, active_states)` (Part B: terminal → InterruptWorker + CleanupWorkspace; active → UpdateIssueSnapshot; neither → InterruptWorker only). Both pure, deterministic; `now` is passed in for `TestClock`-friendly tests.
- Returns the richer `{ events, sideEffects }` shape rather than the spec's literal `ReadonlyArray<SideEffect>` — because Part A also emits a `StallDetected` event in addition to side effects, and emitting events through a side-effect array would be a type lie.
- `test/unit/orchestrator/Reconcile.test.ts` — 20 tests.

### Retry + tick fiber
- `src/orchestrator/Retry.ts` — Pure backoff math (`computeFailureBackoffMs`, `computeContinuationDelayMs`), `RetryRegistry` with cancel-then-replace semantics, `retryTimerEffect` driven by `Effect.sleep` so tests run under `TestClock`.
- `src/orchestrator/Worker.ts` — Per-issue worker pipeline: workspace prepare → `after_create` hook (only if `created_now`) → prompt render → spawn `claude` via `ClaudeSubprocess` → `ControlProtocol.serve` with `McpServer.handle` as the `mcpMessage` handler → ingest frames via `EventMapping.mapFrame` → enqueue runtime events into the orchestrator queue → turn loop (`runBeforeRun` → wait for `TurnCompleted`/`TurnFailed`/`TurnInputRequired` → `runAfterRun` → refresh issue state → break if state non-active or `turn_count >= max_turns`). `claude` subprocess scope is a child `Effect.scoped` block so a stall-driven interrupt tears it down cleanly.
- `src/orchestrator/Orchestrator.ts` — `Orchestrator` `Context.Tag` (`state: Effect<OrchestratorRuntimeState>`, `stateChanges: Stream`, `enqueue: (event) => Effect<void>`). `OrchestratorLive` scoped Layer: forks consumer fiber (drains bounded `Queue<OrchestratorEvent>(1024)`, applies `reduce`, interprets side effects), tick fiber (poll loop at `state.poll_interval_ms`, calls `reconcileStalled` → `LinearClient.fetchIssuesByStates` → `reconcileTrackerStates` → `validateForDispatch` → `LinearClient.fetchCandidateIssues` → `selectDispatchBatch`), workflow-reload subscriber on `WorkflowLoader.changes`. `ImmediateTickRequested` fires the tick immediately and resets the next-tick countdown.
- `test/unit/orchestrator/{Retry,Worker,Orchestrator}.test.ts` — 25 new tests (14 Retry under `TestClock`; 3 Worker abnormal paths; 8 Orchestrator integration: poll tick fires, immediate tick coalesces, workflow reload propagates interval, abnormal-exit backoff, slot exhaustion at retry-fire re-queues, stall reconcile interrupts running worker, stateChanges stream, smoke).

### Cross-cutting schema additions (in scope per spec wiring)
- `src/config/WorkflowSchema.ts` + `src/config/parseWorkflow.ts` — Added three previously-missing fields to `AgentRunnerSchema` + `TypedConfig`:
  - `max_concurrent_agents` (default 10) — global slot cap per spec §5.3.5.
  - `max_concurrent_agents_by_state` (default `{}`) — per-state cap map.
  - `max_retry_backoff_ms` (default 300_000) — cap for §8.4 exponential backoff.
- `Dispatch.ts` now reads `max_concurrent_agents` and `max_concurrent_agents_by_state` as typed fields (replacing the structural `Record<string, unknown>` reads it shipped with).
- `State.ts::initialState` now seeds `state.max_concurrent_agents` from `config.agent_runner.max_concurrent_agents`; `onWorkflowReloaded` honors live changes to that field per §6.2.
- Test fixtures across `argv`, `ClaudeSubprocess`, `McpServer`, `parseWorkflow`, `LinearClient`, `Hooks`, `WorkspaceManager`, `Dispatch`, `Reconcile`, `State` updated to include the three new fields.

### Decisions worth flagging
- **Dual-path reconcile resolution.** The reducer's `onReconciliationStateRefresh` and `onStallDetected` handlers stay intact (already covered by `State.test.ts`). The tick fiber routes through `Reconcile.ts` directly for Part A/B effects, not through `ReconciliationStateRefresh` events — that reducer branch is now dead code reachable only from existing tests. Decision: leave it for now (touching the reducer outside this task's scope risks breaking those tests for no behavioral benefit). Cleanup is a future PR.
- **`UpdateIssueSnapshot` semantics.** Updates only `entry.issue.state` from the refreshed minimal projection, matching the reducer's existing branch. Other Issue fields stay frozen until the next candidate fetch.
- **`CleanupWorkspace` does not run `before_remove`** in the reconcile-driven path — by the time the side effect fires, the worker scope (which owned the `Workspace` handle) has already torn down, and synthesizing a hook-compatible `Workspace` would duplicate path resolution. Documented inline; follow-up tracked.
- **§16.6 retry-fire re-queue** updates the SubscriptionRef directly when `selectDispatchBatch` returns no toDispatch entries — because `onRetryTimerFired` already removed the prior entry, and nothing else would re-insert it.
- **Continuation prompt is hard-coded** (`"Continue working on issue X. This is turn N."`). A future task can expose `continuation_template` in WORKFLOW.md.
- **TestClock used for `Retry.test.ts` only.** Orchestrator integration tests use real `Effect.sleep` with short intervals (100–500ms) because the synthesis cost of injecting a TestClock through the whole fiber graph isn't worth it for an integration test that just needs to observe one or two ticks.

### Latent observations (not fixed, out of scope)
- Worker turn loop polls `turnEndedRef` at 50ms granularity (no `Deferred`-per-turn). Acceptable for v1 pacing.
- `before_remove` hook coverage for the reconcile-driven cleanup path is a documented gap; running it would require carrying `Workspace` handles outside the worker scope.

## 2026-05-21T00:55Z — In-process MCP server and linear_graphql tool (top-level, 1 leaf)

**Status**: Completed. Suite total: 242 pass / 0 fail across 19 files (+21 tests, +1 file).

### Changes
- `src/claude/mcpSchemas.ts` — Effect Schemas for MCP JSON-RPC wire frames: `JsonRpcRequest`, `ToolsCallParams`, standard `JsonRpcErrorCode` enum (`ParseError`/`InvalidRequest`/`MethodNotFound`/`InvalidParams`/`InternalError`), plus exported types for the outbound envelopes (`JsonRpcSuccessResponse`, `JsonRpcErrorResponse`, `ToolCallResult`, `InitializeResult`, `ToolDescriptor`). Open index-signature `{ key: Schema.String, value: Schema.Unknown }` for excess-key tolerance, matching `StreamJson.ts`'s style.
- `src/claude/linearGraphqlTool.ts` — `linear_graphql` tool: input narrowing (object form + raw-string shorthand per §10.5), `countOperations` hand-rolled GraphQL scanner (strings/comments stripped, keyword + brace-depth state machine, anonymous `{ … }` shorthand counted as one operation), auth precondition via `WorkflowLoader.current`, execution via `LinearClient.executeRaw`, result mapping (success → `success: true`; GraphQL `errors` array → `isError: false, success: false` with full body preserved; host failure → `isError: true` with code).
- `src/claude/McpServer.ts` — `McpServer` `Context.Tag` + `McpServerLive` Layer + JSON-RPC dispatcher routing `initialize`, `tools/list`, `tools/call`, `notifications/initialized`. Advertises `protocolVersion: "2025-06-18"`, `serverInfo: { name: "symphony", version: <package.json> }`, `capabilities: { tools: {} }`. Unknown methods → `MethodNotFound` JSON-RPC error; unknown tool names inside `tools/call` → tool-level `isError: true` (§10.5 "continue the session"). Re-exports `LINEAR_GRAPHQL_TOOL_NAME` / `linearGraphqlToolDescriptor` so the orchestrator wiring can import a single canonical name.
- `test/unit/claude/McpServer.test.ts` — 21 tests: handshake, `tools/list` exposes only `linear_graphql`, valid invocation, GraphQL-errors path preserves body, empty-query (`missing_query`), multi-operation rejection, raw-string shorthand, unknown-tool tool-error (not transport error), API-key redaction across all five JSON-RPC paths, plus 7 `countOperations` unit tests (string-literal evasion, field-name evasion, anonymous shorthand).

### Decisions
- **`countOperations` scanner** chosen over `graphql-js` (~150KB for one method). Hand-rolled scanner strips strings/comments, then state-machines on keyword + brace depth. Trade-off documented in the file header.
- **Auth precondition lives in the tool, not LinearClient.** `LinearClient.executeRaw` would also fail with `LinearRequestFail` on missing auth, but mapping to `missing_auth` at the tool layer gives the model a stable error contract.
- **API-key redaction is structural**, not regex-filtered: the key never enters any log payload (verified by the redaction test scanning every captured line for the secret literal).
- **`MCP_PROTOCOL_VERSION` pinned** as a constant for future bumps.

### Latent observations (not fixed, out of scope)
- `stubWorkflowLoader` helpers are hand-rolled `as never` casts in `LinearClient.test.ts`, `Hooks.test.ts`, `WorkspaceManager.test.ts`, and now `McpServer.test.ts`. A shared `test/fixtures/stubWorkflowLoader.ts` would dedupe — separate task.
- `mcpSchemas.ts` exports several types-only schemas (outbound envelopes) not currently decoded at runtime; kept for parity with the wire-shape-per-schema pattern established in `StreamJson.ts`.

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
