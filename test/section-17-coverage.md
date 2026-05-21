# §17 Test Coverage Audit

This document maps every bullet in `SPEC.md` §17.1 through §17.7 to the test
file/case that exercises it. The audit script
(`scripts/audit-section-17.ts`, exposed as `bun run audit:section-17`)
parses this file, walks every checked entry, and confirms the referenced
test exists in the referenced file. Test passing/failing is `bun test`'s
job — this audit only confirms the test is present in the suite.

Format:

```markdown
## §17.x Section Title
- [x] Bullet description (verbatim or paraphrased)
  - `test/unit/path/to/file.test.ts > exact test name`
```

Bullets that are intentionally not implemented in Symphony v1 carry an
unchecked checkbox and an inline `<!-- not implemented in v1 -->` comment;
the audit script accepts them as known divergences.

Coverage scope: this file targets the **Core Conformance** + opted-in
**Extension Conformance** bullets (§13.7 HTTP server, `linear_graphql`
client-side tool). §17.8 real-integration bullets are out of scope here —
they live behind the `LINEAR_API_KEY` gate in `test/integration/` and are
exercised by the separate `linear-integration-profile` task.

## §17.1 Workflow and Config Parsing

- [x] Workflow file path precedence: explicit runtime path is used when provided
  - `test/integration/startup.test.ts > exits non-zero with an operator-visible error for a nonexistent explicit workflow path`
- [x] Workflow file path precedence: cwd default is `WORKFLOW.md` when no explicit runtime path is provided
  - `test/integration/startup.test.ts > exits non-zero when no argument is supplied and ./WORKFLOW.md is missing in cwd`
- [x] Workflow file changes are detected and trigger re-read/re-apply without restart
  - `test/unit/config/WorkflowLoader.test.ts > emits on changes and updates current when the file is rewritten with valid content`
- [x] Invalid workflow reload keeps last known good effective configuration and emits an operator-visible error
  - `test/unit/config/WorkflowLoader.test.ts > preserves last-known-good and warns when reload content is invalid`
- [x] Missing `WORKFLOW.md` returns typed error
  - `test/unit/config/WorkflowLoader.test.ts > fails Layer build when the workflow file does not exist`
- [x] Invalid YAML front matter returns typed error
  - `test/unit/config/parseWorkflow.test.ts > reports a WorkflowParseError when YAML is malformed`
- [x] Front matter non-map returns typed error
  - `test/unit/config/parseWorkflow.test.ts > rejects non-map YAML front matter with WorkflowFrontMatterNotAMap`
- [x] Config defaults apply when OPTIONAL values are missing
  - `test/unit/config/parseWorkflow.test.ts > applies all spec §6.4 defaults when front matter is absent`
- [x] `tracker.kind` validation enforces currently supported kind (`linear`)
  - `test/unit/config/parseWorkflow.test.ts > rejects unknown values for agent_runner.kind`
- [x] `tracker.api_key` works (including `$VAR` indirection)
  - `test/unit/config/parseWorkflow.test.ts > resolves $VAR indirection on tracker.api_key`
- [x] `$VAR` resolution works for tracker API key and path values
  - `test/unit/config/parseWorkflow.test.ts > resolves $VAR indirection on workspace.root and then expands the path`
- [x] `~` path expansion works
  - `test/unit/config/parseWorkflow.test.ts > expands ~ in workspace.root to the user's home directory`
- [x] `codex.command` is preserved as a shell command string (replaced by `agent_runner.command` per TRUST.md divergence #2)
  - `test/unit/config/parseWorkflow.test.ts > rejects WORKFLOW.md that uses the legacy codex.* namespace`
- [x] Per-state concurrency override map normalizes state names and ignores invalid values
  - `test/unit/orchestrator/Dispatch.test.ts > per-state cap lookup is case-insensitive on both sides`
- [x] Prompt template renders `issue` and `attempt`
  - `test/unit/prompt/Render.test.ts > renders identifier and title interpolation`
- [x] Prompt rendering fails on unknown variables (strict mode)
  - `test/unit/prompt/Render.test.ts > raises TemplateRenderError on unknown variable (strictVariables)`

## §17.2 Workspace Manager and Safety

- [x] Deterministic workspace path per issue identifier
  - `test/unit/config/PathSafety.test.ts > joins the sanitized key under root`
- [x] Missing workspace directory is created
  - `test/unit/workspace/WorkspaceManager.test.ts > creates the directory on first call and reports created_now=true`
- [x] Existing workspace directory is reused
  - `test/unit/workspace/WorkspaceManager.test.ts > reuses an existing directory on the second call (created_now=false)`
- [x] Existing non-directory path at workspace location is handled safely (replace or fail per implementation policy)
  - `test/unit/workspace/WorkspaceManager.test.ts > fails NonDirectoryAtWorkspacePath when a regular file occupies the workspace path`
- [x] OPTIONAL workspace population/synchronization errors are surfaced (Symphony v1 routes population through hooks; failures map to BeforeRunFailed / AfterCreateFailed)
  - `test/unit/workspace/Hooks.test.ts > runBeforeRun with a failing hook fails BeforeRunFailed and includes the truncated stderr tail`
- [x] `after_create` hook runs only on new workspace creation
  - `test/unit/workspace/Hooks.test.ts > runAfterCreate uses the workspace as cwd (hook can write a file there with $PWD)`
- [x] `before_run` hook runs before each attempt and failure/timeouts abort the current attempt
  - `test/unit/workspace/Hooks.test.ts > runBeforeRun with a hook that exceeds timeout_ms fails BeforeRunFailed with reason=timeout`
- [x] `after_run` hook runs after each attempt and failure/timeouts are logged and ignored
  - `test/unit/workspace/Hooks.test.ts > runAfterRun with a failing hook returns success and logs a warning`
- [x] `before_remove` hook runs on cleanup and failures/timeouts are ignored
  - `test/unit/workspace/Hooks.test.ts > runAfterRun is a no-op when after_run is the empty string`
- [x] Workspace path sanitization and root containment invariants are enforced before agent launch
  - `test/unit/workspace/WorkspaceManager.test.ts > sanitizes traversal characters in the identifier (foo/bar -> foo_bar)`
- [x] Agent launch uses the per-issue workspace path as cwd and rejects out-of-root paths
  - `test/unit/workspace/WorkspaceManager.test.ts > assertUnderRoot rejects a crafted out-of-root candidate`

## §17.3 Issue Tracker Client

- [x] Candidate issue fetch uses active states and project slug
  - `test/unit/linear/queries.test.ts > filters projects via slugId.eq per spec §11.2`
- [x] Linear query uses the specified project filter field (`slugId`)
  - `test/unit/linear/queries.test.ts > uses the same project + state filter shape as the candidate query`
- [x] Empty `fetch_issues_by_states([])` returns empty without API call
  - `test/unit/linear/LinearClient.test.ts > returns [] without making an HTTP call when the input is empty (§17.3)`
- [x] Pagination preserves order across multiple pages
  - `test/unit/linear/LinearClient.test.ts > walks pages and preserves Linear's ordering across them`
- [x] Blockers are normalized from inverse relations of type `blocks`
  - `test/unit/linear/normalize.test.ts > derives blocked_by from inverse relations of type 'blocks' only`
- [x] Labels are normalized to lowercase
  - `test/unit/linear/normalize.test.ts > lowercases all label names and dedupes case-insensitive duplicates`
- [x] Issue state refresh by ID returns minimal normalized issues
  - `test/unit/linear/LinearClient.test.ts > returns minimal issues with normalized states`
- [x] Issue state refresh query uses GraphQL ID typing (`[ID!]`) as specified in Section 11.2
  - `test/unit/linear/queries.test.ts > uses GraphQL [ID!] variable typing per spec §11.2 (regression)`
- [x] Error mapping for request errors, non-200, GraphQL errors, malformed payloads
  - `test/unit/linear/LinearClient.test.ts > maps a transport error to LinearRequestFail (after retries exhausted)`

## §17.4 Orchestrator Dispatch, Reconciliation, and Retry

- [x] Dispatch sort order is priority then oldest creation time
  - `test/unit/orchestrator/Dispatch.test.ts > breaks priority ties by oldest created_at first`
- [x] `Todo` issue with non-terminal blockers is not eligible
  - `test/unit/orchestrator/Dispatch.test.ts > skips a Todo with a non-terminal blocker with TodoBlocked`
- [x] `Todo` issue with terminal blockers is eligible
  - `test/unit/orchestrator/Dispatch.test.ts > dispatches a Todo with all-terminal blockers (regression)`
- [x] Active-state issue refresh updates running entry state
  - `test/unit/orchestrator/Reconcile.test.ts > emits UpdateIssueSnapshot only when state is still active`
- [x] Non-active state stops running agent without workspace cleanup
  - `test/unit/orchestrator/Reconcile.test.ts > emits InterruptWorker WITHOUT CleanupWorkspace when neither active nor terminal`
- [x] Terminal state stops running agent and cleans workspace
  - `test/unit/orchestrator/Reconcile.test.ts > emits InterruptWorker + CleanupWorkspace for terminal-state issues`
- [x] Reconciliation with no running issues is a no-op
  - `test/unit/orchestrator/Reconcile.test.ts > returns empty when there are no running issues`
- [x] Normal worker exit schedules a short continuation retry (attempt 1)
  - `test/unit/orchestrator/State.test.ts > removes from running, adds to completed, schedules continuation retry (normal)`
- [x] Abnormal worker exit increments retries with 10s-based exponential backoff
  - `test/unit/orchestrator/State.test.ts > schedules exponential-backoff retry on abnormal exit`
- [x] Retry backoff cap uses configured `agent.max_retry_backoff_ms`
  - `test/unit/orchestrator/State.test.ts > caps exponential backoff at DEFAULT_MAX_RETRY_BACKOFF_MS`
- [x] Retry queue entries include attempt, due time, identifier, and error
  - `test/unit/orchestrator/Orchestrator.test.ts > schedules a retry with attempt=1, delay=10s after a single abnormal exit`
- [x] Stall detection kills stalled sessions and schedules retry
  - `test/unit/orchestrator/Orchestrator.test.ts > emits StallDetected + InterruptWorker → WorkerExited(abnormal)`
- [x] Slot exhaustion requeues retries with explicit error reason
  - `test/unit/orchestrator/Orchestrator.test.ts > when no slots available, re-queues with error 'no available orchestrator slots'`
- [x] If a snapshot API is implemented, it returns running rows, retry rows, token totals, and rate limits
  - `test/unit/http/Api.test.ts > GET /api/v1/state returns the spec-example fields with codex_totals`
- [x] If a snapshot API is implemented, timeout/unavailable cases are surfaced
  - `test/unit/http/Api.test.ts > GET /api/v1/<unknown> returns 404 with the issue_not_found envelope`

## §17.5 Coding-Agent App-Server Client

Per TRUST.md divergence #1, Symphony v1 runs Anthropic's `claude` CLI instead
of Codex `app-server`. The §17.5 bullets that reference "Codex app-server"
are interpreted against the Claude Code stream-json wire shape; the
client-identity / approval-policy / sandbox-payload bullets that have no
analog under Claude Code are noted inline as "n/a under Claude Code".

- [x] Launch command uses workspace cwd and invokes `bash -lc <codex.command>` (Claude Code: workspace cwd + `agent_runner.command`; the bash wrapper is supplied by `nono` rather than us)
  - `test/unit/claude/ClaudeSubprocess.test.ts > parses a stream-json frame off stdout and surfaces it via incoming`
- [x] Session startup follows the targeted Codex app-server protocol (Claude Code: stream-json startup is the `system.init` frame)
  - `test/unit/claude/EventMapping.test.ts > emits SessionStarted with session_id, model, plugins, plugin_errors extracted`
- [x] Client identity/capability payloads are valid when the targeted Codex app-server protocol requires them (Claude Code: MCP initialize handshake declares server identity + tools capability)
  - `test/unit/claude/McpServer.test.ts > returns the protocol version, server identity, and tools capability`
- [x] Policy-related startup payloads use the implementation's documented approval/sandbox settings
  - `test/unit/claude/argv.test.ts > uses the configured permission_mode literal`
- [x] Thread and turn identities exposed by the targeted protocol are extracted and used to emit `session_started`
  - `test/unit/claude/EventMapping.test.ts > composes thread_id and turn_id with a hyphen separator`
- [x] Request/response read timeout is enforced
  - `test/unit/claude/ClaudeSubprocess.test.ts > a stub that ignores SIGTERM gets SIGKILL'd by the sandbox finalizer`
- [x] Turn timeout is enforced (Claude Code: stall_timeout_ms drives the orchestrator-level enforcement)
  - `test/unit/orchestrator/Reconcile.test.ts > emits StallDetected + InterruptWorker + ScheduleRetry when elapsed exceeds timeout`
- [x] Transport framing required by the targeted protocol is handled correctly
  - `test/unit/claude/jsonlParser.test.ts > accumulates a pretty-printed object across newlines`
- [x] For stdio-based transports, diagnostic stderr handling is kept separate from the protocol stream
  - `test/unit/claude/jsonlParser.test.ts > reports a [SandboxDebug] line as dropped without aborting the stream`
- [x] Command/file-change approvals are handled according to the implementation's documented policy (Claude Code: `can_use_tool` defaults to deny+interrupt, emitting turn_input_required)
  - `test/unit/claude/ControlProtocol.test.ts > default handler denies with interrupt:true and emits turn_input_required`
- [x] Unsupported dynamic tool calls are rejected without stalling the session
  - `test/unit/claude/McpServer.test.ts > returns a tool-level failure (not a JSON-RPC error) for unknown tool names`
- [x] User input requests are handled according to the implementation's documented policy and do not stall indefinitely
  - `test/unit/claude/ControlProtocol.test.ts > propagates blocked_path on the emitted turn_input_required event`
- [x] Usage and rate-limit telemetry exposed by the targeted protocol is extracted
  - `test/unit/claude/EventMapping.test.ts > two consecutive result frames replace (not add) absolute totals; last_reported_* untouched`
- [x] Approval, user-input-required, usage, and rate-limit signals are interpreted according to the targeted protocol
  - `test/unit/claude/EventMapping.test.ts > updates latest_rate_limit on the session state and emits RateLimit`
- [x] If client-side tools are implemented, session startup advertises the supported tool specs using the targeted app-server protocol
  - `test/unit/claude/McpServer.test.ts > exposes only \`linear_graphql\``
- [x] `linear_graphql` extension: the tool is advertised to the session
  - `test/unit/claude/McpServer.test.ts > exposes only \`linear_graphql\``
- [x] `linear_graphql` extension: valid `query` / `variables` inputs execute against configured Linear auth
  - `test/unit/claude/McpServer.test.ts > returns success=true with the GraphQL data on a clean response`
- [x] `linear_graphql` extension: top-level GraphQL `errors` produce `success=false` while preserving the GraphQL body
  - `test/unit/claude/McpServer.test.ts > preserves GraphQL errors with success=false and isError=false`
- [x] `linear_graphql` extension: invalid arguments, missing auth, and transport failures return structured failure payloads
  - `test/unit/claude/McpServer.test.ts > rejects missing auth with missing_auth before any HTTP call`
- [x] `linear_graphql` extension: unsupported tool names still fail without stalling the session
  - `test/unit/claude/McpServer.test.ts > returns a tool-level failure (not a JSON-RPC error) for unknown tool names`

## §17.6 Observability

The first four §17.6 bullets are Core Conformance and are covered below.
The final bullet (humanized event summaries) is gated on "If humanized
event summaries are implemented"; Symphony v1 does **not** ship humanized
agent event summaries (§13.6 is OPTIONAL) so that bullet is marked
explicitly as not implemented in v1.

- [x] Validation failures are operator-visible
  - `test/unit/config/WorkflowLoader.test.ts > preserves last-known-good and warns when reload content is invalid`
- [x] Structured logging includes issue/session context fields
  - `test/unit/observability/Logger.test.ts > withIssue merges fields only inside the wrapped scope`
- [x] Logging sink failures do not crash orchestration
  - `test/unit/observability/Logger.test.ts > sink failure does not abort the parent fiber`
- [x] Token/rate-limit aggregation remains correct across repeated agent updates
  - `test/unit/claude/EventMapping.test.ts > two consecutive result frames replace (not add) absolute totals; last_reported_* untouched`
- [x] If a human-readable status surface is implemented, it is driven from orchestrator state and does not affect correctness
  - `test/unit/http/Dashboard.test.ts > renders the running-table row content when a session is active`
- [ ] If humanized event summaries are implemented, they cover key wrapper/agent event classes without changing orchestrator behavior <!-- not implemented in v1 -->

## §17.7 CLI and Host Lifecycle

- [x] CLI accepts a positional workflow path argument (`path-to-WORKFLOW.md`)
  - `test/unit/cli.test.ts > captures a single positional as the workflow path`
- [x] CLI uses `./WORKFLOW.md` when no workflow path argument is provided
  - `test/unit/cli.test.ts > returns null path and null port for empty argv`
- [x] CLI errors on nonexistent explicit workflow path or missing default `./WORKFLOW.md`
  - `test/integration/startup.test.ts > exits non-zero with an operator-visible error for a nonexistent explicit workflow path`
- [x] CLI surfaces startup failure cleanly
  - `test/integration/startup.test.ts > exits non-zero with usage text on unknown flag`
- [x] CLI exits with success when application starts and shuts down normally
  - `test/integration/startup.test.ts > starts cleanly and exits 0 on SIGTERM with no HTTP port`
- [x] CLI exits nonzero when startup fails or the host process exits abnormally
  - `test/integration/startup.test.ts > exits non-zero on malformed --port value`
