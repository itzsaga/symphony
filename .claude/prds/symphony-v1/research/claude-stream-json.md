# Claude Code stream-json — Research Findings for Symphony v1

## Primary sources

All read via `gh api repos/<org>/<repo>/contents/<path> --jq '.content' | base64 -d`:

- `anthropics/claude-code` @ `fdfbc06c7a6d9ace49c55b3761b1be05d276da6d` — `CHANGELOG.md`, `README.md`, `plugins/`.
- `anthropics/claude-agent-sdk-python` @ `bdb8e393b1180368ff771176815f2f30aefb8634` — the canonical reference implementation that drives the `claude` CLI via stream-json. Files cited heavily:
  - `src/claude_agent_sdk/types.py`
  - `src/claude_agent_sdk/_internal/message_parser.py`
  - `src/claude_agent_sdk/_internal/query.py`
  - `src/claude_agent_sdk/_internal/transport/subprocess_cli.py`
- `anthropics/claude-code-base-action` @ `e6690e9926d95f083e32bae0e551e6a4fc3ed80d` — GitHub Action that uses the TS Agent SDK. Files: `src/run-claude.ts`, `src/run-claude-sdk.ts`, `src/parse-sdk-options.ts`.
- `https://code.claude.com/docs/en/headless` (the "Run Claude Code programmatically" docs page) — fetched after initial research to fill gaps in CLI-flag and event coverage.

The TypeScript Agent SDK source itself is not in `anthropics/claude-agent-sdk-typescript` (only examples + `MIRROR_DISCLAIMER.md`); the Python SDK explicitly says it tracks the TS SDK behavior — see comments like *"matching TypeScript SDK"* at `subprocess_cli.py:59, 408`.

## Framing notes

1. **Both SDKs always invoke the CLI in `--output-format stream-json --verbose --input-format stream-json` mode**, even for one-shot `query()` calls (`subprocess_cli.py:225, 408`). The stream-json surface Symphony will consume is the same one Anthropic's own first-party SDKs consume.
2. **"Headless" vs. "streaming" is now a single mode.** `subprocess_cli.py:59-62` says *"Always use streaming mode internally (matching TypeScript SDK). This allows agents and other large configs to be sent via initialize request"*. The historical `-p`/`--print` one-shot mode still exists but the SDKs no longer use it.
3. **Bidirectional control protocol over the same pipe.** stdin/stdout carry two interleaved channels: (a) conversation messages (`type: "user" | "assistant" | "system" | "result" | "stream_event" | "rate_limit_event"`) and (b) a control-request RPC (`type: "control_request" | "control_response" | "control_cancel_request"`). Both flow in both directions (`_internal/query.py:247-323`).

---

## 1. Invocation / flags

Canonical command line built by `subprocess_cli.py:_build_command` (lines 221–410):

```
claude
  --output-format stream-json          # mandatory
  --verbose                            # mandatory companion to stream-json
  --system-prompt <str>                # OR --system-prompt-file <path>
                                       # OR --append-system-prompt <str>
  --tools <csv>                        # base tool set (empty string = none)
  --allowedTools <csv>                 # auto-allow list (note camelCase)
  --disallowedTools <csv>              # (note camelCase)
  --max-turns <int>
  --max-budget-usd <float>
  --task-budget <int>                  # task-budgets-2026-03-13 beta
  --model <id>
  --fallback-model <id>
  --betas <csv>                        # e.g. context-1m-2025-08-07
  --permission-prompt-tool <name>      # MCP tool name OR the literal "stdio"
  --permission-mode <mode>             # default|acceptEdits|plan|bypassPermissions|dontAsk|auto
  --continue                           # boolean
  --resume <session-id-or-name>
  --session-id <uuid>                  # see §4
  --settings <json-or-path>
  --add-dir <path>                     # repeatable
  --mcp-config <json-or-path>          # see §7
  --include-partial-messages           # boolean; emits "stream_event" frames
  --include-hook-events                # boolean; emits "system/hook_started|hook_response"
  --strict-mcp-config                  # boolean
  --fork-session                       # boolean; pair with --resume
  --session-mirror                     # boolean
  --setting-sources=user,project,local # =-form, comma-separated
  --plugin-dir <path>                  # repeatable
  --thinking adaptive|disabled         # OR --max-thinking-tokens <int>
  --thinking-display summarized|omitted
  --effort low|medium|high|xhigh|max
  --json-schema <json>                 # structured output
  --input-format stream-json           # mandatory; stdin is JSONL
```

Additional CLI flags from `CHANGELOG.md`:

- `--print` / `-p` (line 3563): one-shot non-interactive mode. The SDKs do not use this; Symphony should not either, because streaming mode is required for control-protocol features (`can_use_tool`, hooks, interrupts, `mcp_status`). The official headless docs page now positions `claude -p` as the entry point and notes *"the CLI was previously called 'headless mode'"*, but the SDK pattern (no `-p`, continuous-stdin streaming with `--input-format stream-json`) is the right choice for a long-running daemon needing bidirectional control protocol.
- `--bare` (per the headless docs page, recommended for scripted/SDK callers): *"reduce startup time by skipping auto-discovery of hooks, skills, plugins, MCP servers, auto memory, and CLAUDE.md. Without it, `claude -p` loads the same context an interactive session would, including anything configured in the working directory or `~/.claude`."* In bare mode Claude has access to Bash, file read, and file edit tools by default; anything else (MCP servers, custom agents, plugins, settings) must be passed via explicit flag. Bare mode also *"skips OAuth and keychain reads. Anthropic authentication must come from `ANTHROPIC_API_KEY` or an `apiKeyHelper` in the JSON passed to `--settings`."* The docs say *"`--bare` is the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release."* For Symphony this is exactly the reproducibility posture we want — every flag the daemon depends on is passed explicitly; nothing about the host's `~/.claude` configuration affects per-issue runs.
- `--dangerously-skip-permissions` (line 3436): equivalent to `--permission-mode bypassPermissions`.
- `--append-system-prompt` (line 3244): can now be used in streaming mode.
- `--mcp-config` accepts multiple values (line 3115).
- `--agent <name>` selects a pre-defined agent (line 379, 2047).
- `--name <str>` and `/rename <str>` set a session title (line 730).
- `--include-partial-messages` (line 3032).
- `--session-id` combined with `--resume`/`--continue` and `--fork-session` (line 2500).

**Recommended Symphony invocation** (matches first-party SDK pattern). The `--bare` flag is gated on the workflow's `agent_runner.bare` (default `false` → omitted; `true` → included):

```
claude \
  [--bare] \
  --output-format stream-json \
  --verbose \
  --input-format stream-json \
  --permission-mode bypassPermissions \
  --permission-prompt-tool stdio \
  --add-dir <workspace-cwd> \
  --mcp-config <symphony-mcp-config.json> \
  [--resume <prior-session-id> [--fork-session]] \
  [--session-id <uuid>] \
  [--include-partial-messages] \
  [--max-turns N]
```

Two auth/discovery modes:

- **`--bare` included** (`agent_runner.bare: true`): the CLI ignores `~/.claude/`, project `.mcp.json`, project `CLAUDE.md`, hooks, skills, plugins, auto memory. Auth MUST come from `ANTHROPIC_API_KEY` in the subprocess env (or `apiKeyHelper` via `--settings`). nono's `--credential anthropic` injects exactly this from the system keystore. Use this for unattended/remote deployments where reproducibility matters.
- **`--bare` omitted** (`agent_runner.bare: false`, v1 default): the CLI reads `~/.claude/` for OAuth tokens — operator runs `claude /login` once and Symphony reuses the session across daemon restarts. Auto-discovery of hooks/skills/plugins/MCP servers/auto memory/CLAUDE.md is also active in this mode; operator's responsibility to keep `~/.claude` clean. Token refresh on 401 writes back to `~/.claude/`, so the sandbox grants it `--allow ~/.claude` rather than `--read`. Use this for local development.

**Stdin and stdout are JSONL** with one JSON object per line. Empty lines skipped. Lines that aren't JSON-decodable are buffered (`subprocess_cli.py:632-686`) — the SDK accumulates partial JSON across lines until a complete object parses, so the CLI is allowed to emit multi-line pretty-printed JSON. Non-JSON lines starting with anything other than `{` outside of a parse-in-progress are skipped with a debug log (`subprocess_cli.py:656-663`, referencing issue #347 and a `[SandboxDebug]` example). **Implication for Symphony:** don't assume every stdout line is JSON; do assume every JSON value is a complete top-level object.

**Stderr is for diagnostics** (`subprocess_cli.py:488-494, 518-535`). Capture to a separate channel.

**Minimum CLI version:** `MINIMUM_CLAUDE_CODE_VERSION = "2.0.0"` (`subprocess_cli.py:31`). SDK verifies via `claude -v` before connecting (`subprocess_cli.py:709-750`).

**Environment variables set on the subprocess** (`subprocess_cli.py:430-466`):

- `CLAUDE_CODE_ENTRYPOINT` — Symphony should set its own (e.g. `"symphony"`).
- `CLAUDE_AGENT_SDK_VERSION` — set by SDK; we set Symphony's.
- `CLAUDE_AGENT_SDK_CLIENT_APP` — caller User-Agent (e.g. `"symphony/1.0.0"`).
- `CLAUDECODE` — **filtered out** of inherited env so a Symphony process running inside its own Claude Code session doesn't pollute the spawned subprocess (issue #573).
- `TRACEPARENT` / `TRACESTATE` — OpenTelemetry W3C context propagation.
- `CLAUDE_CONFIG_DIR` — used by `--session-mirror`/`SessionStore` (`types.py:1372-1382`).
- `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` — when caller opts in.

---

## 2. Wire format

Dispatcher in `_internal/message_parser.py:75-318` is a `match` on `data["type"]`:

| `type`              | `subtype` discriminator                                          | Parsed into                                                  |
|---------------------|------------------------------------------------------------------|--------------------------------------------------------------|
| `"user"`            | n/a                                                              | `UserMessage`                                                |
| `"assistant"`       | n/a                                                              | `AssistantMessage`                                           |
| `"system"`          | `"init"` (+ others below)                                        | `SystemMessage`                                              |
| `"system"`          | `"task_started"` \| `"task_progress"` \| `"task_notification"`   | `TaskStartedMessage` / `TaskProgressMessage` / `TaskNotificationMessage` |
| `"system"`          | `"hook_started"` \| `"hook_response"`                            | `HookEventMessage` (only when `--include-hook-events`)       |
| `"system"`          | `"mirror_error"`                                                 | `MirrorErrorMessage` (SDK-synthesized, never from CLI)       |
| `"system"`          | `"session_state_changed"`                                        | Generic `SystemMessage` — turn-boundary marker (`query.py:312`) |
| `"result"`          | n/a (sub-discrimination via `result.subtype`)                    | `ResultMessage`                                              |
| `"stream_event"`    | n/a                                                              | `StreamEvent` (only when `--include-partial-messages`)       |
| `"rate_limit_event"`| n/a                                                              | `RateLimitEvent`                                             |
| `"control_request"` | various                                                          | RPC frame (see §6)                                            |
| `"control_response"`| `"success"` \| `"error"`                                         | RPC frame                                                    |
| `"control_cancel_request"` | n/a                                                       | RPC frame                                                    |
| `"transcript_mirror"` | n/a                                                            | Stripped when `SessionStore` attached                        |
| unrecognized        | n/a                                                              | Skipped with debug log (forward-compatible, `message_parser.py:314-318`) |

### 2.a. `system` / `init`

Emitted **once** at the start of every run. The Python SDK parses it as generic `SystemMessage` with `subtype="init"` and full payload in `.data`. The `claude-code-base-action` wrapper at `run-claude-sdk.ts:99-108`:

```ts
if (message.type === "system" && message.subtype === "init") {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    message: "Claude Code initialized",
    model: "model" in message ? message.model : "unknown",
  }, ...);
}
```

And `run-claude-sdk.ts:191-197`:

```ts
const initMessage = messages.find(m => m.type === "system" && "subtype" in m && m.subtype === "init");
if (initMessage && "session_id" in initMessage && initMessage.session_id) {
  result.sessionId = initMessage.session_id as string;
}
```

Confirmed fields (per the headless docs page and CHANGELOG):

- `model` — model id used for the session.
- `session_id` — UUID, stable across `--continue`/`--resume`.
- `plugins` — array of successfully loaded plugins, each with `name` and `path`. Empty array in `--bare` mode.
- `plugin_errors` — array of load-time errors (each with `plugin`, `type`, `message`); covers unsatisfied dependency versions and `--plugin-dir` load failures (missing path, invalid archive). Affected plugins are demoted and absent from `plugins`. **The key is omitted entirely when there are no errors** — code consuming it must treat missing-key as success, not as failure.

Other plausible fields (cwd, tools, mcp_servers, apiKeySource, permissionMode) are **still UNKNOWN from source — runtime verification needed.** A one-time `claude --bare --output-format stream-json --verbose -p 'noop' | head -1` capture during integration will resolve.

### 2.b. `assistant`

Fully typed. From `message_parser.py:126-186` and `types.py:1023-1035`:

```jsonc
{
  "type": "assistant",
  "uuid": "<msg uuid>",                  // optional
  "session_id": "<session uuid>",        // optional
  "parent_tool_use_id": null,            // optional; non-null inside subagent
  "error": null,                         // optional; AssistantMessageError literal
  "message": {                           // mirrors Anthropic Messages API response
    "id": "msg_…",                       // optional
    "model": "claude-…",                 // REQUIRED
    "stop_reason": "end_turn",           // optional
    "usage": { … },                      // optional; Anthropic API usage block
    "content": [
      // Discriminated union:
      { "type": "text", "text": "…" },
      { "type": "thinking", "thinking": "…", "signature": "…" },
      { "type": "tool_use", "id": "toolu_…", "name": "Bash", "input": { … } },
      { "type": "tool_result", "tool_use_id": "toolu_…", "content": "…", "is_error": false },
      { "type": "server_tool_use", "id": "toolu_…", "name": "web_search", "input": { … } },
      { "type": "advisor_tool_result", "tool_use_id": "toolu_…", "content": { … } }
    ]
  }
}
```

`AssistantMessageError` ∈ `"authentication_failed" | "billing_error" | "rate_limit" | "invalid_request" | "server_error" | "unknown"` (`types.py:1003-1010`). Present when the model failed mid-turn but the CLI continued and reported in-band.

`ServerToolName` literals (server-executed; caller never returns a result, `types.py:952-961`): `"advisor", "web_search", "web_fetch", "code_execution", "bash_code_execution", "text_editor_code_execution", "tool_search_tool_regex", "tool_search_tool_bm25"`.

### 2.c. `user`

`message_parser.py:80-124` and `types.py:1013-1020`. Two cases:

```jsonc
// String content (typical for the prompt Symphony sends in):
{
  "type": "user",
  "uuid": "<optional>",
  "session_id": "<optional>",
  "parent_tool_use_id": null,
  "tool_use_result": { … },           // optional; tool-result echo
  "message": { "role": "user", "content": "the prompt text" }
}

// Multi-block content (Anthropic API style):
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      { "type": "text", "text": "instructions" },
      { "type": "tool_result", "tool_use_id": "toolu_…", "content": "…", "is_error": false }
    ]
  }
}
```

The multi-block form is documented in `run-claude-sdk.ts:68-83` as the way to make the CLI's slash-command detector see a multi-part user message. It's also what the CLI emits **back** when injecting synthetic user messages (e.g. to deliver tool results to the assistant).

### 2.d. `result` (per-turn terminator)

`message_parser.py:246-277` and `types.py:1143-1166`:

```jsonc
{
  "type": "result",
  "subtype": "success",                  // see subtype list below
  "duration_ms": 12345,                  // REQUIRED
  "duration_api_ms": 9876,               // REQUIRED
  "is_error": false,                     // REQUIRED
  "num_turns": 1,                        // REQUIRED
  "session_id": "<uuid>",                // REQUIRED
  "stop_reason": "end_turn",             // optional
  "total_cost_usd": 0.0123,              // optional
  "usage": { … },                        // optional, aggregated
  "result": "final assistant text",      // optional convenience field
  "structured_output": { … },            // optional; populated when --json-schema is set
  "modelUsage": { "claude-…": { … } },   // optional, per-model breakdown
  "permission_denials": [ … ],           // optional, opaque list[Any]
  "deferred_tool_use": { "id": "toolu_…", "name": "Bash", "input": { … } },  // optional; PreToolUse hook returned "defer"
  "errors": ["error text", …],           // optional, when is_error=true
  "api_error_status": 429,               // optional; HTTP status (since v2.1.110)
  "uuid": "<optional>"
}
```

**Confirmed `subtype` values:**

- `"success"` — the only success value (`run-claude-sdk.ts:205`: `const isSuccess = resultMessage.subtype === "success"`).
- `"error_max_turns"` — `_internal/query.py:340-344`.
- `"error_during_execution"` — same source.
- `"error_max_budget_usd"` — `types.py:1660-1663`.

Full subtype enumeration is **UNKNOWN — needs runtime verification.** When `is_error=true`, SDK pulls `errors` for canonical error text (`_internal/query.py:304-310`).

### 2.e. `stream_event` (partial messages, only with `--include-partial-messages`)

`message_parser.py:279-290` and `types.py:1169-1176`:

```jsonc
{
  "type": "stream_event",
  "uuid": "<event uuid>",                // REQUIRED
  "session_id": "<session uuid>",        // REQUIRED
  "parent_tool_use_id": null,            // optional
  "event": { … }                         // raw Anthropic API SSE event (opaque pass-through)
}
```

`event` is `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, plus `input_json_delta` for tool args. Symphony should treat each as "one Anthropic API SSE event, JSON-encoded, plus framing fields".

### 2.f. `rate_limit_event`

`message_parser.py:292-312` and `types.py:1186-1223`:

```jsonc
{
  "type": "rate_limit_event",
  "uuid": "<uuid>",
  "session_id": "<uuid>",
  "rate_limit_info": {
    "status": "allowed" | "allowed_warning" | "rejected",
    "resetsAt": 1730000000,              // Unix seconds (camelCase on wire!)
    "rateLimitType": "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "overage",
    "utilization": 0.95,
    "overageStatus": "…",
    "overageResetsAt": 1730000000,
    "overageDisabledReason": "…"
  }
}
```

Wire format is camelCase (`resetsAt`, `rateLimitType`); Python SDK normalizes to snake_case.

### 2.g. Other `system` subtypes

Confirmed from `message_parser.py`:
- `task_started`, `task_progress`, `task_notification` — Task tool / subagent lifecycle with `task_id`, `description`, `usage: {total_tokens, tool_uses, duration_ms}`, status of `completed|failed|stopped`.
- `hook_started`, `hook_response` (with `--include-hook-events`) — carry `hook_event`/`hook_name`/`hook_event_name`, and the response carries `output`, `exit_code`, `outcome`.
- `session_state_changed` — turn-boundary marker (`_internal/query.py:312-314`: *"the post-turn session_state_changed marker"*).

Documented on the headless docs page:

- `system/api_retry` — emitted when an API request fails with a retryable error, before the CLI retries. Useful for surfacing retry progress on the dashboard or for custom backoff logic.

  ```jsonc
  {
    "type": "system",
    "subtype": "api_retry",
    "attempt": 1,                          // integer, starting at 1
    "max_retries": 5,                      // integer
    "retry_delay_ms": 2000,                // integer; milliseconds until next attempt
    "error_status": 429,                   // HTTP status, OR null for connection errors with no HTTP response
    "error": "rate_limit",                 // one of: authentication_failed | oauth_org_not_allowed | billing_error | rate_limit | invalid_request | server_error | max_output_tokens | unknown
    "uuid": "<event uuid>",
    "session_id": "<session uuid>"
  }
  ```

- `system/plugin_install` — only emitted when `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` env var is set (marketplace-plugin install flow). Symphony does not set this env var; we will not see these events. Documented for completeness:

  ```jsonc
  {
    "type": "system",
    "subtype": "plugin_install",
    "status": "started" | "installed" | "failed" | "completed",
    "name": "<marketplace name>",          // optional; present on installed/failed
    "error": "<failure message>",          // optional; present on failed
    "uuid": "<event uuid>",
    "session_id": "<session uuid>"
  }
  ```

CHANGELOG references autocompact/compact-related subtypes (lines 414, 940) but their schemas are **UNKNOWN — needs runtime verification.**

---

## 3. Mapping to Symphony §10.4 events

Symphony §10.4 lists these emitted events. Mapping table:

| Symphony §10.4 event       | Source from Claude stream-json                                              | Notes / source                                                                                                       |
|---|---|---|
| `session_started`          | First `{"type":"system","subtype":"init"}`                                  | `run-claude-sdk.ts:191-197` extracts `session_id` from here.                                                         |
| `startup_failed`           | `CLINotFoundError` / `CLIConnectionError` (`subprocess_cli.py:81-112, 502-516`); OR first event is a `{"type":"result","is_error":true,"subtype":"error_during_execution"}` before any `init` | Either pre-stream (no process) or in-stream (init failed inside CLI).            |
| `turn_completed`           | `{"type":"result","subtype":"success","is_error":false}`                    | `message_parser.py:246-277`.                                                                                         |
| `turn_failed`              | `{"type":"result","is_error":true}` with any error subtype                  | Same.                                                                                                                |
| `turn_cancelled`           | No first-class signal; closest is SIGINT-caused stream termination or `control_cancel_request` | The CLI itself doesn't have an explicit "cancelled turn" subtype that's visible; treat SIGINT as the trigger. Or use `control_cancel_request` for in-band cancellation (`_internal/query.py`). |
| `turn_ended_with_error`    | `{"type":"result","is_error":true}` OR `assistant.error` set                | `types.py:1003-1010`.                                                                                                |
| `turn_input_required`      | Inbound `control_request{subtype:"can_use_tool"}` — NOT an in-stream message | See §6. Per v1's high-trust posture, treat as hard failure.                                                          |
| `approval_auto_approved`   | Implicit when `bypassPermissions` is in effect and a tool was called without a `can_use_tool` request | Symphony can emit synthetically on every `tool_use` content block.                                                  |
| `unsupported_tool_call`    | A `tool_use` block whose `name` is not in the CLI's allowed/known set; OR a server-side `advisor_tool_result` with error | Surface as Symphony event from observation of `tool_use` then `tool_result.is_error=true`.                          |
| `notification`             | `system.task_notification`, OR raw `stream_event` informational events       | `message_parser.py:215-226`.                                                                                         |
| `other_message`            | Catch-all for unrecognized `system` subtypes or pass-through `stream_event`s | `message_parser.py:314-318` — SDK skips unknown types with debug log.                                                |
| `malformed`                | Lines that fail JSON parse beyond the buffer-recovery window, or violate the parsed-type union | `subprocess_cli.py:632-686`.                                                                                          |

Other useful mappings beyond §10.4's strict enumeration:

| Useful concept | Source |
|---|---|
| `TextDelta` | `stream_event.event = content_block_delta(text_delta)` when `--include-partial-messages`; otherwise consolidated `assistant` text blocks. |
| `ThinkingDelta` | `stream_event` with `thinking_delta`/`signature_delta`; or `thinking` blocks in `assistant.message.content`. Opus 4.7+ defaults `thinking_display` to `"omitted"` — set `"summarized"` to see text. |
| `ToolCallStarted` | `assistant` content block `{"type":"tool_use", ...}`. |
| `ToolCallCompleted` (success/failure) | `user` content block `{"type":"tool_result","tool_use_id":"toolu_…","is_error":bool}` correlated by `tool_use_id`. |
| `ServerToolCall` (web_search etc.) | `assistant` content block `{"type":"server_tool_use", ...}` then `{"type":"advisor_tool_result", ...}`. Caller never returns a result. |
| `SubagentStarted` / `SubagentCompleted` | `system.task_started`, then `system.task_notification` with status. |
| `UsageReport` / `TokenUsage` | `assistant.message.usage` (per-message), `result.usage` (turn aggregate), `result.modelUsage` (per-model). |
| `RateLimit` notification | `rate_limit_event`. |
| `ApiRetrying` (recommended Symphony addition) | `system.api_retry` — pre-retry signal with `attempt`, `max_retries`, `retry_delay_ms`, `error`, `error_status`. Surface on the dashboard; do not treat as a turn failure (the CLI is handling the retry internally). |
| `PluginsLoaded` (recommended Symphony addition) | The `plugins` / `plugin_errors` fields on `system.init`. With `--bare` these will be empty; useful as a CI gate if Symphony ever ships with non-bare mode. |
| `ProcessExited` | Subprocess `returncode != 0` after stream ends. SDK replaces bare ProcessError with `result.errors` text when available. |

**Order guarantees:**

- Within a turn: `assistant` (with `tool_use` blocks) precedes the synthetic `user` message that delivers `tool_result` blocks. Correlation via `tool_use_id`.
- `result` terminates a turn.
- `stream_event` frames are interleaved among/before the final `assistant`.
- `system.session_state_changed` is emitted **after** `result` (`query.py:312-314`: *"Anything other than the post-turn session_state_changed marker means the conversation moved on"*).
- `transcript_mirror` frames are emitted continuously; filter them out if not using `SessionStore` (`query.py:287-294`).

---

## 4. Session / turn identifiers

Three identifiers per `types.py:1645-1650` and `subprocess_cli.py:294-296`:

- **`session_id` (UUID).** Set by CLI when a new session starts; overridable via `--session-id <uuid>` (must be a valid UUID). Echoed in `system.init`, every `assistant`/`user` message, `result`, `stream_event`, `rate_limit_event`, hook input, and `CLAUDE_CODE_SESSION_ID` env var passed to Bash subprocesses (CHANGELOG.md:144). **Stable for the lifetime of the conversation**, including across `--continue` and `--resume`. `--fork-session` mints a **new** session_id when resuming.

- **`uuid` (per-message UUID).** Every assistant/user/system message + stream_event + rate_limit_event + result has one. `SessionStore` idempotency key (`types.py:1392-1410`).

- **`tool_use_id`** (`"toolu_…"`). Anthropic-API-style ID minted by the model in `tool_use` blocks and echoed in matching `tool_result` blocks. Parallel tool calls in one assistant message have different ids (`types.py:204-210`).

- **`request_id`** (control protocol only, format `f"req_{counter}_{4-byte-hex}"`, `_internal/query.py:513-515`).

- **`parent_tool_use_id`** — set on subagent-emitted messages to the parent Task call's `tool_use_id` (`types.py:175, 288-304`).

- **`task_id`** — used by `system.task_*`. Separate from `tool_use_id` (`types.py:1067`).

**There is no first-class "turn_id" on the wire.** A turn is implicit: begins at first `user` after a `result` (or at startup), ends at the next `result`. `result.num_turns` is a running count. **Recommended scheme for Symphony's `session_id = <thread_id>-<turn_id>`:** `thread_id = claude session_id` (UUID), `turn_id = result.num_turns` (integer), composed `<uuid>-<n>`.

---

## 5. Token usage

Three reporting sites:

1. **Per-assistant-message usage** (`AssistantMessage.usage`, `types.py:1031`): raw Anthropic Messages API `usage` block. Shape: `{ input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, server_tool_use: { web_search_requests, … }, service_tier }`. Full field set is API-determined — Python SDK passes through as `dict[str, Any]`.

2. **Per-result aggregated usage** (`ResultMessage.usage`, `types.py:1155`): sum across the turn. Same shape.

3. **Per-model usage** (`ResultMessage.modelUsage`, wire is camelCase `modelUsage`, Python normalizes to `model_usage` at `message_parser.py:261`): keyed by model id, each value a usage dict. Useful when a turn used a fallback or auto-switched. CHANGELOG line 408 confirms.

4. **`total_cost_usd`** on `ResultMessage` (`types.py:1154`). Pre-computed by CLI; nullable.

5. **Task-tool usage** in `system.task_progress` / `system.task_notification` (`TaskUsage`, `types.py:1046-1052`): `{ total_tokens: int, tool_uses: int, duration_ms: int }` — only `total_tokens`, not split input/output.

6. **`stream_event`** carries no usage; usage arrives via underlying API `message_delta` events that `stream_event.event` passes through.

**For Symphony's accounting:** sum (a) at turn end from `result.usage` + `result.total_cost_usd` (absolute thread totals — what §13.5 prefers), and optionally (b) per-message from `assistant.message.usage` for live displays. Track deltas against `last_reported_*` to avoid double-counting per §13.5's *"For absolute totals, track deltas relative to last reported totals to avoid double-counting."*

---

## 6. User-input-required / approval prompts

**The CLI does not emit an "input required" message in-stream.** When it needs a permission decision, it sends an **inbound control_request** over stdout (`_internal/query.py:271-285, 384-436`):

```jsonc
// CLI → host:
{
  "type": "control_request",
  "request_id": "req_…",
  "request": {
    "subtype": "can_use_tool",
    "tool_name": "Bash",
    "input": { "command": "rm -rf /" },
    "tool_use_id": "toolu_…",
    "agent_id": "<optional>",
    "permission_suggestions": [ … ],
    "blocked_path": "/etc/passwd",        // optional, when path-bounded
    "decision_reason": "…",               // forwarded from PreToolUse hook
    "title": "Claude wants to run rm -rf /",
    "display_name": "Run shell command",
    "description": "…"
  }
}
```

Host responds on stdin:

```jsonc
// Allow:
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "req_…",
    "response": {
      "behavior": "allow",
      "updatedInput": { … },              // optional rewrite
      "updatedPermissions": [ … ]         // optional rule additions
    }
  }
}
// Deny:
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "req_…",
    "response": {
      "behavior": "deny",
      "message": "blocked by Symphony policy",
      "interrupt": false                  // true = abort entire turn
    }
  }
}
// Error:
{
  "type": "control_response",
  "response": {
    "subtype": "error",
    "request_id": "req_…",
    "error": "…"
  }
}
```

**When does the CLI fire `can_use_tool`?** Only when permission rules evaluate to `"ask"`. From `types.py:1750-1757`: *"Invoked when the CLI's permission rules evaluate to 'ask' for a tool call — it is the SDK replacement for the interactive permission prompt. It is *not* invoked for tool calls already permitted by `allowed_tools`, `permission_mode` (e.g. `"acceptEdits"` / `"bypassPermissions"`), or `permissions.allow` rules in settings."*

**Wiring options for v1's high-trust posture:**

1. **`--permission-mode bypassPermissions` only.** CLI never emits `can_use_tool`. Simplest. Matches PRD's stated posture but loses the §10.4 `approval_auto_approved` event (we'd have to emit it synthetically on every `tool_use`).

2. **`--permission-prompt-tool stdio` + reject with `{behavior:"deny", interrupt:true}`.** Symphony sees every permission request, can emit a richer event log, and forwards to `nono.sh` policy if needed. Cost: one stdio control-protocol implementation.

3. **Both: `bypassPermissions` + `stdio` permission-prompt** — bypass mode prevails so the prompt-tool is dead code unless mode changes.

**Important lifecycle detail:** Control-protocol messages need stdin open for the full conversation. The Python SDK does NOT close stdin until the first `result` arrives when SDK-MCP servers or hooks are present (`_internal/query.py:809-827`). **Symphony cannot `process.stdin.end()` immediately after writing its prompt — the CLI needs the channel for the entire turn.**

No in-stream "elicit" or "ask-the-user" message type exists in the parser. `mcp elicitation/create` requests exist (CHANGELOG.md:492) but flow through the MCP control channel, not the SDK message stream.

---

## 7. MCP and client-side tools

Three configuration paths (`types.py:600-637`, `subprocess_cli.py:307-332`):

### 7.a. External MCP servers via `--mcp-config`

JSON inline (string starting with `{`) or file path. Multiple `--mcp-config` flags merge (CHANGELOG.md:3115, `parse-sdk-options.ts:36-80`).

```jsonc
{
  "mcpServers": {
    "linear": { "type": "stdio", "command": "/path/to/linear-mcp", "args": [], "env": {} },
    "company-api": { "type": "http", "url": "https://api.example.com/mcp", "headers": {"Authorization": "Bearer …"} },
    "live-feed": { "type": "sse", "url": "https://…/sse" }
  }
}
```

Three external transports (`types.py:601-624`):
- `"stdio"` — spawn subprocess with `command` + `args` + `env`. `type` optional for back-compat.
- `"sse"` — HTTP SSE with optional `headers`.
- `"http"` — Streamable HTTP transport with optional `headers`.

`--strict-mcp-config` (`types.py:1621-1626`) restricts the CLI to only servers passed via `--mcp-config`, ignoring user settings, project `.mcp.json`, and plugin servers.

### 7.b. In-process / SDK MCP servers (control-protocol routed)

Type `"sdk"` (`types.py:626-631`):

```jsonc
{ "type": "sdk", "name": "in-process-tools", "instance": <McpServer instance> }
```

SDK transport strips `instance` before serializing (`subprocess_cli.py:310-317`) — only `{type, name}` reach the CLI. Tool calls route back to the host via control protocol with `subtype: "mcp_message"` (`_internal/query.py:454-470, 548-721`). Routes MCP JSON-RPC methods `initialize`, `tools/list`, `tools/call`, `notifications/initialized` (`_internal/query.py:585-705`). Resources and prompts are TODO in the Python SDK.

**This is the recommended path for Symphony's `linear_graphql` tool.** Host an in-process MCP server in the orchestrator and advertise it as `{type:"sdk", name:"symphony"}`. Claude requests come over the control channel; Symphony executes the GraphQL call using its already-configured Linear auth and returns the result. No need to spawn a separate stdio child for the tool.

### 7.c. Permission-prompt as MCP tool

`--permission-prompt-tool <tool_name>` (`types.py:1691-1696`). The literal `"stdio"` routes via control protocol.

### 7.d. Tool naming

- MCP tools are namespaced `mcp__<serverName>__<toolName>` on the wire (CHANGELOG.md:208).
- Server connection statuses (`types.py:705-737`): `"connected" | "failed" | "needs-auth" | "pending" | "disabled"`. Available via control-request `mcp_status` (`_internal/query.py:723-725`).
- `MCP_CONNECTION_NONBLOCKING=true` (CHANGELOG.md:978) skips connect-wait. Default per-server timeout 5s.

---

## 8. Subprocess lifetime across continuation turns

### 8.a. One subprocess per turn ("one-shot")

- Spawn `claude` with all flags.
- Pipe `{"type":"user","message":{…}}` on stdin.
- Close stdin.
- Drain stdout until `result`.
- CLI writes `session_state_changed` and exits 0.
- For next turn, spawn fresh subprocess with `--resume <session-id>` or `--continue`.

Simpler but loses bidirectionality (no `can_use_tool`, no live interrupts, no MCP-SDK in-process tools). CHANGELOG lines 764, 989, 997, 1035 confirm `--continue -p` / `-p --resume` patterns are officially supported.

### 8.b. One subprocess per session ("streaming", SDK pattern) — RECOMMENDED for Symphony

- Spawn once.
- Send `initialize` control_request first (SDK does this transparently, `_internal/query.py:172-222`).
- Send user messages over stdin throughout. CLI emits `result` after each, then waits.
- **Stdin stays open for duration.** Closing stdin signals graceful exit.
- Python SDK's graceful-close: 5s wait after stdin EOF before SIGTERM, another 5s before SIGKILL (`subprocess_cli.py:563-584`). Specifically because of issue #625 — *"the subprocess needs time to flush its session file after receiving EOF on stdin. Without this grace period, SIGTERM can interrupt the write and cause the last assistant message to be lost"*.
- SDK registers `atexit` SIGTERM for leaked subprocesses (`subprocess_cli.py:33-47`).

**Symphony recommendation:** mode 8.b with one CLI subprocess per Symphony "run" (= one worker lifetime). Continuation across runs uses `--resume <session-id>`. Matches what claude-code-base-action does.

### Notes on `--continue` vs `--resume`

- `--continue` picks the most recent session in the current cwd. Includes `/add-dir`-added dirs (CHANGELOG.md:437).
- `--resume <session-id-or-name>` is explicit. Accepts UUID, session name via `/rename` (CHANGELOG.md:2586, 665, 730), or even a PR URL since 2.1.124 (CHANGELOG.md:182).
- `--fork-session` + `--resume` mints new session_id from prior history (CHANGELOG.md:2500).
- Resuming carries `--agent`, `cwd`, `model`, settings sources, skill lists forward (CHANGELOG.md:2047, 461). `--system-prompt` was historically ignored on `--continue`/`--resume`; fixed in 2.1.46 (CHANGELOG.md:2590).
- `cleanupPeriodDays` (default 30) sweeps old sessions from `CLAUDE_CONFIG_DIR` (`types.py:1376-1381`).

### Process exit semantics (`subprocess_cli.py:694-707`, `_internal/query.py:336-348`)

- Exit 0 = clean.
- Exit != 0 = CLI errored. When CLI emits `result` with `is_error=true` it often then exits non-zero on purpose ("for shell-script consumers", `query.py:334-339`). SDK swaps the bare "exit code 1" with the `result.errors` text it already saw.
- SIGTERM/SIGINT can interrupt mid-turn. CLI restores terminal modes and prints a `--resume` hint on external SIGINT (CHANGELOG.md:144).

---

## 9. Failure modes

**Crash / non-zero exit:**
- `ProcessError(exit_code=N, stderr=…)` — bare crash. SDK swaps message with `result.errors` if a result was emitted (`_internal/query.py:336-348`).
- JSON parse buffer overflow — default 1 MiB per JSON object (`subprocess_cli.py:30-31, 668-676`). Configurable via `max_buffer_size`. Raises `CLIJSONDecodeError`.
- `CLINotFoundError` — binary not on PATH (`subprocess_cli.py:81-112`).
- `CLIConnectionError` — cwd doesn't exist or spawn fails (`subprocess_cli.py:502-516`).

**Protocol-level errors (in-band):**
- `result.is_error == true` with `result.subtype`:
  - `"error_max_turns"` — turn cap hit.
  - `"error_during_execution"` — generic mid-turn API/tool failure.
  - `"error_max_budget_usd"` — budget cap hit.
  - Others **UNKNOWN — needs runtime verification.**
- `result.api_error_status` — HTTP status of failing API call (since v2.1.110, `types.py:1162-1165`).
- `result.errors: list[str]` — human-readable strings (`types.py:1161`).

**Assistant-level errors (model failed mid-turn, run continued):**
- `assistant.error` ∈ `{"authentication_failed", "billing_error", "rate_limit", "invalid_request", "server_error", "unknown"}` (`types.py:1003-1010`).

**Rate-limit / quota:**
- `rate_limit_event.status == "rejected"`: hard limit (`types.py:1180-1183`). Backoff using `resets_at`.
- `"allowed_warning"`: approaching limit.
- Five types: `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `overage`.

**Tool-call failures:**
- `tool_result.is_error: true` — tool ran but reported failure (`message_parser.py:101-108`).
- `PostToolUseFailure` hooks fire separately (`types.py:326-335`) with `error: str`, optional `is_interrupt: bool`.

**Stream idle:**
- Built-in 5-minute idle timeout on underlying API stream; CLI retries non-streaming after that (CHANGELOG.md:686, 742).

**MCP failures:**
- Server `status: "failed"` / `"needs-auth"` — visible via `get_mcp_status` control request (`_internal/query.py:723-725`).
- HTTP/SSE MCP response bodies capped at 16 MB per frame (CHANGELOG.md:5).
- Failing `--mcp-config` file detected (CHANGELOG.md:1647).

**Auth:**
- OAuth tokens refresh on 401 mid-session (CHANGELOG.md:485). Long-running Symphony agents should expect occasional re-auth pauses.

**Permission denials:**
- `result.permission_denials: list[Any]` — opaque list (`types.py:1159`).

**Encoding edge cases:**
- CHANGELOG.md:905: fixed CJK/multibyte text corruption when chunk boundaries split UTF-8 sequences. Effect.ts `Stream.decodeText("utf-8")` handles this correctly.
- CHANGELOG.md:222: very large input (>10 MB) to `-p` via stdin used to crash; now fixed but worth chunking megabyte-scale prompts or using file-based prompts.

**Deferred tool use:**
- A `PreToolUse` hook returning `permissionDecision: "defer"` causes `result.deferred_tool_use: {id, name, input}` (`types.py:1129-1140, 1160`). Then re-run with `claude -p --resume <session-id>` to re-evaluate. Irrelevant for v1's auto-approve posture but a future human-in-loop vector.

**Mirror (session-store) errors:**
- `system.mirror_error` is SDK-synthesized when external `SessionStore.append` fails. Symphony won't see these unless it implements a `SessionStore`.

---

## Recommended Symphony agent-runner sketch

```
Spawn:
  claude
    [--bare]                               # iff agent_runner.bare === true; omit to allow OAuth via ~/.claude
    --output-format stream-json --verbose --input-format stream-json
    --permission-mode bypassPermissions    # v1's posture
    --permission-prompt-tool stdio         # defense-in-depth observability channel
    --add-dir <workspace>
    --mcp-config <symphony-mcp-config.json>
    [--resume <prior_session> [--fork-session]]
    [--session-id <fresh-uuid>]

Send on stdin (line-delimited JSON):
  {"type":"user","message":{"role":"user","content":[
    {"type":"text","text":"<prompt>"}
  ]},"parent_tool_use_id":null,"session_id":""}

Receive on stdout (line-delimited JSON, possibly multi-line per object):
  1. system.init                    → emit Symphony "RunStarted"
  2. assistant (one or more)        → emit "TextDelta"/"ToolCallStarted"
  3. user (synthetic, tool results) → emit "ToolCallCompleted"
  4. ...repeat 2-3...
  5. result                         → emit "TurnCompleted"/"UsageReport"
  6. system.session_state_changed   → turn boundary marker (informational)

On control_request {subtype:"can_use_tool"}:
  Emit Symphony "UserInputRequired" AND respond
  {"type":"control_response","response":{
    "subtype":"success","request_id":<req_id>,
    "response":{"behavior":"deny","message":"Symphony v1: no human in loop","interrupt":true}
  }}

On control_request {subtype:"mcp_message"}:
  Route to in-process MCP server (linear_graphql).

On result: optionally close stdin (graceful per-turn exit) OR keep open for next prompt.

On stdin close: wait up to 5s for graceful exit, then SIGTERM, then SIGKILL.
```

---

## Items deliberately left UNKNOWN (need runtime verification)

These need a one-time `claude --bare --output-format stream-json --verbose -p '...'` capture against the pinned CLI version:

- Full field set inside `system.init` beyond `{model, session_id, plugins, plugin_errors}` (cwd, tools, mcp_servers, permissionMode, apiKeySource, agent?).
- Complete enumeration of `result.subtype` values beyond the four confirmed (`success`, `error_max_turns`, `error_during_execution`, `error_max_budget_usd`).
- Schema of entries in `result.permission_denials` (`list[Any]` in SDK).
- Full set of `system` subtypes beyond the parser-specialized ones (`init`, `task_*`, `hook_*`, `mirror_error`, `session_state_changed`, `api_retry`, `plugin_install`). Autocompact/compact-related ones are referenced in CHANGELOG but their payloads aren't documented.
- Whether `result.duration_ms` includes `can_use_tool` round-trip time. PostToolUse `duration_ms` fix (CHANGELOG.md:381) excludes permission prompts; whether `result.duration_ms` does the same is unstated.
