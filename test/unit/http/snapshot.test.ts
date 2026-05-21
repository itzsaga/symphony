// Unit tests for src/http/snapshot.ts: covers the `claude_* → codex_*` rename,
// ISO-8601 timestamp formatting, identifier lookup, and per-issue projection.
import { describe, expect, it } from "bun:test";
import type { Issue } from "../../../src/linear/schemas.ts";
import type {
  OrchestratorRuntimeState,
  RetryEntry,
  RunningEntry,
} from "../../../src/orchestrator/State.ts";
import {
  findByIdentifier,
  toApiIssue,
  toApiState,
} from "../../../src/http/snapshot.ts";

/* -------------------------------------------------------------------------- */
/* Builders.                                                                  */
/* -------------------------------------------------------------------------- */

const makeIssue = (overrides?: Partial<Issue>): Issue => ({
  id: "issue-id-1",
  identifier: "MT-649",
  title: "Test issue",
  description: null,
  priority: null,
  state: "In Progress",
  branch_name: null,
  url: null,
  labels: [],
  blocked_by: [],
  created_at: null,
  updated_at: null,
  ...overrides,
});

const makeRunningEntry = (overrides?: Partial<RunningEntry>): RunningEntry => ({
  issue: makeIssue(),
  workspace_path: "/tmp/symphony_workspaces/MT-649",
  started_at: new Date("2026-02-24T20:10:12.000Z"),
  attempt: null,
  retry_attempt: null,
  session_id: "session-uuid-1",
  thread_id: "session-uuid-1",
  last_event: "turn_completed",
  last_event_at: new Date("2026-02-24T20:14:59.000Z"),
  last_message: "",
  claude_input_tokens: 1200,
  claude_output_tokens: 800,
  claude_total_tokens: 2000,
  last_reported_input_tokens: 1200,
  last_reported_output_tokens: 800,
  last_reported_total_tokens: 2000,
  turn_count: 7,
  ...overrides,
});

const makeRetryEntry = (overrides?: Partial<RetryEntry>): RetryEntry => ({
  issue_id: "issue-id-2",
  identifier: "MT-650",
  attempt: 3,
  due_at_ms: Date.UTC(2026, 1, 24, 20, 16, 0),
  timer_handle: null,
  error: "no available orchestrator slots",
  ...overrides,
});

const makeState = (overrides?: {
  running?: ReadonlyArray<readonly [string, RunningEntry]>;
  retry?: ReadonlyArray<readonly [string, RetryEntry]>;
}): OrchestratorRuntimeState => {
  const running = new Map<string, RunningEntry>(overrides?.running ?? []);
  const retry_attempts = new Map<string, RetryEntry>(overrides?.retry ?? []);
  return {
    poll_interval_ms: 10_000,
    max_concurrent_agents: 4,
    running,
    claimed: new Set(running.keys()),
    retry_attempts,
    completed: new Set(),
    claude_totals: {
      input_tokens: 5000,
      output_tokens: 2400,
      total_tokens: 7400,
      seconds_running: 1834,
    },
    claude_rate_limits: null,
  };
};

/* -------------------------------------------------------------------------- */
/* toApiState.                                                                */
/* -------------------------------------------------------------------------- */

describe("toApiState", () => {
  it("renames claude_totals to codex_totals (the §13.7.1 boundary)", () => {
    const state = makeState({ running: [["issue-id-1", makeRunningEntry()]] });
    const generatedAt = new Date("2026-02-24T20:15:30.000Z");
    const api = toApiState(state, generatedAt);
    expect(api.codex_totals).toEqual({
      input_tokens: 5000,
      output_tokens: 2400,
      total_tokens: 7400,
      seconds_running: 1834,
    });
    // No `claude_totals` field should leak through.
    expect("claude_totals" in (api as object)).toBe(false);
  });

  it("formats generated_at and started_at as ISO-8601 strings", () => {
    const state = makeState({ running: [["issue-id-1", makeRunningEntry()]] });
    const generatedAt = new Date("2026-02-24T20:15:30.000Z");
    const api = toApiState(state, generatedAt);
    expect(api.generated_at).toBe("2026-02-24T20:15:30.000Z");
    expect(api.running[0]?.started_at).toBe("2026-02-24T20:10:12.000Z");
    expect(api.running[0]?.last_event_at).toBe("2026-02-24T20:14:59.000Z");
  });

  it("populates counts.running and counts.retrying from the maps", () => {
    const state = makeState({
      running: [
        ["issue-id-1", makeRunningEntry()],
        ["issue-id-3", makeRunningEntry({ issue: makeIssue({ id: "issue-id-3" }) })],
      ],
      retry: [["issue-id-2", makeRetryEntry()]],
    });
    const api = toApiState(state, new Date());
    expect(api.counts).toEqual({ running: 2, retrying: 1 });
    expect(api.running).toHaveLength(2);
    expect(api.retrying).toHaveLength(1);
  });

  it("includes spec-example running fields verbatim", () => {
    const state = makeState({ running: [["issue-id-1", makeRunningEntry()]] });
    const api = toApiState(state, new Date());
    const entry = api.running[0];
    expect(entry).toBeDefined();
    expect(entry?.issue_id).toBe("issue-id-1");
    expect(entry?.issue_identifier).toBe("MT-649");
    expect(entry?.state).toBe("In Progress");
    expect(entry?.session_id).toBe("session-uuid-1");
    expect(entry?.turn_count).toBe(7);
    expect(entry?.last_event).toBe("turn_completed");
    expect(entry?.tokens).toEqual({
      input_tokens: 1200,
      output_tokens: 800,
      total_tokens: 2000,
    });
  });

  it("includes spec-example retrying fields verbatim", () => {
    const state = makeState({
      retry: [["issue-id-2", makeRetryEntry()]],
    });
    const api = toApiState(state, new Date());
    const entry = api.retrying[0];
    expect(entry).toBeDefined();
    expect(entry?.issue_id).toBe("issue-id-2");
    expect(entry?.issue_identifier).toBe("MT-650");
    expect(entry?.attempt).toBe(3);
    expect(entry?.due_at).toBe("2026-02-24T20:16:00.000Z");
    expect(entry?.error).toBe("no available orchestrator slots");
  });

  it("surfaces null rate_limits when the orchestrator has not observed one", () => {
    const api = toApiState(makeState(), new Date());
    expect(api.rate_limits).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* findByIdentifier.                                                          */
/* -------------------------------------------------------------------------- */

describe("findByIdentifier", () => {
  const running = makeRunningEntry();
  const retry = makeRetryEntry();
  const state = makeState({
    running: [["issue-id-1", running]],
    retry: [["issue-id-2", retry]],
  });

  it("matches a running entry by identifier", () => {
    const found = findByIdentifier(state, "MT-649");
    expect(found.running).toBe(running);
    expect(found.retry).toBeNull();
  });

  it("matches a running entry by raw issue id", () => {
    const found = findByIdentifier(state, "issue-id-1");
    expect(found.running).toBe(running);
    expect(found.retry).toBeNull();
  });

  it("matches a retrying entry by identifier", () => {
    const found = findByIdentifier(state, "MT-650");
    expect(found.running).toBeNull();
    expect(found.retry).toBe(retry);
  });

  it("returns nulls for an unknown identifier", () => {
    const found = findByIdentifier(state, "MT-9999");
    expect(found.running).toBeNull();
    expect(found.retry).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* toApiIssue.                                                                */
/* -------------------------------------------------------------------------- */

describe("toApiIssue", () => {
  it("returns the running view with status=running when active", () => {
    const running = makeRunningEntry();
    const api = toApiIssue({
      issue_identifier: "MT-649",
      running,
      retry: null,
      recent_events: [],
    });
    expect(api.status).toBe("running");
    expect(api.workspace).toEqual({ path: "/tmp/symphony_workspaces/MT-649" });
    expect(api.running).not.toBeNull();
    expect(api.running?.session_id).toBe("session-uuid-1");
    expect(api.running?.tokens.total_tokens).toBe(2000);
    expect(api.retry).toBeNull();
  });

  it("returns the retry view with status=retrying when only retrying", () => {
    const retry = makeRetryEntry();
    const api = toApiIssue({
      issue_identifier: "MT-650",
      running: null,
      retry,
      recent_events: [],
    });
    expect(api.status).toBe("retrying");
    expect(api.workspace).toBeNull();
    expect(api.running).toBeNull();
    expect(api.retry).not.toBeNull();
    expect(api.retry?.attempt).toBe(3);
    expect(api.retry?.due_at).toBe("2026-02-24T20:16:00.000Z");
    expect(api.last_error).toBe("no available orchestrator slots");
  });

  it("always includes the empty codex_session_logs and tracked placeholders", () => {
    const api = toApiIssue({
      issue_identifier: "MT-649",
      running: makeRunningEntry(),
      retry: null,
      recent_events: [],
    });
    expect(api.logs).toEqual({ codex_session_logs: [] });
    expect(api.tracked).toEqual({});
  });

  it("respects the recent_events cap supplied by the caller", () => {
    const events = Array.from({ length: 10 }, (_, i) => ({
      at: `2026-02-24T20:15:${String(i).padStart(2, "0")}.000Z`,
      event: "notification",
      message: `event ${i}`,
    }));
    const api = toApiIssue({
      issue_identifier: "MT-649",
      running: makeRunningEntry(),
      retry: null,
      recent_events: events,
    });
    expect(api.recent_events).toEqual(events);
  });
});
