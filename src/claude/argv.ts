// Pure argv builder for the `claude` CLI in stream-json mode.
// Computes both the inner claude argv and the matching Sandbox agent_runner policy.
import type { TypedConfig } from "../config/WorkflowSchema.ts";
import type { AbsolutePath } from "../config/PathSafety.ts";
import type { SandboxPolicy } from "../sandbox/policies.ts";

/**
 * Inputs to the argv builder. The caller owns the workspace path, the
 * workflow_dir (for the sandbox `--read` grant), and the MCP config (which
 * may either be a JSON string or a path — the CLI accepts either form per
 * `research/claude-stream-json.md` §1).
 *
 * Optional resume / session-id / partial-message knobs surface only when set
 * so the argv stays short for the common first-turn case.
 */
export interface ClaudeSpawnOptions {
  readonly workspace: AbsolutePath;
  readonly workflow_dir: AbsolutePath;
  readonly config: TypedConfig;
  /** JSON literal or absolute path. Caller's choice; CLI accepts both. */
  readonly mcp_config: string;
  /** When set, resumes a prior session id. */
  readonly resume_session_id?: string;
  /** When set with `resume_session_id`, mints a new id from prior history. */
  readonly fork_session?: boolean;
  /** When set, pins the new session id (for first-turn idempotence). */
  readonly session_id?: string;
  /** Whether to include `--include-partial-messages`. */
  readonly include_partial_messages?: boolean;
}

/**
 * Build the inner `claude` argv (the thing run inside the sandbox; the leading
 * program name is supplied separately by the caller via
 * {@link ClaudeSpawnOptions.config}.agent_runner.command). Order matches
 * `research/claude-stream-json.md` §1 verbatim so tests can snapshot the array.
 *
 * Bare-mode handling: when `config.agent_runner.bare === true`, `--bare` is
 * the FIRST flag emitted (matches the documented invocation in §1). Auth in
 * bare mode comes from `ANTHROPIC_API_KEY`; non-bare mode reads `~/.claude`
 * for OAuth tokens. The corresponding sandbox-policy shape is built by
 * {@link buildAgentRunnerPolicy}.
 */
export const buildClaudeArgv = (
  opts: ClaudeSpawnOptions,
): ReadonlyArray<string> => {
  const ar = opts.config.agent_runner;
  const argv: Array<string> = [];

  if (ar.bare) {
    argv.push("--bare");
  }

  argv.push(
    "--output-format",
    "stream-json",
    "--verbose",
    "--input-format",
    "stream-json",
    "--permission-mode",
    ar.permission_mode,
    "--permission-prompt-tool",
    "stdio",
    "--add-dir",
    opts.workspace,
    "--mcp-config",
    opts.mcp_config,
  );

  if (opts.resume_session_id !== undefined) {
    argv.push("--resume", opts.resume_session_id);
    if (opts.fork_session === true) {
      argv.push("--fork-session");
    }
  }

  if (opts.session_id !== undefined) {
    argv.push("--session-id", opts.session_id);
  }

  argv.push("--max-turns", String(ar.max_turns));

  if (opts.include_partial_messages === true) {
    argv.push("--include-partial-messages");
  }

  for (const extra of ar.extra_args) {
    argv.push(extra);
  }

  return argv;
};

/**
 * Build the `agent_runner` Sandbox policy that matches the spawn options.
 *
 * Bare-mode mapping (per `research/claude-stream-json.md` §1 / nono-sandbox-service.md):
 *
 * - `bare === true`: `claude_home_access: "read"` + `credentials: ["anthropic"]`.
 *   The CLI cannot mutate `~/.claude`; auth is injected from the keystore via
 *   nono's `--credential anthropic`.
 * - `bare === false`: `claude_home_access: "allow"` + `credentials: []`.
 *   The CLI can refresh OAuth tokens on 401 by writing to `~/.claude`.
 */
export const buildAgentRunnerPolicy = (
  opts: ClaudeSpawnOptions,
): SandboxPolicy => {
  const bare = opts.config.agent_runner.bare;
  return {
    kind: "agent_runner",
    workspace: opts.workspace,
    workflow_dir: opts.workflow_dir,
    network_profile: opts.config.agent_runner.network_profile,
    credentials: bare ? ["anthropic"] : [],
    claude_home_access: bare ? "read" : "allow",
  };
};
