// Unit tests for src/orchestrator/State.ts — pure reducer behavior.
// Covers spec §4.1.5–§4.1.8, §7.3 transitions, §8.4 retry math, §8.5 reconcile.
import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import {
  TopLevelSchema,
  type TypedConfig,
} from "../../../src/config/WorkflowSchema.ts";
import type { Issue } from "../../../src/linear/schemas.ts";
import { TurnCompleted, UsageReport, RateLimit, TextDelta } from "../../../src/claude/EventMapping.ts";
import type { RateLimitInfo, Usage } from "../../../src/claude/StreamJson.ts";
import {
  CONTINUATION_RETRY_DELAY_MS,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  DEFAULT_MAX_RETRY_BACKOFF_MS,
  initialState,
  newRunningEntry,
  reduce,
  type OrchestratorRuntimeState,
  type RunningEntry,
} from "../../../src/orchestrator/State.ts";
import {
  ImmediateTickRequested,
  PollTick,
  RetryTimerFired,
  StallDetected,
  WorkerEventReceived,
  WorkerExited,
  WorkerStarted,
  WorkflowReloaded,
  type OrchestratorEvent,
} from "../../../src/orchestrator/events.ts";
import type {
  CancelRetry,
  EmitMetric,
  InterruptWorker,
  Log,
  ScheduleRetry,
  SideEffect,
} from "../../../src/orchestrator/sideEffects.ts";

/* -------------------------------------------------------------------------- */
/* Fixtures.                                                                  */
/* -------------------------------------------------------------------------- */

const makeConfig = (
  patch: { polling_interval_ms?: number } = {},
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
    polling: {
      interval_ms:
        patch.polling_interval_ms ?? decoded.polling.interval_ms,
    },
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
    },
    server: null,
  };
};

const makeIssue = (overrides: Partial<Issue> = {}): Issue => ({
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
  ...overrides,
});

const makeRunningEntry = (
  overrides: Partial<RunningEntry> = {},
  issueOverrides: Partial<Issue> = {},
): RunningEntry => {
  const base = newRunningEntry({
    issue: makeIssue(issueOverrides),
    workspace_path: "/tmp/symphony-ws/MT-1",
    started_at: new Date("2024-01-01T00:00:00Z"),
    attempt: null,
    retry_attempt: null,
  });
  return { ...base, ...overrides };
};

const findSideEffect = <T extends SideEffect["_tag"]>(
  effects: ReadonlyArray<SideEffect>,
  tag: T,
): Extract<SideEffect, { _tag: T }> | undefined =>
  effects.find(
    (e): e is Extract<SideEffect, { _tag: T }> => e._tag === tag,
  );

/* -------------------------------------------------------------------------- */
/* initialState.                                                              */
/* -------------------------------------------------------------------------- */

describe("initialState", () => {
  it("populates poll_interval_ms from config and zeroes everything else", () => {
    const config = makeConfig({ polling_interval_ms: 12_345 });
    const state = initialState(config);
    expect(state.poll_interval_ms).toBe(12_345);
    expect(state.max_concurrent_agents).toBe(DEFAULT_MAX_CONCURRENT_AGENTS);
    expect(state.running.size).toBe(0);
    expect(state.claimed.size).toBe(0);
    expect(state.retry_attempts.size).toBe(0);
    expect(state.completed.size).toBe(0);
    expect(state.claude_totals).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      seconds_running: 0,
    });
    expect(state.claude_rate_limits).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* PollTick / ImmediateTickRequested.                                         */
/* -------------------------------------------------------------------------- */

describe("PollTick", () => {
  it("is a no-op for state", () => {
    const state = initialState(makeConfig());
    const result = reduce(state, new PollTick({ at: new Date() }));
    expect(result.state).toBe(state);
    expect(result.sideEffects).toEqual([]);
  });
});

describe("ImmediateTickRequested", () => {
  it("emits a Log side effect and leaves state unchanged", () => {
    const state = initialState(makeConfig());
    const result = reduce(
      state,
      new ImmediateTickRequested({ at: new Date() }),
    );
    expect(result.state).toBe(state);
    expect(result.sideEffects.length).toBe(1);
    expect(findSideEffect(result.sideEffects, "Log")).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* WorkerStarted.                                                             */
/* -------------------------------------------------------------------------- */

describe("WorkerStarted", () => {
  it("adds the issue to running and claimed and logs", () => {
    const state = initialState(makeConfig());
    const issue = makeIssue();
    const entry = makeRunningEntry({});
    const result = reduce(
      state,
      new WorkerStarted({ issue, runningEntry: entry }),
    );
    expect(result.state.running.size).toBe(1);
    expect(result.state.running.get(issue.id)).toBe(entry);
    expect(result.state.claimed.has(issue.id)).toBe(true);
    expect(findSideEffect(result.sideEffects, "Log")).toBeDefined();
  });

  it("removes any existing retry_attempts entry and emits CancelRetry", () => {
    const cfg = makeConfig();
    const issue = makeIssue();
    const entry = makeRunningEntry({});
    const stateWithRetry: OrchestratorRuntimeState = {
      ...initialState(cfg),
      retry_attempts: new Map([
        [
          issue.id,
          {
            issue_id: issue.id,
            identifier: issue.identifier,
            attempt: 2,
            due_at_ms: 0,
            timer_handle: null,
            error: "boom",
          },
        ],
      ]),
      claimed: new Set([issue.id]),
    };
    const result = reduce(
      stateWithRetry,
      new WorkerStarted({ issue, runningEntry: entry }),
    );
    expect(result.state.retry_attempts.has(issue.id)).toBe(false);
    const cancel = findSideEffect(result.sideEffects, "CancelRetry");
    expect(cancel).toBeDefined();
    expect((cancel as CancelRetry).issue_id).toBe(issue.id);
  });
});

/* -------------------------------------------------------------------------- */
/* WorkerEventReceived.                                                       */
/* -------------------------------------------------------------------------- */

describe("WorkerEventReceived", () => {
  it("increments turn_count on TurnCompleted", () => {
    const cfg = makeConfig();
    const issue = makeIssue();
    const entry = makeRunningEntry({ turn_count: 0 });
    const state: OrchestratorRuntimeState = {
      ...initialState(cfg),
      running: new Map([[issue.id, entry]]),
      claimed: new Set([issue.id]),
    };
    const event = new TurnCompleted({
      thread_id: "tid",
      turn_id: 1,
      session_id: "tid-1",
      duration_ms: 1000,
      duration_api_ms: 800,
      num_turns: 1,
      total_cost_usd: null,
      usage: null,
      model_usage: null,
    });
    const result = reduce(
      state,
      new WorkerEventReceived({ issue_id: issue.id, event }),
    );
    const updated = result.state.running.get(issue.id);
    expect(updated?.turn_count).toBe(1);
    expect(updated?.session_id).toBe("tid-1");
    expect(updated?.thread_id).toBe("tid");
  });

  it("computes token deltas against last_reported_* on UsageReport", () => {
    const cfg = makeConfig();
    const issue = makeIssue();
    const entry = makeRunningEntry({
      claude_input_tokens: 100,
      claude_output_tokens: 50,
      claude_total_tokens: 150,
      last_reported_input_tokens: 100,
      last_reported_output_tokens: 50,
      last_reported_total_tokens: 150,
    });
    const state: OrchestratorRuntimeState = {
      ...initialState(cfg),
      running: new Map([[issue.id, entry]]),
      claimed: new Set([issue.id]),
    };
    const usage: Usage = {
      input_tokens: 150,
      output_tokens: 80,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    const event = new UsageReport({
      thread_id: "tid",
      turn_id: 1,
      usage,
      total_cost_usd: null,
      model_usage: null,
    });
    const result = reduce(
      state,
      new WorkerEventReceived({ issue_id: issue.id, event }),
    );
    // Deltas: 50 input, 30 output, 80 total (150+80 - 150).
    expect(result.state.claude_totals.input_tokens).toBe(50);
    expect(result.state.claude_totals.output_tokens).toBe(30);
    expect(result.state.claude_totals.total_tokens).toBe(80);
    const updated = result.state.running.get(issue.id);
    expect(updated?.last_reported_input_tokens).toBe(150);
    expect(updated?.last_reported_output_tokens).toBe(80);
    expect(updated?.last_reported_total_tokens).toBe(230);
  });

  it("stashes the latest rate-limit payload on RateLimit", () => {
    const cfg = makeConfig();
    const issue = makeIssue();
    const entry = makeRunningEntry({});
    const state: OrchestratorRuntimeState = {
      ...initialState(cfg),
      running: new Map([[issue.id, entry]]),
      claimed: new Set([issue.id]),
    };
    const info: RateLimitInfo = { status: "warning" };
    const event = new RateLimit({ info });
    const result = reduce(
      state,
      new WorkerEventReceived({ issue_id: issue.id, event }),
    );
    expect(result.state.claude_rate_limits).toEqual(info);
  });

  it("mirrors TextDelta text onto last_message", () => {
    const cfg = makeConfig();
    const issue = makeIssue();
    const entry = makeRunningEntry({});
    const state: OrchestratorRuntimeState = {
      ...initialState(cfg),
      running: new Map([[issue.id, entry]]),
      claimed: new Set([issue.id]),
    };
    const event = new TextDelta({ thread_id: "tid", text: "hello" });
    const result = reduce(
      state,
      new WorkerEventReceived({ issue_id: issue.id, event }),
    );
    expect(result.state.running.get(issue.id)?.last_message).toBe("hello");
  });

  it("warns and drops the event if the issue is not running", () => {
    const cfg = makeConfig();
    const state = initialState(cfg);
    const event = new TurnCompleted({
      thread_id: "tid",
      turn_id: 1,
      session_id: "tid-1",
      duration_ms: 1000,
      duration_api_ms: 800,
      num_turns: 1,
      total_cost_usd: null,
      usage: null,
      model_usage: null,
    });
    const result = reduce(
      state,
      new WorkerEventReceived({ issue_id: "nonexistent", event }),
    );
    expect(result.state).toBe(state);
    expect(findSideEffect(result.sideEffects, "Log")).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* WorkerExited.                                                              */
/* -------------------------------------------------------------------------- */

describe("WorkerExited", () => {
  it("removes from running, adds to completed, schedules continuation retry (normal)", () => {
    const cfg = makeConfig();
    const issue = makeIssue();
    const startedAt = new Date("2024-01-01T00:00:00Z");
    const exitedAt = new Date("2024-01-01T00:00:05Z");
    const entry = makeRunningEntry({ started_at: startedAt });
    const state: OrchestratorRuntimeState = {
      ...initialState(cfg),
      running: new Map([[issue.id, entry]]),
      claimed: new Set([issue.id]),
    };
    const result = reduce(
      state,
      new WorkerExited({
        issue_id: issue.id,
        reason: "normal",
        error: null,
        at: exitedAt,
      }),
    );
    expect(result.state.running.has(issue.id)).toBe(false);
    expect(result.state.completed.has(issue.id)).toBe(true);
    expect(result.state.claude_totals.seconds_running).toBe(5);
    const retry = result.state.retry_attempts.get(issue.id);
    expect(retry).toBeDefined();
    expect(retry?.attempt).toBe(1);
    const schedule = findSideEffect(result.sideEffects, "ScheduleRetry");
    expect(schedule).toBeDefined();
    expect((schedule as ScheduleRetry).delay_ms).toBe(
      CONTINUATION_RETRY_DELAY_MS,
    );
    expect((schedule as ScheduleRetry).attempt).toBe(1);
    const metric = findSideEffect(result.sideEffects, "EmitMetric");
    expect((metric as EmitMetric).kind).toBe("worker_exit");
  });

  it("schedules exponential-backoff retry on abnormal exit", () => {
    const cfg = makeConfig();
    const issue = makeIssue();
    const startedAt = new Date("2024-01-01T00:00:00Z");
    const exitedAt = new Date("2024-01-01T00:00:10Z");
    const entry = makeRunningEntry({
      started_at: startedAt,
      retry_attempt: 1,
    });
    const state: OrchestratorRuntimeState = {
      ...initialState(cfg),
      running: new Map([[issue.id, entry]]),
      claimed: new Set([issue.id]),
    };
    const result = reduce(
      state,
      new WorkerExited({
        issue_id: issue.id,
        reason: "abnormal",
        error: "process crashed",
        at: exitedAt,
      }),
    );
    expect(result.state.running.has(issue.id)).toBe(false);
    // Abnormal exit does not push to `completed`.
    expect(result.state.completed.has(issue.id)).toBe(false);
    const retry = result.state.retry_attempts.get(issue.id);
    expect(retry).toBeDefined();
    expect(retry?.attempt).toBe(2);
    expect(retry?.error).toBe("process crashed");
    const schedule = findSideEffect(result.sideEffects, "ScheduleRetry");
    expect(schedule).toBeDefined();
    // attempt=2 → 10s * 2^(2-1) = 20_000 ms, well under cap.
    expect((schedule as ScheduleRetry).delay_ms).toBe(20_000);
  });

  it("caps exponential backoff at DEFAULT_MAX_RETRY_BACKOFF_MS", () => {
    const cfg = makeConfig();
    const issue = makeIssue();
    const startedAt = new Date("2024-01-01T00:00:00Z");
    const exitedAt = new Date("2024-01-01T00:00:01Z");
    // retry_attempt=20 → next=21 → 10s * 2^20 = ~10.5 billion ms, way over cap.
    const entry = makeRunningEntry({
      started_at: startedAt,
      retry_attempt: 20,
    });
    const state: OrchestratorRuntimeState = {
      ...initialState(cfg),
      running: new Map([[issue.id, entry]]),
      claimed: new Set([issue.id]),
    };
    const result = reduce(
      state,
      new WorkerExited({
        issue_id: issue.id,
        reason: "abnormal",
        error: "boom",
        at: exitedAt,
      }),
    );
    const schedule = findSideEffect(result.sideEffects, "ScheduleRetry");
    expect((schedule as ScheduleRetry).delay_ms).toBe(
      DEFAULT_MAX_RETRY_BACKOFF_MS,
    );
  });

  it("releases the claim and logs when an unknown issue exits", () => {
    const cfg = makeConfig();
    const state: OrchestratorRuntimeState = {
      ...initialState(cfg),
      claimed: new Set(["ghost"]),
    };
    const result = reduce(
      state,
      new WorkerExited({
        issue_id: "ghost",
        reason: "normal",
        error: null,
        at: new Date(),
      }),
    );
    expect(result.state.claimed.has("ghost")).toBe(false);
    expect(findSideEffect(result.sideEffects, "Log")).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* RetryTimerFired.                                                           */
/* -------------------------------------------------------------------------- */

describe("RetryTimerFired", () => {
  it("removes the retry entry and emits a Log", () => {
    const cfg = makeConfig();
    const issue = makeIssue();
    const state: OrchestratorRuntimeState = {
      ...initialState(cfg),
      retry_attempts: new Map([
        [
          issue.id,
          {
            issue_id: issue.id,
            identifier: issue.identifier,
            attempt: 3,
            due_at_ms: 0,
            timer_handle: null,
            error: null,
          },
        ],
      ]),
      claimed: new Set([issue.id]),
    };
    const result = reduce(
      state,
      new RetryTimerFired({ issue_id: issue.id, attempt: 3 }),
    );
    expect(result.state.retry_attempts.has(issue.id)).toBe(false);
    // The reducer does NOT touch claimed here — the caller decides whether
    // to re-dispatch (and thus re-add) or release the claim explicitly.
    expect(result.state.claimed.has(issue.id)).toBe(true);
    expect(findSideEffect(result.sideEffects, "Log")).toBeDefined();
  });

  it("is a no-op when no retry entry exists", () => {
    const cfg = makeConfig();
    const state = initialState(cfg);
    const result = reduce(
      state,
      new RetryTimerFired({ issue_id: "unknown", attempt: 1 }),
    );
    expect(result.state).toEqual(state);
    expect(result.sideEffects).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* StallDetected.                                                             */
/* -------------------------------------------------------------------------- */

describe("StallDetected", () => {
  it("emits InterruptWorker(reason=stall) for a known issue", () => {
    const cfg = makeConfig();
    const issue = makeIssue();
    const entry = makeRunningEntry({});
    const state: OrchestratorRuntimeState = {
      ...initialState(cfg),
      running: new Map([[issue.id, entry]]),
      claimed: new Set([issue.id]),
    };
    const result = reduce(
      state,
      new StallDetected({ issue_id: issue.id, at: new Date() }),
    );
    // State doesn't change here; we let the resulting WorkerExited do the
    // bookkeeping.
    expect(result.state.running.has(issue.id)).toBe(true);
    const interrupt = findSideEffect(result.sideEffects, "InterruptWorker");
    expect(interrupt).toBeDefined();
    expect((interrupt as InterruptWorker).reason).toBe("stall");
  });

  it("warns when the stall references an unknown issue", () => {
    const cfg = makeConfig();
    const state = initialState(cfg);
    const result = reduce(
      state,
      new StallDetected({ issue_id: "ghost", at: new Date() }),
    );
    expect(result.state).toBe(state);
    expect(findSideEffect(result.sideEffects, "Log")).toBeDefined();
    expect(findSideEffect(result.sideEffects, "InterruptWorker")).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* WorkflowReloaded.                                                          */
/* -------------------------------------------------------------------------- */

describe("WorkflowReloaded", () => {
  it("updates poll_interval_ms from the new config and does not touch running", () => {
    const cfg = makeConfig();
    const issue = makeIssue();
    const entry = makeRunningEntry({});
    const state: OrchestratorRuntimeState = {
      ...initialState(cfg),
      running: new Map([[issue.id, entry]]),
      claimed: new Set([issue.id]),
    };
    const newCfg = makeConfig({ polling_interval_ms: 60_000 });
    const result = reduce(
      state,
      new WorkflowReloaded({
        definition: {
          config: newCfg,
          prompt_template: "anything",
          source_path: "/tmp/WORKFLOW.md",
        },
      }),
    );
    expect(result.state.poll_interval_ms).toBe(60_000);
    expect(result.state.running.has(issue.id)).toBe(true);
    expect(result.state.running.get(issue.id)).toBe(entry);
    expect(findSideEffect(result.sideEffects, "Log")).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Exhaustiveness: any unhandled OrchestratorEvent variant is a compile       */
/* error via Match.tagsExhaustive — this test exercises every constructor    */
/* once so a future variant addition would fail typecheck on the reducer    */
/* AND show up here.                                                          */
/* -------------------------------------------------------------------------- */

describe("reducer exhaustiveness", () => {
  it("handles every OrchestratorEvent variant without throwing", () => {
    const cfg = makeConfig();
    const state = initialState(cfg);
    const events: ReadonlyArray<OrchestratorEvent> = [
      new PollTick({ at: new Date() }),
      new WorkerStarted({
        issue: makeIssue(),
        runningEntry: makeRunningEntry({}),
      }),
      new WorkerEventReceived({
        issue_id: "issue-1",
        event: new TextDelta({ thread_id: null, text: "x" }),
      }),
      new WorkerExited({
        issue_id: "issue-1",
        reason: "normal",
        error: null,
        at: new Date(),
      }),
      new RetryTimerFired({ issue_id: "issue-1", attempt: 1 }),
      new StallDetected({ issue_id: "issue-1", at: new Date() }),
      new WorkflowReloaded({
        definition: {
          config: cfg,
          prompt_template: "",
          source_path: "/tmp/WORKFLOW.md",
        },
      }),
      new ImmediateTickRequested({ at: new Date() }),
    ];
    for (const event of events) {
      // Each call must return a valid ReduceResult — the assertions are
      // structural rather than precise.
      const result = reduce(state, event);
      expect(result).toBeDefined();
      expect(result.state).toBeDefined();
      expect(Array.isArray(result.sideEffects)).toBe(true);
    }
  });
});
