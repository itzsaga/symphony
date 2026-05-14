// Unit tests for the WORKFLOW.md parser and dispatch preflight validator.
// Covers spec §5 / §6.4 cheat-sheet, the agent_runner.* rename, and §6.3.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect, Exit } from "effect";
import {
  parseWorkflow,
  validateForDispatch,
} from "../../../src/config/parseWorkflow.ts";
import {
  type WorkflowDefinition,
  WorkflowFrontMatterNotAMap,
  WorkflowParseError,
} from "../../../src/config/WorkflowSchema.ts";

/** Stable path used in every test that doesn't care about path resolution. */
const FIXTURE_PATH = "/Users/seth/dev/symphony/WORKFLOW.md";

/** Run an Effect, expect success, and return the value. */
const runOk = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect as Effect.Effect<A, never>);

/** Run an Effect, expect failure, and return the failure value. */
const runErr = async <E>(
  effect: Effect.Effect<unknown, E>,
): Promise<E> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    throw new Error("expected failure, got success");
  }
  // Cause may be a Fail; pull the typed error out.
  const failureOption = exit.cause;
  // Easiest path: re-extract via Effect.either.
  const either = await Effect.runPromise(
    Effect.either(effect).pipe(Effect.orDie),
  );
  if (either._tag === "Right") {
    throw new Error(`expected failure, got success: ${JSON.stringify(failureOption)}`);
  }
  return either.left;
};

describe("parseWorkflow", () => {
  // Snapshot env around each test that mutates LINEAR_API_KEY etc.
  const originalEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ["LINEAR_API_KEY", "SYMPHONY_TEST_TOKEN", "SYMPHONY_TEST_ROOT"];
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("round-trips a known-good WORKFLOW.md to the expected TypedConfig", async () => {
    process.env["LINEAR_API_KEY"] = "tok-abc";
    const content = `---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: my-project
  active_states: [Todo, Doing]
  terminal_states: [Done]
polling:
  interval_ms: 12000
workspace:
  root: ./ws
hooks:
  after_create: |
    git init
  timeout_ms: 90000
agent_runner:
  command: claude
  permission_mode: acceptEdits
  max_turns: 12
  bare: true
  extra_args: ["--add-dir", "/extra"]
server:
  port: 8080
---
# {{issue.identifier}}: {{issue.title}}
`;
    const wf = await runOk(parseWorkflow(content, FIXTURE_PATH));
    expect(wf.source_path).toBe(FIXTURE_PATH);
    expect(wf.prompt_template).toBe("# {{issue.identifier}}: {{issue.title}}");
    expect(wf.config.tracker).toEqual({
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      api_key: "tok-abc",
      project_slug: "my-project",
      active_states: ["Todo", "Doing"],
      terminal_states: ["Done"],
    });
    expect(wf.config.polling).toEqual({ interval_ms: 12000 });
    // Workspace root resolved against the workflow file's directory.
    expect(wf.config.workspace.root).toBe(
      resolve("/Users/seth/dev/symphony", "ws"),
    );
    expect(wf.config.hooks).toEqual({
      after_create: "git init\n",
      before_run: null,
      after_run: null,
      before_remove: null,
      timeout_ms: 90000,
    });
    expect(wf.config.agent_runner).toEqual({
      kind: "claude_code",
      command: "claude",
      permission_mode: "acceptEdits",
      max_turns: 12,
      turn_timeout_ms: 3_600_000,
      read_timeout_ms: 5_000,
      stall_timeout_ms: 300_000,
      network_profile: "claude-code",
      bare: true,
      extra_args: ["--add-dir", "/extra"],
    });
    expect(wf.config.server).toEqual({ port: 8080 });
  });

  it("applies all spec §6.4 defaults when front matter is absent", async () => {
    const wf = await runOk(parseWorkflow("hello body", FIXTURE_PATH));
    expect(wf.config.tracker.kind).toBe("linear");
    expect(wf.config.tracker.endpoint).toBe("https://api.linear.app/graphql");
    expect(wf.config.tracker.api_key).toBeNull();
    expect(wf.config.tracker.project_slug).toBeNull();
    expect(wf.config.tracker.active_states).toEqual(["Todo", "In Progress"]);
    expect(wf.config.tracker.terminal_states).toEqual([
      "Closed",
      "Cancelled",
      "Canceled",
      "Duplicate",
      "Done",
    ]);
    expect(wf.config.polling.interval_ms).toBe(30_000);
    // Default workspace root: <tmpdir>/symphony_workspaces
    expect(wf.config.workspace.root).toBe(
      resolve(tmpdir(), "symphony_workspaces"),
    );
    expect(wf.config.hooks.timeout_ms).toBe(60_000);
    expect(wf.config.agent_runner.kind).toBe("claude_code");
    expect(wf.config.agent_runner.command).toBe("claude");
    expect(wf.config.agent_runner.permission_mode).toBe("bypassPermissions");
    expect(wf.config.agent_runner.max_turns).toBe(20);
    expect(wf.config.agent_runner.turn_timeout_ms).toBe(3_600_000);
    expect(wf.config.agent_runner.read_timeout_ms).toBe(5_000);
    expect(wf.config.agent_runner.stall_timeout_ms).toBe(300_000);
    expect(wf.config.agent_runner.network_profile).toBe("claude-code");
    expect(wf.config.agent_runner.bare).toBe(false);
    expect(wf.config.agent_runner.extra_args).toEqual([]);
    expect(wf.config.server).toBeNull();
    expect(wf.prompt_template).toBe("hello body");
  });

  it("resolves $VAR indirection on tracker.api_key", async () => {
    process.env["SYMPHONY_TEST_TOKEN"] = "from-env-123";
    const content = `---
tracker:
  kind: linear
  api_key: $SYMPHONY_TEST_TOKEN
  project_slug: ok
---
body
`;
    const wf = await runOk(parseWorkflow(content, FIXTURE_PATH));
    expect(wf.config.tracker.api_key).toBe("from-env-123");
  });

  it("treats empty $VAR resolution as missing api_key (no parse failure)", async () => {
    delete process.env["SYMPHONY_TEST_TOKEN"];
    const content = `---
tracker:
  kind: linear
  api_key: $SYMPHONY_TEST_TOKEN
  project_slug: ok
---
body
`;
    const wf = await runOk(parseWorkflow(content, FIXTURE_PATH));
    expect(wf.config.tracker.api_key).toBeNull();
    // And dispatch preflight should reject this.
    const err = await runErr(validateForDispatch(wf));
    expect((err as { checks: ReadonlyArray<string> }).checks).toContain(
      "tracker.api_key is required (after $VAR resolution)",
    );
  });

  it("resolves $VAR indirection on workspace.root and then expands the path", async () => {
    process.env["SYMPHONY_TEST_ROOT"] = "/custom/abs/path";
    const content = `---
workspace:
  root: $SYMPHONY_TEST_ROOT
---
body
`;
    const wf = await runOk(parseWorkflow(content, FIXTURE_PATH));
    expect(wf.config.workspace.root).toBe("/custom/abs/path");
  });

  it("expands ~ in workspace.root to the user's home directory", async () => {
    const content = `---
workspace:
  root: ~/my-workspaces
---
body
`;
    const wf = await runOk(parseWorkflow(content, FIXTURE_PATH));
    expect(wf.config.workspace.root).toBe(`${homedir()}/my-workspaces`);
  });

  it("resolves a relative workspace.root against the workflow file's directory", async () => {
    const content = `---
workspace:
  root: ../sibling
---
body
`;
    const wf = await runOk(
      parseWorkflow(content, "/var/projects/symphony/WORKFLOW.md"),
    );
    expect(wf.config.workspace.root).toBe("/var/projects/sibling");
  });

  it("rejects WORKFLOW.md that uses the legacy codex.* namespace", async () => {
    const content = `---
tracker:
  kind: linear
codex:
  command: codex app-server
  approval_policy: full
---
body
`;
    const err = await runErr(parseWorkflow(content, FIXTURE_PATH));
    expect(err).toBeInstanceOf(WorkflowParseError);
    expect((err as WorkflowParseError).message).toMatch(/codex/);
  });

  it("rejects non-map YAML front matter with WorkflowFrontMatterNotAMap", async () => {
    const content = `---
- just
- a
- list
---
body
`;
    const err = await runErr(parseWorkflow(content, FIXTURE_PATH));
    expect(err).toBeInstanceOf(WorkflowFrontMatterNotAMap);
  });

  it("ignores unknown top-level keys for forward compatibility", async () => {
    const content = `---
tracker:
  kind: linear
  project_slug: x
  api_key: x
some_future_extension:
  flag: true
  count: 7
---
body
`;
    const wf = await runOk(parseWorkflow(content, FIXTURE_PATH));
    // Unknown key is silently dropped by schema decode; presence of a
    // sibling section like polling still gets defaults.
    expect(wf.config.polling.interval_ms).toBe(30_000);
    expect(wf.config.tracker.api_key).toBe("x");
  });

  it("falls back to the §5.4 minimal default prompt when body is empty", async () => {
    const onlyFrontMatter = `---
tracker:
  kind: linear
---
`;
    const wf = await runOk(parseWorkflow(onlyFrontMatter, FIXTURE_PATH));
    expect(wf.prompt_template).toBe("You are working on an issue from Linear.");
  });

  it("trims whitespace around the prompt body", async () => {
    const content = `---
tracker:
  kind: linear
---


  prompt content here

`;
    const wf = await runOk(parseWorkflow(content, FIXTURE_PATH));
    expect(wf.prompt_template).toBe("prompt content here");
  });

  it("reports a WorkflowParseError when YAML is malformed", async () => {
    const content = `---
tracker: [unterminated
---
body
`;
    const err = await runErr(parseWorkflow(content, FIXTURE_PATH));
    expect(err).toBeInstanceOf(WorkflowParseError);
  });

  it("rejects non-integer values for integer fields", async () => {
    const content = `---
polling:
  interval_ms: "not a number"
---
body
`;
    const err = await runErr(parseWorkflow(content, FIXTURE_PATH));
    expect(err).toBeInstanceOf(WorkflowParseError);
  });

  it("rejects unknown values for agent_runner.kind", async () => {
    const content = `---
agent_runner:
  kind: codex
---
body
`;
    const err = await runErr(parseWorkflow(content, FIXTURE_PATH));
    expect(err).toBeInstanceOf(WorkflowParseError);
  });
});

describe("validateForDispatch", () => {
  /** Build a minimal valid `WorkflowDefinition` for mutation in negative tests. */
  const baseValid = (): WorkflowDefinition => ({
    source_path: "/tmp/WORKFLOW.md",
    prompt_template: "x",
    config: {
      tracker: {
        kind: "linear",
        endpoint: "https://api.linear.app/graphql",
        api_key: "tok",
        project_slug: "slug",
        active_states: ["Todo"],
        terminal_states: ["Done"],
      },
      polling: { interval_ms: 30_000 },
      workspace: { root: "/tmp/ws" },
      hooks: {
        after_create: null,
        before_run: null,
        after_run: null,
        before_remove: null,
        timeout_ms: 60_000,
      },
      agent_runner: {
        kind: "claude_code",
        command: "claude",
        permission_mode: "bypassPermissions",
        max_turns: 20,
        turn_timeout_ms: 3_600_000,
        read_timeout_ms: 5_000,
        stall_timeout_ms: 300_000,
        network_profile: "claude-code",
        bare: false,
        extra_args: [],
      },
      server: null,
    },
  });

  it("succeeds for a fully-populated workflow", async () => {
    await runOk(validateForDispatch(baseValid()));
  });

  it("fails when tracker.project_slug is missing", async () => {
    const wf: WorkflowDefinition = {
      ...baseValid(),
      config: {
        ...baseValid().config,
        tracker: { ...baseValid().config.tracker, project_slug: null },
      },
    };
    const err = await runErr(validateForDispatch(wf));
    expect((err as { checks: ReadonlyArray<string> }).checks).toContain(
      "tracker.project_slug is required when tracker.kind=linear",
    );
  });

  it("fails when tracker.api_key is missing", async () => {
    const wf: WorkflowDefinition = {
      ...baseValid(),
      config: {
        ...baseValid().config,
        tracker: { ...baseValid().config.tracker, api_key: null },
      },
    };
    const err = await runErr(validateForDispatch(wf));
    expect((err as { checks: ReadonlyArray<string> }).checks).toContain(
      "tracker.api_key is required (after $VAR resolution)",
    );
  });

  it("fails when agent_runner.command is empty", async () => {
    const wf: WorkflowDefinition = {
      ...baseValid(),
      config: {
        ...baseValid().config,
        agent_runner: { ...baseValid().config.agent_runner, command: "" },
      },
    };
    const err = await runErr(validateForDispatch(wf));
    expect((err as { checks: ReadonlyArray<string> }).checks).toContain(
      "agent_runner.command must be a non-empty string",
    );
  });

  it("aggregates multiple failures into one ValidationError", async () => {
    const wf: WorkflowDefinition = {
      ...baseValid(),
      config: {
        ...baseValid().config,
        tracker: {
          ...baseValid().config.tracker,
          api_key: null,
          project_slug: null,
        },
      },
    };
    const err = await runErr(validateForDispatch(wf));
    const checks = (err as { checks: ReadonlyArray<string> }).checks;
    expect(checks.length).toBeGreaterThanOrEqual(2);
  });
});
