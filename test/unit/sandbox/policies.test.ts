// Pure-function tests for the `nono` argv builders.
// Asserts exact argv shape per spec; no nono process spawn happens here.
import { describe, expect, it } from "bun:test";
import {
  AGENT_RUNNER_BASE_READS,
  agentRunnerArgv,
  claudeHomePath,
  hookArgv,
  policyArgv,
} from "../../../src/sandbox/policies.ts";
import type { AbsolutePath } from "../../../src/config/PathSafety.ts";

const WORKSPACE = "/tmp/symphony-ws/MT-1" as AbsolutePath;
const WORKFLOW_DIR = "/tmp/symphony-repo" as AbsolutePath;

describe("agentRunnerArgv", () => {
  it("builds bare-mode argv: --read ~/.claude + --credential anthropic", () => {
    const argv = agentRunnerArgv(
      {
        kind: "agent_runner",
        workspace: WORKSPACE,
        workflow_dir: WORKFLOW_DIR,
        network_profile: "claude-code",
        credentials: ["anthropic"],
        claude_home_access: "read",
      },
      ["claude", "--print", "hello"],
    );

    expect(argv).toEqual([
      "run",
      "--network-profile",
      "claude-code",
      "--credential",
      "anthropic",
      "--allow",
      WORKSPACE,
      "--read",
      WORKFLOW_DIR,
      "--read",
      claudeHomePath(),
      "--read",
      "/usr/bin",
      "--read",
      "/bin",
      "--read",
      "/usr/local/bin",
      "--read",
      "/opt/homebrew",
      "--",
      "claude",
      "--print",
      "hello",
    ]);
  });

  it("builds OAuth-mode argv: --allow ~/.claude + no --credential flags", () => {
    const argv = agentRunnerArgv(
      {
        kind: "agent_runner",
        workspace: WORKSPACE,
        workflow_dir: WORKFLOW_DIR,
        network_profile: "claude-code",
        credentials: [],
        claude_home_access: "allow",
      },
      ["claude"],
    );

    expect(argv).toEqual([
      "run",
      "--network-profile",
      "claude-code",
      "--allow",
      WORKSPACE,
      "--read",
      WORKFLOW_DIR,
      "--allow",
      claudeHomePath(),
      "--read",
      "/usr/bin",
      "--read",
      "/bin",
      "--read",
      "/usr/local/bin",
      "--read",
      "/opt/homebrew",
      "--",
      "claude",
    ]);
  });

  it("emits one --credential flag pair per entry, in order", () => {
    const argv = agentRunnerArgv(
      {
        kind: "agent_runner",
        workspace: WORKSPACE,
        workflow_dir: WORKFLOW_DIR,
        network_profile: "claude-code",
        credentials: ["anthropic", "openai", "gemini"],
        claude_home_access: "read",
      },
      ["echo", "x"],
    );

    // Slice out only the credential pairs (positions 3..8 inclusive).
    const creds = argv.slice(3, 9);
    expect(creds).toEqual([
      "--credential",
      "anthropic",
      "--credential",
      "openai",
      "--credential",
      "gemini",
    ]);
  });

  it("base read set matches the documented AGENT_RUNNER_BASE_READS list", () => {
    expect(AGENT_RUNNER_BASE_READS).toEqual([
      "/usr/bin",
      "/bin",
      "/usr/local/bin",
      "/opt/homebrew",
    ]);
  });
});

describe("hookArgv", () => {
  it("builds argv: --profile … --allow workspace --read workflow_dir -- cmd", () => {
    const argv = hookArgv(
      {
        kind: "hook",
        workspace: WORKSPACE,
        workflow_dir: WORKFLOW_DIR,
        profile: "developer",
      },
      ["bash", "-lc", "echo hi"],
    );

    expect(argv).toEqual([
      "run",
      "--profile",
      "developer",
      "--allow",
      WORKSPACE,
      "--read",
      WORKFLOW_DIR,
      "--",
      "bash",
      "-lc",
      "echo hi",
    ]);
  });
});

describe("policyArgv (dispatch)", () => {
  it("delegates to agentRunnerArgv for kind=agent_runner", () => {
    const policy = {
      kind: "agent_runner" as const,
      workspace: WORKSPACE,
      workflow_dir: WORKFLOW_DIR,
      network_profile: "claude-code",
      credentials: [] as ReadonlyArray<string>,
      claude_home_access: "allow" as const,
    };
    expect(policyArgv(policy, ["echo", "ok"])).toEqual(
      agentRunnerArgv(policy, ["echo", "ok"]) as Array<string>,
    );
  });

  it("delegates to hookArgv for kind=hook", () => {
    const policy = {
      kind: "hook" as const,
      workspace: WORKSPACE,
      workflow_dir: WORKFLOW_DIR,
      profile: "developer",
    };
    expect(policyArgv(policy, ["echo", "ok"])).toEqual(
      hookArgv(policy, ["echo", "ok"]) as Array<string>,
    );
  });
});
