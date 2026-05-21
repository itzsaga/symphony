// Unit tests for src/orchestrator/Dispatch.ts — pure §8.2/§8.3 planner.
// Exercises every SkipReason variant + the spec-mandated stable sort order.
import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import {
  TopLevelSchema,
  type TypedConfig,
} from "../../../src/config/WorkflowSchema.ts";
import type { BlockerRef, Issue } from "../../../src/linear/schemas.ts";
import {
  DEFAULT_MAX_CONCURRENT_AGENTS,
  initialState,
  newRunningEntry,
  type OrchestratorRuntimeState,
  type RunningEntry,
} from "../../../src/orchestrator/State.ts";
import {
  selectDispatchBatch,
  sortForDispatch,
} from "../../../src/orchestrator/Dispatch.ts";

/* -------------------------------------------------------------------------- */
/* Fixtures.                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build a default TypedConfig. Tests that need per-state caps or an explicit
 * global cap attach those fields via a localized cast — the v1 schema does
 * not (yet) model them on `agent_runner`, but the dispatcher reads them
 * structurally so the test can exercise the same code path.
 */
const makeConfig = (
  patch: {
    active_states?: ReadonlyArray<string>;
    terminal_states?: ReadonlyArray<string>;
    max_concurrent_agents?: number;
    max_concurrent_agents_by_state?: Record<string, number>;
  } = {},
): TypedConfig => {
  const decoded = Schema.decodeUnknownSync(TopLevelSchema)({});
  const agent_runner: TypedConfig["agent_runner"] = {
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
    max_concurrent_agents:
      patch.max_concurrent_agents ??
      decoded.agent_runner.max_concurrent_agents,
    max_concurrent_agents_by_state:
      patch.max_concurrent_agents_by_state ??
      decoded.agent_runner.max_concurrent_agents_by_state,
    max_retry_backoff_ms: decoded.agent_runner.max_retry_backoff_ms,
  };
  return {
    tracker: {
      kind: decoded.tracker.kind,
      endpoint: decoded.tracker.endpoint,
      api_key: decoded.tracker.api_key ?? null,
      project_slug: decoded.tracker.project_slug ?? null,
      active_states: patch.active_states ?? decoded.tracker.active_states,
      terminal_states:
        patch.terminal_states ?? decoded.tracker.terminal_states,
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
    agent_runner,
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

const blocker = (overrides: Partial<BlockerRef> = {}): BlockerRef => ({
  id: "blk-1",
  identifier: "MT-99",
  state: "Todo",
  ...overrides,
});

const makeRunningEntry = (
  issue: Issue,
  overrides: Partial<RunningEntry> = {},
): RunningEntry => {
  const base = newRunningEntry({
    issue,
    workspace_path: `/tmp/symphony-ws/${issue.identifier}`,
    started_at: new Date("2024-01-01T00:00:00Z"),
    attempt: null,
    retry_attempt: null,
  });
  return { ...base, ...overrides };
};

const stateWithRunning = (
  config: TypedConfig,
  running: ReadonlyArray<RunningEntry>,
): OrchestratorRuntimeState => {
  const base = initialState(config);
  return {
    ...base,
    running: new Map(running.map((e) => [e.issue.id, e])),
    claimed: new Set(running.map((e) => e.issue.id)),
  };
};

/* -------------------------------------------------------------------------- */
/* sortForDispatch.                                                           */
/* -------------------------------------------------------------------------- */

describe("sortForDispatch", () => {
  it("orders priority 1 ahead of priority 4", () => {
    const lo = makeIssue({ id: "a", identifier: "MT-A", priority: 1 });
    const hi = makeIssue({ id: "b", identifier: "MT-B", priority: 4 });
    expect(sortForDispatch([hi, lo]).map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("treats null priority as last", () => {
    const a = makeIssue({ id: "a", identifier: "MT-A", priority: 3 });
    const b = makeIssue({ id: "b", identifier: "MT-B", priority: null });
    expect(sortForDispatch([b, a]).map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("breaks priority ties by oldest created_at first", () => {
    const newer = makeIssue({
      id: "n",
      identifier: "MT-N",
      priority: 2,
      created_at: "2024-02-01T00:00:00Z",
    });
    const older = makeIssue({
      id: "o",
      identifier: "MT-O",
      priority: 2,
      created_at: "2024-01-01T00:00:00Z",
    });
    expect(sortForDispatch([newer, older]).map((i) => i.id)).toEqual([
      "o",
      "n",
    ]);
  });

  it("breaks priority + null created_at ties by identifier lexicographically", () => {
    const z = makeIssue({
      id: "z",
      identifier: "MT-Z",
      priority: 2,
      created_at: null,
    });
    const a = makeIssue({
      id: "a",
      identifier: "MT-A",
      priority: 2,
      created_at: null,
    });
    expect(sortForDispatch([z, a]).map((i) => i.id)).toEqual(["a", "z"]);
  });

  it("does not mutate the input array", () => {
    const issues = [
      makeIssue({ id: "b", identifier: "MT-B", priority: 4 }),
      makeIssue({ id: "a", identifier: "MT-A", priority: 1 }),
    ];
    const snapshot = issues.map((i) => i.id);
    sortForDispatch(issues);
    expect(issues.map((i) => i.id)).toEqual(snapshot);
  });

  it("is deterministic under the same input", () => {
    const issues = [
      makeIssue({
        id: "a",
        identifier: "MT-A",
        priority: 2,
        created_at: "2024-01-01T00:00:00Z",
      }),
      makeIssue({
        id: "b",
        identifier: "MT-B",
        priority: 2,
        created_at: "2024-01-01T00:00:00Z",
      }),
      makeIssue({
        id: "c",
        identifier: "MT-C",
        priority: 1,
        created_at: "2024-03-01T00:00:00Z",
      }),
    ];
    const a = sortForDispatch(issues).map((i) => i.id);
    const b = sortForDispatch(issues).map((i) => i.id);
    expect(a).toEqual(b);
    expect(a).toEqual(["c", "a", "b"]);
  });
});

/* -------------------------------------------------------------------------- */
/* selectDispatchBatch — eligibility.                                         */
/* -------------------------------------------------------------------------- */

describe("selectDispatchBatch — eligibility", () => {
  it("dispatches an eligible Todo issue with no blockers", () => {
    const config = makeConfig();
    const state = initialState(config);
    const issue = makeIssue();
    const plan = selectDispatchBatch([issue], state, config);
    expect(plan.toDispatch.map((i) => i.id)).toEqual([issue.id]);
    expect(plan.reasons_skipped.size).toBe(0);
  });

  it("skips an issue whose state is not in active_states with StateNotActive", () => {
    const config = makeConfig({ active_states: ["In Progress"] });
    const state = initialState(config);
    const issue = makeIssue({ state: "Todo" });
    const plan = selectDispatchBatch([issue], state, config);
    expect(plan.toDispatch).toEqual([]);
    expect(plan.reasons_skipped.get(issue.id)?._tag).toBe("StateNotActive");
  });

  it("skips an issue whose state is terminal even if also in active_states", () => {
    const config = makeConfig({
      active_states: ["Todo", "Done"],
      terminal_states: ["Done"],
    });
    const state = initialState(config);
    const issue = makeIssue({ id: "x", identifier: "MT-X", state: "Done" });
    const plan = selectDispatchBatch([issue], state, config);
    expect(plan.toDispatch).toEqual([]);
    expect(plan.reasons_skipped.get(issue.id)?._tag).toBe("StateNotActive");
  });

  it("skips an issue that is already running with AlreadyRunning", () => {
    const config = makeConfig();
    const issue = makeIssue();
    const state = stateWithRunning(config, [makeRunningEntry(issue)]);
    const plan = selectDispatchBatch([issue], state, config);
    expect(plan.toDispatch).toEqual([]);
    const reason = plan.reasons_skipped.get(issue.id);
    expect(reason?._tag).toBe("AlreadyRunning");
  });

  it("skips an issue that is in claimed but not running with AlreadyClaimed", () => {
    const config = makeConfig();
    const issue = makeIssue();
    const base = initialState(config);
    const state: OrchestratorRuntimeState = {
      ...base,
      claimed: new Set([issue.id]),
    };
    const plan = selectDispatchBatch([issue], state, config);
    expect(plan.toDispatch).toEqual([]);
    expect(plan.reasons_skipped.get(issue.id)?._tag).toBe("AlreadyClaimed");
  });

  it("skips a Todo with a non-terminal blocker with TodoBlocked", () => {
    const config = makeConfig();
    const state = initialState(config);
    const issue = makeIssue({
      blocked_by: [blocker({ state: "In Progress" })],
    });
    const plan = selectDispatchBatch([issue], state, config);
    expect(plan.toDispatch).toEqual([]);
    expect(plan.reasons_skipped.get(issue.id)?._tag).toBe("TodoBlocked");
  });

  it("dispatches a Todo with all-terminal blockers (regression)", () => {
    const config = makeConfig();
    const state = initialState(config);
    const issue = makeIssue({
      blocked_by: [
        blocker({ state: "Done" }),
        blocker({ state: "Cancelled" }),
      ],
    });
    const plan = selectDispatchBatch([issue], state, config);
    expect(plan.toDispatch.map((i) => i.id)).toEqual([issue.id]);
    expect(plan.reasons_skipped.size).toBe(0);
  });

  it("treats blockers with unknown state as non-terminal (conservative)", () => {
    const config = makeConfig();
    const state = initialState(config);
    const issue = makeIssue({
      blocked_by: [blocker({ state: null })],
    });
    const plan = selectDispatchBatch([issue], state, config);
    expect(plan.toDispatch).toEqual([]);
    expect(plan.reasons_skipped.get(issue.id)?._tag).toBe("TodoBlocked");
  });

  it("does not apply the blocker rule to non-Todo states", () => {
    const config = makeConfig();
    const state = initialState(config);
    const issue = makeIssue({
      state: "In Progress",
      blocked_by: [blocker({ state: "In Progress" })],
    });
    const plan = selectDispatchBatch([issue], state, config);
    expect(plan.toDispatch.map((i) => i.id)).toEqual([issue.id]);
  });

  it("skips an issue missing required fields with StateNotActive", () => {
    const config = makeConfig();
    const state = initialState(config);
    const broken = makeIssue({ id: "bad", identifier: "", state: "Todo" });
    const plan = selectDispatchBatch([broken], state, config);
    expect(plan.toDispatch).toEqual([]);
    expect(plan.reasons_skipped.get(broken.id)?._tag).toBe("StateNotActive");
  });
});

/* -------------------------------------------------------------------------- */
/* selectDispatchBatch — concurrency.                                         */
/* -------------------------------------------------------------------------- */

describe("selectDispatchBatch — concurrency", () => {
  it("respects the default global cap of DEFAULT_MAX_CONCURRENT_AGENTS", () => {
    expect(DEFAULT_MAX_CONCURRENT_AGENTS).toBeGreaterThanOrEqual(2);
    const config = makeConfig();
    const state = initialState(config);
    const issues = Array.from({ length: DEFAULT_MAX_CONCURRENT_AGENTS + 1 }, (_, i) =>
      makeIssue({
        id: `i-${i}`,
        identifier: `MT-${i.toString().padStart(3, "0")}`,
        priority: 2,
        created_at: `2024-01-${(i + 1).toString().padStart(2, "0")}T00:00:00Z`,
      }),
    );
    const plan = selectDispatchBatch(issues, state, config);
    expect(plan.toDispatch.length).toBe(DEFAULT_MAX_CONCURRENT_AGENTS);
    expect(plan.reasons_skipped.size).toBe(1);
    const skipped = [...plan.reasons_skipped.values()][0];
    expect(skipped?._tag).toBe("NoGlobalSlot");
  });

  it("dispatches only two when the configured global cap is 2 (rest NoGlobalSlot)", () => {
    const config = makeConfig({ max_concurrent_agents: 2 });
    const state = initialState(config);
    const issues = Array.from({ length: 5 }, (_, i) =>
      makeIssue({
        id: `i-${i}`,
        identifier: `MT-${i.toString().padStart(3, "0")}`,
        priority: 2,
        created_at: `2024-01-${(i + 1).toString().padStart(2, "0")}T00:00:00Z`,
      }),
    );
    const plan = selectDispatchBatch(issues, state, config);
    expect(plan.toDispatch.length).toBe(2);
    expect(plan.toDispatch.map((i) => i.identifier)).toEqual([
      "MT-000",
      "MT-001",
    ]);
    expect(plan.reasons_skipped.size).toBe(3);
    for (const reason of plan.reasons_skipped.values()) {
      expect(reason._tag).toBe("NoGlobalSlot");
    }
  });

  it("counts already-running issues against the global cap", () => {
    const config = makeConfig({ max_concurrent_agents: 2 });
    const existing = makeRunningEntry(
      makeIssue({ id: "running-1", identifier: "MT-EX1" }),
    );
    const state = stateWithRunning(config, [existing]);
    const candidates = Array.from({ length: 3 }, (_, i) =>
      makeIssue({
        id: `c-${i}`,
        identifier: `MT-C${i}`,
        priority: 2,
        created_at: `2024-02-${(i + 1).toString().padStart(2, "0")}T00:00:00Z`,
      }),
    );
    const plan = selectDispatchBatch(candidates, state, config);
    // One slot free → exactly one dispatched.
    expect(plan.toDispatch.length).toBe(1);
    expect(plan.reasons_skipped.size).toBe(2);
  });

  it("enforces per-state cap of 1: only first same-state issue dispatches", () => {
    const config = makeConfig({
      max_concurrent_agents: 10,
      max_concurrent_agents_by_state: { todo: 1 },
    });
    const state = initialState(config);
    const a = makeIssue({
      id: "a",
      identifier: "MT-A",
      state: "Todo",
      priority: 2,
      created_at: "2024-01-01T00:00:00Z",
    });
    const b = makeIssue({
      id: "b",
      identifier: "MT-B",
      state: "Todo",
      priority: 2,
      created_at: "2024-01-02T00:00:00Z",
    });
    const plan = selectDispatchBatch([a, b], state, config);
    expect(plan.toDispatch.map((i) => i.id)).toEqual(["a"]);
    expect(plan.reasons_skipped.get("b")?._tag).toBe("NoPerStateSlot");
  });

  it("per-state cap lookup is case-insensitive on both sides", () => {
    // Active states declared as "In Progress"; config key cased differently;
    // issue state also cased differently. All should normalize to the same
    // bucket per §4.2 / §8.3.
    const config = makeConfig({
      active_states: ["In Progress"],
      max_concurrent_agents: 10,
      max_concurrent_agents_by_state: { "IN progress": 1 },
    });
    const state = initialState(config);
    const a = makeIssue({
      id: "a",
      identifier: "MT-A",
      state: "in PROGRESS",
      priority: 2,
      created_at: "2024-01-01T00:00:00Z",
    });
    const b = makeIssue({
      id: "b",
      identifier: "MT-B",
      state: "In Progress",
      priority: 2,
      created_at: "2024-01-02T00:00:00Z",
    });
    const plan = selectDispatchBatch([a, b], state, config);
    expect(plan.toDispatch.map((i) => i.id)).toEqual(["a"]);
    expect(plan.reasons_skipped.get("b")?._tag).toBe("NoPerStateSlot");
  });

  it("per-state cap counts in-flight running issues toward the cap", () => {
    const config = makeConfig({
      max_concurrent_agents: 10,
      max_concurrent_agents_by_state: { "in progress": 1 },
    });
    const existing = makeRunningEntry(
      makeIssue({
        id: "running-1",
        identifier: "MT-EX1",
        state: "In Progress",
      }),
    );
    const state = stateWithRunning(config, [existing]);
    const incoming = makeIssue({
      id: "i",
      identifier: "MT-I",
      state: "In Progress",
    });
    const plan = selectDispatchBatch([incoming], state, config);
    expect(plan.toDispatch).toEqual([]);
    expect(plan.reasons_skipped.get("i")?._tag).toBe("NoPerStateSlot");
  });

  it("absence of an explicit per-state cap falls back to the global cap only", () => {
    // Two Todo issues, global cap of 10, no per-state entry — both go.
    const config = makeConfig({ max_concurrent_agents: 10 });
    const state = initialState(config);
    const a = makeIssue({ id: "a", identifier: "MT-A", priority: 2 });
    const b = makeIssue({ id: "b", identifier: "MT-B", priority: 2 });
    const plan = selectDispatchBatch([a, b], state, config);
    expect(plan.toDispatch.length).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* selectDispatchBatch — determinism + ordering.                              */
/* -------------------------------------------------------------------------- */

describe("selectDispatchBatch — determinism", () => {
  it("produces identical output for repeated calls with the same input", () => {
    const config = makeConfig({ max_concurrent_agents: 2 });
    const state = initialState(config);
    const issues = [
      makeIssue({
        id: "a",
        identifier: "MT-A",
        priority: 3,
        created_at: "2024-01-02T00:00:00Z",
      }),
      makeIssue({
        id: "b",
        identifier: "MT-B",
        priority: 1,
        created_at: "2024-02-01T00:00:00Z",
      }),
      makeIssue({
        id: "c",
        identifier: "MT-C",
        priority: 3,
        created_at: "2024-01-01T00:00:00Z",
      }),
    ];
    const r1 = selectDispatchBatch(issues, state, config);
    const r2 = selectDispatchBatch(issues, state, config);
    expect(r1.toDispatch.map((i) => i.id)).toEqual(
      r2.toDispatch.map((i) => i.id),
    );
    expect([...r1.reasons_skipped.keys()]).toEqual([
      ...r2.reasons_skipped.keys(),
    ]);
  });

  it("dispatches in sorted order (priority then created_at then identifier)", () => {
    const config = makeConfig({ max_concurrent_agents: 3 });
    const state = initialState(config);
    const issues = [
      makeIssue({
        id: "newer",
        identifier: "MT-NEW",
        priority: 2,
        created_at: "2024-03-01T00:00:00Z",
      }),
      makeIssue({
        id: "top",
        identifier: "MT-TOP",
        priority: 1,
        created_at: "2024-04-01T00:00:00Z",
      }),
      makeIssue({
        id: "older",
        identifier: "MT-OLD",
        priority: 2,
        created_at: "2024-01-01T00:00:00Z",
      }),
    ];
    const plan = selectDispatchBatch(issues, state, config);
    expect(plan.toDispatch.map((i) => i.id)).toEqual([
      "top",
      "older",
      "newer",
    ]);
  });
});
