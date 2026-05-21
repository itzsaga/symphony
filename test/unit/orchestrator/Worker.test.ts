// Unit tests for src/orchestrator/Worker.ts — exercises the abnormal-exit
// paths reachable with stubbed services (workspace failures, hook failures,
// spawn failures). Happy-path coverage lives in the integration suite.
import { describe, expect, it } from "bun:test";
import { Data, Effect, Layer, Queue, Schema } from "effect";
import {
  TopLevelSchema,
  type TypedConfig,
  type WorkflowDefinition,
} from "../../../src/config/WorkflowSchema.ts";
import type { Issue } from "../../../src/linear/schemas.ts";
import { LinearClient } from "../../../src/linear/LinearClient.ts";
import { Logger } from "../../../src/observability/Logger.ts";
import { Sandbox } from "../../../src/sandbox/Nono.ts";
import { McpServer } from "../../../src/claude/McpServer.ts";
import { WorkspaceHooks } from "../../../src/workspace/Hooks.ts";
import { WorkspaceManager } from "../../../src/workspace/WorkspaceManager.ts";
import { runWorker } from "../../../src/orchestrator/Worker.ts";
import type { OrchestratorEvent } from "../../../src/orchestrator/events.ts";

/* -------------------------------------------------------------------------- */
/* Fixtures.                                                                  */
/* -------------------------------------------------------------------------- */

const makeConfig = (): TypedConfig => {
  const decoded = Schema.decodeUnknownSync(TopLevelSchema)({});
  return {
    tracker: {
      kind: decoded.tracker.kind,
      endpoint: decoded.tracker.endpoint,
      api_key: "tok",
      project_slug: "proj",
      active_states: decoded.tracker.active_states,
      terminal_states: decoded.tracker.terminal_states,
    },
    polling: { interval_ms: decoded.polling.interval_ms },
    workspace: { root: decoded.workspace.root ?? "/tmp/symphony_ws" },
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
    },
    server: null,
  };
};

const makeIssue = (): Issue => ({
  id: "issue-1",
  identifier: "MT-1",
  title: "Test issue",
  description: null,
  priority: 2,
  state: "Todo",
  branch_name: null,
  url: null,
  labels: [],
  blocked_by: [],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
});

const makeWorkflow = (config: TypedConfig): WorkflowDefinition => ({
  config,
  prompt_template: "Work on {{issue.identifier}}: {{issue.title}}",
  source_path: "/tmp/WORKFLOW.md",
});

const silentLoggerLayer: Layer.Layer<Logger> = Layer.succeed(Logger, {
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
  recentEvents: Effect.succeed([]),
});

class FakeWorkspaceError extends Data.TaggedError("WorkspaceCreationFailed")<{
  readonly path: string;
}> {}

class FakeHookError extends Data.TaggedError("HookErrorAfterCreateFailed")<{
  readonly stdout_tail: string;
  readonly stderr_tail: string;
  readonly exit_code: number | null;
  readonly reason: "exit" | "timeout" | "spawn" | "denied";
}> {}

const mcpServerStub: McpServer["Type"] = {
  handle: () => Effect.succeed(null),
};

const sandboxFailingSpawn: Layer.Layer<Sandbox> = Layer.succeed(Sandbox, {
  spawn: () =>
    Effect.fail({
      _tag: "SandboxSpawnFailed",
      argv: [],
      message: "stubbed sandbox failure",
    } as never),
});

const linearStub: LinearClient["Type"] = {
  fetchCandidateIssues: Effect.succeed([]),
  fetchIssuesByStates: () => Effect.succeed([]),
  fetchIssueStatesByIds: () => Effect.succeed([]),
  executeRaw: () => Effect.succeed(null),
};

/* -------------------------------------------------------------------------- */
/* Tests.                                                                     */
/* -------------------------------------------------------------------------- */

describe("runWorker", () => {
  it("returns abnormal when workspace prepare fails", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<OrchestratorEvent>();
        const workspaceManager: WorkspaceManager["Type"] = {
          prepareForIssue: () =>
            Effect.fail(new FakeWorkspaceError({ path: "/nope" })),
          cleanWorkspaceFor: () => Effect.void,
          startupTerminalCleanup: () => Effect.void,
        };
        const workspaceHooks: WorkspaceHooks["Type"] = {
          runAfterCreate: () => Effect.void,
          runBeforeRun: () => Effect.void,
          runAfterRun: () => Effect.void,
          runBeforeRemove: () => Effect.void,
        };
        const config = makeConfig();
        const issue = makeIssue();
        const outcome = yield* runWorker({
          issue,
          workflow: makeWorkflow(config),
          retry_attempt: null,
          events,
          workspaceManager,
          workspaceHooks,
          mcpServer: mcpServerStub,
          linear: linearStub,
        });
        return outcome;
      }),
    );
    const outcome = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          Layer.mergeAll(silentLoggerLayer, sandboxFailingSpawn),
        ),
      ),
    );
    expect(outcome.reason).toBe("abnormal");
    expect(outcome.error).toContain("workspace prepare failed");
  }, 10_000);

  it("returns abnormal when after_create hook fails on a newly-created workspace", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<OrchestratorEvent>();
        const issue = makeIssue();
        const workspaceManager: WorkspaceManager["Type"] = {
          prepareForIssue: () =>
            Effect.succeed({
              path: ("/tmp/symphony_ws/" + issue.identifier) as never,
              workspace_key: issue.identifier,
              created_now: true,
            }),
          cleanWorkspaceFor: () => Effect.void,
          startupTerminalCleanup: () => Effect.void,
        };
        const workspaceHooks: WorkspaceHooks["Type"] = {
          runAfterCreate: () =>
            Effect.fail(
              new FakeHookError({
                stdout_tail: "",
                stderr_tail: "boom",
                exit_code: 1,
                reason: "exit",
              }),
            ),
          runBeforeRun: () => Effect.void,
          runAfterRun: () => Effect.void,
          runBeforeRemove: () => Effect.void,
        };
        const outcome = yield* runWorker({
          issue,
          workflow: makeWorkflow(makeConfig()),
          retry_attempt: null,
          events,
          workspaceManager,
          workspaceHooks,
          mcpServer: mcpServerStub,
          linear: linearStub,
        });
        return outcome;
      }),
    );
    const outcome = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          Layer.mergeAll(silentLoggerLayer, sandboxFailingSpawn),
        ),
      ),
    );
    expect(outcome.reason).toBe("abnormal");
    expect(outcome.error).toContain("after_create hook failed");
  }, 10_000);

  it("returns abnormal when claude spawn fails", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<OrchestratorEvent>();
        const issue = makeIssue();
        const workspaceManager: WorkspaceManager["Type"] = {
          prepareForIssue: () =>
            Effect.succeed({
              path: ("/tmp/symphony_ws/" + issue.identifier) as never,
              workspace_key: issue.identifier,
              created_now: false,
            }),
          cleanWorkspaceFor: () => Effect.void,
          startupTerminalCleanup: () => Effect.void,
        };
        const workspaceHooks: WorkspaceHooks["Type"] = {
          runAfterCreate: () => Effect.void,
          runBeforeRun: () => Effect.void,
          runAfterRun: () => Effect.void,
          runBeforeRemove: () => Effect.void,
        };
        const outcome = yield* runWorker({
          issue,
          workflow: makeWorkflow(makeConfig()),
          retry_attempt: null,
          events,
          workspaceManager,
          workspaceHooks,
          mcpServer: mcpServerStub,
          linear: linearStub,
        });
        return outcome;
      }),
    );
    const outcome = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          Layer.mergeAll(silentLoggerLayer, sandboxFailingSpawn),
        ),
      ),
    );
    expect(outcome.reason).toBe("abnormal");
    expect(outcome.error).toContain("claude spawn failed");
  }, 10_000);
});
