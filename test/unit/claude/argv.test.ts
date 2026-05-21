// Pure-function tests for the claude argv + sandbox-policy builders.
// Asserts exact argv shape and the bare→policy axis mapping; no process is spawned.
import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { TopLevelSchema, type TypedConfig } from "../../../src/config/WorkflowSchema.ts";
import type { AbsolutePath } from "../../../src/config/PathSafety.ts";
import {
  buildAgentRunnerPolicy,
  buildClaudeArgv,
  type ClaudeSpawnOptions,
} from "../../../src/claude/argv.ts";

const WORKSPACE = "/tmp/symphony-ws/MT-1" as AbsolutePath;
const WORKFLOW_DIR = "/tmp/symphony-repo" as AbsolutePath;

/** Build a fully-defaulted TypedConfig and let the caller patch agent_runner. */
const makeConfig = (
  patch: Partial<TypedConfig["agent_runner"]> = {},
): TypedConfig => {
  const decoded = Schema.decodeUnknownSync(TopLevelSchema)({});
  return {
    tracker: {
      kind: decoded.tracker.kind,
      endpoint: decoded.tracker.endpoint,
      api_key: decoded.tracker.api_key ?? null,
      project_slug: decoded.tracker.project_slug ?? null,
      active_states: decoded.tracker.active_states,
      terminal_states: decoded.tracker.terminal_states,
    },
    polling: { interval_ms: decoded.polling.interval_ms },
    workspace: { root: decoded.workspace.root ?? "/tmp" },
    hooks: {
      after_create: decoded.hooks.after_create,
      before_run: decoded.hooks.before_run,
      after_run: decoded.hooks.after_run,
      before_remove: decoded.hooks.before_remove,
      timeout_ms: decoded.hooks.timeout_ms,
    },
    agent_runner: {
      kind: decoded.agent_runner.kind,
      command: decoded.agent_runner.command,
      permission_mode: decoded.agent_runner.permission_mode,
      max_turns: decoded.agent_runner.max_turns,
      turn_timeout_ms: decoded.agent_runner.turn_timeout_ms,
      read_timeout_ms: decoded.agent_runner.read_timeout_ms,
      stall_timeout_ms: decoded.agent_runner.stall_timeout_ms,
      network_profile: decoded.agent_runner.network_profile,
      bare: decoded.agent_runner.bare,
      extra_args: decoded.agent_runner.extra_args,
      max_concurrent_agents: decoded.agent_runner.max_concurrent_agents,
      max_concurrent_agents_by_state:
        decoded.agent_runner.max_concurrent_agents_by_state,
      max_retry_backoff_ms: decoded.agent_runner.max_retry_backoff_ms,
      continuation_prompt: decoded.agent_runner.continuation_prompt,
      ...patch,
    },
    server: null,
  };
};

const baseOpts = (
  overrides: Partial<ClaudeSpawnOptions> = {},
): ClaudeSpawnOptions => ({
  workspace: WORKSPACE,
  workflow_dir: WORKFLOW_DIR,
  config: overrides.config ?? makeConfig(),
  mcp_config: "/tmp/symphony-mcp.json",
  ...overrides,
});

describe("buildClaudeArgv — bare flag", () => {
  it("includes --bare as the FIRST flag when bare===true", () => {
    const argv = buildClaudeArgv(
      baseOpts({ config: makeConfig({ bare: true }) }),
    );
    expect(argv).toEqual([
      "--bare",
      "--output-format",
      "stream-json",
      "--verbose",
      "--input-format",
      "stream-json",
      "--permission-mode",
      "bypassPermissions",
      "--permission-prompt-tool",
      "stdio",
      "--add-dir",
      WORKSPACE,
      "--mcp-config",
      "/tmp/symphony-mcp.json",
      "--max-turns",
      "20",
    ]);
  });

  it("omits --bare when bare===false", () => {
    const argv = buildClaudeArgv(
      baseOpts({ config: makeConfig({ bare: false }) }),
    );
    expect(argv[0]).not.toBe("--bare");
    expect(argv).toEqual([
      "--output-format",
      "stream-json",
      "--verbose",
      "--input-format",
      "stream-json",
      "--permission-mode",
      "bypassPermissions",
      "--permission-prompt-tool",
      "stdio",
      "--add-dir",
      WORKSPACE,
      "--mcp-config",
      "/tmp/symphony-mcp.json",
      "--max-turns",
      "20",
    ]);
  });
});

describe("buildClaudeArgv — optional flags", () => {
  it("includes --resume + --fork-session when both supplied", () => {
    const argv = buildClaudeArgv(
      baseOpts({
        resume_session_id: "sess-123",
        fork_session: true,
      }),
    );
    const i = argv.indexOf("--resume");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe("sess-123");
    expect(argv[i + 2]).toBe("--fork-session");
  });

  it("omits --fork-session when fork_session is not true even with --resume", () => {
    const argv = buildClaudeArgv(
      baseOpts({ resume_session_id: "sess-9" }),
    );
    expect(argv).toContain("--resume");
    expect(argv).toContain("sess-9");
    expect(argv).not.toContain("--fork-session");
  });

  it("includes --session-id when supplied", () => {
    const argv = buildClaudeArgv(
      baseOpts({ session_id: "11111111-2222-3333-4444-555555555555" }),
    );
    expect(argv).toContain("--session-id");
    expect(argv).toContain("11111111-2222-3333-4444-555555555555");
  });

  it("includes --include-partial-messages when set", () => {
    const argv = buildClaudeArgv(baseOpts({ include_partial_messages: true }));
    expect(argv).toContain("--include-partial-messages");
  });

  it("appends extra_args verbatim at the end", () => {
    const argv = buildClaudeArgv(
      baseOpts({
        config: makeConfig({ extra_args: ["--betas", "context-1m-2025-08-07"] }),
      }),
    );
    const tail = argv.slice(-2);
    expect(tail).toEqual(["--betas", "context-1m-2025-08-07"]);
  });

  it("renders --max-turns from config", () => {
    const argv = buildClaudeArgv(
      baseOpts({ config: makeConfig({ max_turns: 7 }) }),
    );
    const i = argv.indexOf("--max-turns");
    expect(argv[i + 1]).toBe("7");
  });

  it("uses the configured permission_mode literal", () => {
    const argv = buildClaudeArgv(
      baseOpts({ config: makeConfig({ permission_mode: "acceptEdits" }) }),
    );
    const i = argv.indexOf("--permission-mode");
    expect(argv[i + 1]).toBe("acceptEdits");
  });
});

describe("buildAgentRunnerPolicy — bare→policy axis", () => {
  it("bare===true → claude_home_access=read + credentials=[anthropic]", () => {
    const policy = buildAgentRunnerPolicy(
      baseOpts({ config: makeConfig({ bare: true }) }),
    );
    expect(policy.kind).toBe("agent_runner");
    if (policy.kind !== "agent_runner") throw new Error("unreachable");
    expect(policy.claude_home_access).toBe("read");
    expect(policy.credentials).toEqual(["anthropic"]);
    expect(policy.workspace).toBe(WORKSPACE);
    expect(policy.workflow_dir).toBe(WORKFLOW_DIR);
    expect(policy.network_profile).toBe("claude-code");
  });

  it("bare===false → claude_home_access=allow + credentials=[]", () => {
    const policy = buildAgentRunnerPolicy(
      baseOpts({ config: makeConfig({ bare: false }) }),
    );
    if (policy.kind !== "agent_runner") throw new Error("unreachable");
    expect(policy.claude_home_access).toBe("allow");
    expect(policy.credentials).toEqual([]);
  });

  it("threads network_profile from config", () => {
    const policy = buildAgentRunnerPolicy(
      baseOpts({
        config: makeConfig({ network_profile: "custom-profile" }),
      }),
    );
    if (policy.kind !== "agent_runner") throw new Error("unreachable");
    expect(policy.network_profile).toBe("custom-profile");
  });
});
