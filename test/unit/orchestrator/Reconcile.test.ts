// Unit tests for src/orchestrator/Reconcile.ts — pure helpers for §8.5
// Part A (stall detection) and Part B (tracker state refresh).
import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import {
  TopLevelSchema,
  type TypedConfig,
} from "../../../src/config/WorkflowSchema.ts";
import type { Issue, MinimalIssue } from "../../../src/linear/schemas.ts";
import {
  initialState,
  newRunningEntry,
  type OrchestratorRuntimeState,
  type RunningEntry,
} from "../../../src/orchestrator/State.ts";
import {
  reconcileStalled,
  reconcileTrackerStates,
} from "../../../src/orchestrator/Reconcile.ts";
import type { OrchestratorEvent } from "../../../src/orchestrator/events.ts";
import type {
  CleanupWorkspace,
  InterruptWorker,
  ScheduleRetry,
  SideEffect,
  UpdateIssueSnapshot,
} from "../../../src/orchestrator/sideEffects.ts";

/* -------------------------------------------------------------------------- */
/* Fixtures.                                                                  */
/* -------------------------------------------------------------------------- */

const makeConfig = (
  patch: { stall_timeout_ms?: number } = {},
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
      stall_timeout_ms:
        patch.stall_timeout_ms ?? decoded.agent_runner.stall_timeout_ms,
      network_profile: decoded.agent_runner.network_profile,
      bare: decoded.agent_runner.bare,
      extra_args: decoded.agent_runner.extra_args,
      max_concurrent_agents: decoded.agent_runner.max_concurrent_agents,
      max_concurrent_agents_by_state:
        decoded.agent_runner.max_concurrent_agents_by_state,
      max_retry_backoff_ms: decoded.agent_runner.max_retry_backoff_ms,
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

const findEvent = <T extends OrchestratorEvent["_tag"]>(
  events: ReadonlyArray<OrchestratorEvent>,
  tag: T,
): Extract<OrchestratorEvent, { _tag: T }> | undefined =>
  events.find(
    (e): e is Extract<OrchestratorEvent, { _tag: T }> => e._tag === tag,
  );

/* -------------------------------------------------------------------------- */
/* Part A — reconcileStalled.                                                 */
/* -------------------------------------------------------------------------- */

describe("reconcileStalled", () => {
  it("emits StallDetected + InterruptWorker + ScheduleRetry when elapsed exceeds timeout", () => {
    const config = makeConfig({ stall_timeout_ms: 5 * 60_000 });
    const issue = makeIssue();
    const startedAt = new Date("2024-01-01T00:00:00Z");
    const now = new Date("2024-01-01T00:06:00Z"); // 6 minutes later
    const entry = makeRunningEntry({
      started_at: startedAt,
      last_event_at: null,
    });
    const state: OrchestratorRuntimeState = {
      ...initialState(config),
      running: new Map([[issue.id, entry]]),
      claimed: new Set([issue.id]),
    };

    const result = reconcileStalled(state, config, now);

    expect(result.events.length).toBe(1);
    const stallEvent = findEvent(result.events, "StallDetected");
    expect(stallEvent).toBeDefined();
    expect(stallEvent?.issue_id).toBe(issue.id);

    const interrupt = findSideEffect(result.sideEffects, "InterruptWorker");
    expect(interrupt).toBeDefined();
    expect((interrupt as InterruptWorker).reason).toBe("stall");
    expect((interrupt as InterruptWorker).issue_id).toBe(issue.id);

    const schedule = findSideEffect(result.sideEffects, "ScheduleRetry");
    expect(schedule).toBeDefined();
    expect((schedule as ScheduleRetry).issue_id).toBe(issue.id);
    expect((schedule as ScheduleRetry).attempt).toBe(1);
    // First stall, attempt=1 → 10_000 ms (base * 2^0).
    expect((schedule as ScheduleRetry).delay_ms).toBe(10_000);
  });

  it("is a no-op when stall_timeout_ms <= 0", () => {
    const config = makeConfig({ stall_timeout_ms: 0 });
    const issue = makeIssue();
    const startedAt = new Date("2024-01-01T00:00:00Z");
    const now = new Date("2024-01-01T01:00:00Z"); // an hour later
    const entry = makeRunningEntry({ started_at: startedAt });
    const state: OrchestratorRuntimeState = {
      ...initialState(config),
      running: new Map([[issue.id, entry]]),
      claimed: new Set([issue.id]),
    };

    const result = reconcileStalled(state, config, now);

    expect(result.events).toEqual([]);
    expect(result.sideEffects).toEqual([]);
  });

  it("is a no-op when stall_timeout_ms is negative", () => {
    const config = makeConfig({ stall_timeout_ms: -1 });
    const issue = makeIssue();
    const startedAt = new Date("2024-01-01T00:00:00Z");
    const now = new Date("2024-01-01T01:00:00Z");
    const entry = makeRunningEntry({ started_at: startedAt });
    const state: OrchestratorRuntimeState = {
      ...initialState(config),
      running: new Map([[issue.id, entry]]),
      claimed: new Set([issue.id]),
    };

    const result = reconcileStalled(state, config, now);

    expect(result.events).toEqual([]);
    expect(result.sideEffects).toEqual([]);
  });

  it("uses last_event_at when present, not started_at", () => {
    const config = makeConfig({ stall_timeout_ms: 5 * 60_000 });
    const issue = makeIssue();
    // started_at is 6 minutes ago (would otherwise trigger), but
    // last_event_at is 1 minute ago — so no stall.
    const startedAt = new Date("2024-01-01T00:00:00Z");
    const lastEventAt = new Date("2024-01-01T00:05:00Z");
    const now = new Date("2024-01-01T00:06:00Z");
    const entry = makeRunningEntry({
      started_at: startedAt,
      last_event_at: lastEventAt,
    });
    const state: OrchestratorRuntimeState = {
      ...initialState(config),
      running: new Map([[issue.id, entry]]),
      claimed: new Set([issue.id]),
    };

    const result = reconcileStalled(state, config, now);

    expect(result.events).toEqual([]);
    expect(result.sideEffects).toEqual([]);
  });

  it("falls back to started_at when last_event_at is null", () => {
    const config = makeConfig({ stall_timeout_ms: 5 * 60_000 });
    const issue = makeIssue();
    const startedAt = new Date("2024-01-01T00:00:00Z");
    const now = new Date("2024-01-01T00:06:00Z");
    const entry = makeRunningEntry({
      started_at: startedAt,
      last_event_at: null,
    });
    const state: OrchestratorRuntimeState = {
      ...initialState(config),
      running: new Map([[issue.id, entry]]),
      claimed: new Set([issue.id]),
    };

    const result = reconcileStalled(state, config, now);

    expect(findEvent(result.events, "StallDetected")).toBeDefined();
  });

  it("does not stall when elapsed is exactly equal to timeout", () => {
    const config = makeConfig({ stall_timeout_ms: 5 * 60_000 });
    const issue = makeIssue();
    const startedAt = new Date("2024-01-01T00:00:00Z");
    const now = new Date("2024-01-01T00:05:00Z"); // exactly 5 minutes
    const entry = makeRunningEntry({ started_at: startedAt });
    const state: OrchestratorRuntimeState = {
      ...initialState(config),
      running: new Map([[issue.id, entry]]),
      claimed: new Set([issue.id]),
    };

    const result = reconcileStalled(state, config, now);

    // Spec §8.5 Part A uses strict `>` — equality is not a stall.
    expect(result.events).toEqual([]);
    expect(result.sideEffects).toEqual([]);
  });

  it("returns empty when there are no running issues", () => {
    const config = makeConfig({ stall_timeout_ms: 5 * 60_000 });
    const state = initialState(config);
    const result = reconcileStalled(state, config, new Date());
    expect(result.events).toEqual([]);
    expect(result.sideEffects).toEqual([]);
  });

  it("walks multiple running issues independently", () => {
    const config = makeConfig({ stall_timeout_ms: 5 * 60_000 });
    const issueA = makeIssue({ id: "issue-a", identifier: "MT-1" });
    const issueB = makeIssue({ id: "issue-b", identifier: "MT-2" });
    const now = new Date("2024-01-01T00:10:00Z");
    // A is stalled (started 10 min ago, no event), B is fresh (started 1 min ago).
    const entryA = makeRunningEntry(
      {
        started_at: new Date("2024-01-01T00:00:00Z"),
        last_event_at: null,
      },
      { id: "issue-a", identifier: "MT-1" },
    );
    const entryB = makeRunningEntry(
      {
        started_at: new Date("2024-01-01T00:09:00Z"),
        last_event_at: null,
      },
      { id: "issue-b", identifier: "MT-2" },
    );
    const state: OrchestratorRuntimeState = {
      ...initialState(config),
      running: new Map([
        [issueA.id, entryA],
        [issueB.id, entryB],
      ]),
      claimed: new Set([issueA.id, issueB.id]),
    };

    const result = reconcileStalled(state, config, now);

    const stallEvents = result.events.filter(
      (e) => e._tag === "StallDetected",
    );
    expect(stallEvents.length).toBe(1);
    const stallEvent = findEvent(result.events, "StallDetected");
    expect(stallEvent?.issue_id).toBe("issue-a");

    const interrupts = result.sideEffects.filter(
      (e) => e._tag === "InterruptWorker",
    );
    expect(interrupts.length).toBe(1);
  });

  it("uses prior retry_attempt to compute exponential backoff", () => {
    const config = makeConfig({ stall_timeout_ms: 5 * 60_000 });
    const issue = makeIssue();
    const now = new Date("2024-01-01T00:10:00Z");
    const entry = makeRunningEntry({
      started_at: new Date("2024-01-01T00:00:00Z"),
      last_event_at: null,
      retry_attempt: 2,
    });
    const state: OrchestratorRuntimeState = {
      ...initialState(config),
      running: new Map([[issue.id, entry]]),
      claimed: new Set([issue.id]),
    };

    const result = reconcileStalled(state, config, now);

    const schedule = findSideEffect(result.sideEffects, "ScheduleRetry");
    expect(schedule).toBeDefined();
    expect((schedule as ScheduleRetry).attempt).toBe(3);
    // 10_000 * 2^(3-1) = 40_000 ms, well under cap.
    expect((schedule as ScheduleRetry).delay_ms).toBe(40_000);
  });

  it("caps the backoff at the max retry backoff", () => {
    const config = makeConfig({ stall_timeout_ms: 5 * 60_000 });
    const issue = makeIssue();
    const now = new Date("2024-01-01T00:10:00Z");
    const entry = makeRunningEntry({
      started_at: new Date("2024-01-01T00:00:00Z"),
      last_event_at: null,
      retry_attempt: 100,
    });
    const state: OrchestratorRuntimeState = {
      ...initialState(config),
      running: new Map([[issue.id, entry]]),
      claimed: new Set([issue.id]),
    };

    const result = reconcileStalled(state, config, now);

    const schedule = findSideEffect(result.sideEffects, "ScheduleRetry");
    expect((schedule as ScheduleRetry).delay_ms).toBe(300_000);
  });
});

/* -------------------------------------------------------------------------- */
/* Part B — reconcileTrackerStates.                                           */
/* -------------------------------------------------------------------------- */

const lowercaseSet = (xs: ReadonlyArray<string>): ReadonlySet<string> =>
  new Set(xs.map((x) => x.toLowerCase()));

describe("reconcileTrackerStates", () => {
  it("emits InterruptWorker + CleanupWorkspace for terminal-state issues", () => {
    const config = makeConfig();
    const issue = makeIssue();
    const entry = makeRunningEntry({});
    const state: OrchestratorRuntimeState = {
      ...initialState(config),
      running: new Map([[issue.id, entry]]),
      claimed: new Set([issue.id]),
    };
    const refreshed: ReadonlyArray<MinimalIssue> = [
      { id: issue.id, identifier: issue.identifier, state: "Done" },
    ];

    const result = reconcileTrackerStates(
      state,
      refreshed,
      lowercaseSet(config.tracker.terminal_states),
      lowercaseSet(config.tracker.active_states),
    );

    expect(result.events).toEqual([]);
    const interrupt = findSideEffect(result.sideEffects, "InterruptWorker");
    expect(interrupt).toBeDefined();
    expect((interrupt as InterruptWorker).reason).toBe("terminal");
    const cleanup = findSideEffect(result.sideEffects, "CleanupWorkspace");
    expect(cleanup).toBeDefined();
    expect((cleanup as CleanupWorkspace).identifier).toBe(issue.identifier);
  });

  it("emits UpdateIssueSnapshot only when state is still active", () => {
    const config = makeConfig();
    const issue = makeIssue({ state: "Todo" });
    const entry = makeRunningEntry({}, { state: "Todo" });
    const state: OrchestratorRuntimeState = {
      ...initialState(config),
      running: new Map([[issue.id, entry]]),
      claimed: new Set([issue.id]),
    };
    const refreshed: ReadonlyArray<MinimalIssue> = [
      { id: issue.id, identifier: issue.identifier, state: "In Progress" },
    ];

    const result = reconcileTrackerStates(
      state,
      refreshed,
      lowercaseSet(config.tracker.terminal_states),
      lowercaseSet(config.tracker.active_states),
    );

    expect(result.events).toEqual([]);
    expect(findSideEffect(result.sideEffects, "InterruptWorker")).toBeUndefined();
    expect(findSideEffect(result.sideEffects, "CleanupWorkspace")).toBeUndefined();
    const update = findSideEffect(result.sideEffects, "UpdateIssueSnapshot");
    expect(update).toBeDefined();
    expect((update as UpdateIssueSnapshot).issue_id).toBe(issue.id);
    expect((update as UpdateIssueSnapshot).issue.state).toBe("In Progress");
  });

  it("emits InterruptWorker WITHOUT CleanupWorkspace when neither active nor terminal", () => {
    const config = makeConfig();
    const issue = makeIssue();
    const entry = makeRunningEntry({});
    const state: OrchestratorRuntimeState = {
      ...initialState(config),
      running: new Map([[issue.id, entry]]),
      claimed: new Set([issue.id]),
    };
    const refreshed: ReadonlyArray<MinimalIssue> = [
      { id: issue.id, identifier: issue.identifier, state: "Backlog" },
    ];

    const result = reconcileTrackerStates(
      state,
      refreshed,
      lowercaseSet(config.tracker.terminal_states),
      lowercaseSet(config.tracker.active_states),
    );

    const interrupt = findSideEffect(result.sideEffects, "InterruptWorker");
    expect(interrupt).toBeDefined();
    expect((interrupt as InterruptWorker).reason).toBe("non_active");
    expect(findSideEffect(result.sideEffects, "CleanupWorkspace")).toBeUndefined();
    expect(findSideEffect(result.sideEffects, "UpdateIssueSnapshot")).toBeUndefined();
  });

  it("matches state names case-insensitively (DONE matches done)", () => {
    const config = makeConfig();
    const issue = makeIssue();
    const entry = makeRunningEntry({});
    const state: OrchestratorRuntimeState = {
      ...initialState(config),
      running: new Map([[issue.id, entry]]),
      claimed: new Set([issue.id]),
    };
    const refreshed: ReadonlyArray<MinimalIssue> = [
      { id: issue.id, identifier: issue.identifier, state: "DONE" },
    ];

    const result = reconcileTrackerStates(
      state,
      refreshed,
      lowercaseSet(config.tracker.terminal_states),
      lowercaseSet(config.tracker.active_states),
    );

    expect(findSideEffect(result.sideEffects, "InterruptWorker")).toBeDefined();
    expect(findSideEffect(result.sideEffects, "CleanupWorkspace")).toBeDefined();
  });

  it("ignores refreshed entries for issues not in `running`", () => {
    const config = makeConfig();
    const state = initialState(config);
    const refreshed: ReadonlyArray<MinimalIssue> = [
      { id: "ghost", identifier: "GH-1", state: "Done" },
    ];

    const result = reconcileTrackerStates(
      state,
      refreshed,
      lowercaseSet(config.tracker.terminal_states),
      lowercaseSet(config.tracker.active_states),
    );

    expect(result.events).toEqual([]);
    expect(result.sideEffects).toEqual([]);
  });

  it("leaves running entries alone when their id is absent from refreshed", () => {
    // §8.5 callers fetch state for all running ids; if Linear silently
    // omits one we keep it running and let the next tick decide.
    const config = makeConfig();
    const issue = makeIssue();
    const entry = makeRunningEntry({});
    const state: OrchestratorRuntimeState = {
      ...initialState(config),
      running: new Map([[issue.id, entry]]),
      claimed: new Set([issue.id]),
    };

    const result = reconcileTrackerStates(
      state,
      [], // empty refresh — Linear didn't return our issue
      lowercaseSet(config.tracker.terminal_states),
      lowercaseSet(config.tracker.active_states),
    );

    expect(result.events).toEqual([]);
    expect(result.sideEffects).toEqual([]);
  });

  it("classifies each refreshed issue independently", () => {
    const config = makeConfig();
    const a = makeIssue({ id: "a", identifier: "MT-A" });
    const b = makeIssue({ id: "b", identifier: "MT-B" });
    const c = makeIssue({ id: "c", identifier: "MT-C" });
    const entryA = makeRunningEntry({}, { id: "a", identifier: "MT-A" });
    const entryB = makeRunningEntry({}, { id: "b", identifier: "MT-B" });
    const entryC = makeRunningEntry({}, { id: "c", identifier: "MT-C" });
    const state: OrchestratorRuntimeState = {
      ...initialState(config),
      running: new Map([
        [a.id, entryA],
        [b.id, entryB],
        [c.id, entryC],
      ]),
      claimed: new Set([a.id, b.id, c.id]),
    };
    const refreshed: ReadonlyArray<MinimalIssue> = [
      { id: "a", identifier: "MT-A", state: "Done" }, // terminal
      { id: "b", identifier: "MT-B", state: "In Progress" }, // active
      { id: "c", identifier: "MT-C", state: "Backlog" }, // neither
    ];

    const result = reconcileTrackerStates(
      state,
      refreshed,
      lowercaseSet(config.tracker.terminal_states),
      lowercaseSet(config.tracker.active_states),
    );

    const interrupts = result.sideEffects.filter(
      (e): e is InterruptWorker => e._tag === "InterruptWorker",
    );
    expect(interrupts.length).toBe(2);
    expect(interrupts.find((e) => e.issue_id === "a")?.reason).toBe(
      "terminal",
    );
    expect(interrupts.find((e) => e.issue_id === "c")?.reason).toBe(
      "non_active",
    );

    const cleanups = result.sideEffects.filter(
      (e) => e._tag === "CleanupWorkspace",
    );
    expect(cleanups.length).toBe(1);

    const updates = result.sideEffects.filter(
      (e) => e._tag === "UpdateIssueSnapshot",
    );
    expect(updates.length).toBe(1);
    expect((updates[0] as UpdateIssueSnapshot).issue_id).toBe("b");
  });

  it("matches mixed-case active state names case-insensitively", () => {
    const config = makeConfig();
    const issue = makeIssue();
    const entry = makeRunningEntry({});
    const state: OrchestratorRuntimeState = {
      ...initialState(config),
      running: new Map([[issue.id, entry]]),
      claimed: new Set([issue.id]),
    };
    const refreshed: ReadonlyArray<MinimalIssue> = [
      { id: issue.id, identifier: issue.identifier, state: "in progress" },
    ];

    const result = reconcileTrackerStates(
      state,
      refreshed,
      lowercaseSet(config.tracker.terminal_states),
      lowercaseSet(config.tracker.active_states),
    );

    expect(findSideEffect(result.sideEffects, "UpdateIssueSnapshot")).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Determinism — both functions must return identical results for identical  */
/* inputs across repeated calls.                                              */
/* -------------------------------------------------------------------------- */

describe("determinism", () => {
  it("reconcileStalled is deterministic across repeated calls", () => {
    const config = makeConfig({ stall_timeout_ms: 5 * 60_000 });
    const issue = makeIssue();
    const startedAt = new Date("2024-01-01T00:00:00Z");
    const now = new Date("2024-01-01T00:06:00Z");
    const entry = makeRunningEntry({ started_at: startedAt });
    const state: OrchestratorRuntimeState = {
      ...initialState(config),
      running: new Map([[issue.id, entry]]),
      claimed: new Set([issue.id]),
    };

    const r1 = reconcileStalled(state, config, now);
    const r2 = reconcileStalled(state, config, now);
    expect(r1.events.length).toBe(r2.events.length);
    expect(r1.sideEffects.length).toBe(r2.sideEffects.length);
  });

  it("reconcileTrackerStates is deterministic across repeated calls", () => {
    const config = makeConfig();
    const issue = makeIssue();
    const entry = makeRunningEntry({});
    const state: OrchestratorRuntimeState = {
      ...initialState(config),
      running: new Map([[issue.id, entry]]),
      claimed: new Set([issue.id]),
    };
    const refreshed: ReadonlyArray<MinimalIssue> = [
      { id: issue.id, identifier: issue.identifier, state: "Done" },
    ];
    const terminal = lowercaseSet(config.tracker.terminal_states);
    const active = lowercaseSet(config.tracker.active_states);

    const r1 = reconcileTrackerStates(state, refreshed, terminal, active);
    const r2 = reconcileTrackerStates(state, refreshed, terminal, active);
    expect(r1.sideEffects.length).toBe(r2.sideEffects.length);
  });
});
