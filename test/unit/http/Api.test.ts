// Integration-style tests for src/http/Api.ts: routes are mounted on a real
// ephemeral Bun listener and exercised via `fetch`, with stub Orchestrator + Logger.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer, Queue, Ref, Scope, Stream } from "effect";
import { CliFlagsTest, ServerLive } from "../../../src/http/Server.ts";
import { RoutesLive } from "../../../src/http/Api.ts";
import { layer as workflowLayer } from "../../../src/config/WorkflowLoader.ts";
import {
  Logger,
  type LogRecord,
  type LogSink,
  layer as loggerLayer,
} from "../../../src/observability/Logger.ts";
import {
  Orchestrator,
  type OrchestratorService,
} from "../../../src/orchestrator/Orchestrator.ts";
import type { OrchestratorEvent } from "../../../src/orchestrator/events.ts";
import type {
  OrchestratorRuntimeState,
  RetryEntry,
  RunningEntry,
} from "../../../src/orchestrator/State.ts";
import type { Issue } from "../../../src/linear/schemas.ts";

/* -------------------------------------------------------------------------- */
/* Fixtures.                                                                  */
/* -------------------------------------------------------------------------- */

const workflowBody = (serverPort: number | null): string => {
  const serverBlock =
    serverPort === null ? "" : `server:\n  port: ${serverPort}\n`;
  return `---
tracker:
  kind: linear
  api_key: tok-abc
  project_slug: my-project
${serverBlock}---
prompt body
`;
};

const makeIssue = (overrides?: Partial<Issue>): Issue => ({
  id: "issue-id-1",
  identifier: "MT-649",
  title: "Test",
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
      input_tokens: 5_000,
      output_tokens: 2_400,
      total_tokens: 7_400,
      seconds_running: 1834,
    },
    claude_rate_limits: null,
  };
};

/** Build an Orchestrator service Layer backed by a single-state ref. */
const orchestratorStub = (
  state: OrchestratorRuntimeState,
  events?: Queue.Queue<OrchestratorEvent>,
): Layer.Layer<Orchestrator> =>
  Layer.effect(
    Orchestrator,
    Effect.gen(function* () {
      const stateRef = yield* Ref.make(state);
      const eventsQueue =
        events ?? (yield* Queue.unbounded<OrchestratorEvent>());
      const service: OrchestratorService = {
        state: Ref.get(stateRef),
        stateChanges: Stream.fromEffect(Ref.get(stateRef)),
        enqueue: (event) => Queue.offer(eventsQueue, event).pipe(Effect.asVoid),
      };
      return service;
    }),
  );

/** Capture sink. */
const captureSink = (): {
  sink: LogSink;
  records: ReadonlyArray<LogRecord>;
} => {
  const records: Array<LogRecord> = [];
  return {
    sink: {
      write: (line) => {
        records.push(JSON.parse(line) as LogRecord);
      },
    },
    get records() {
      return records;
    },
  };
};

/* -------------------------------------------------------------------------- */
/* Server bring-up helper.                                                    */
/*                                                                            */
/* Builds the full Server + RoutesLive Layer graph and returns the bound      */
/* port plus a Scope that the caller must close. Tests use a single helper    */
/* to keep beforeEach/afterEach hooks readable.                               */
/* -------------------------------------------------------------------------- */

interface RunningServer {
  readonly port: number;
  readonly scope: Scope.CloseableScope;
  readonly logs: ReadonlyArray<LogRecord>;
  readonly events: Queue.Queue<OrchestratorEvent>;
}

const startServer = async (
  workflowPath: string,
  state: OrchestratorRuntimeState,
): Promise<RunningServer> => {
  writeFileSync(workflowPath, workflowBody(0));
  const captured = captureSink();
  const eventsQueue = await Effect.runPromise(
    Queue.unbounded<OrchestratorEvent>(),
  );
  const scope = await Effect.runPromise(Scope.make());
  const baseLayer = Layer.provideMerge(
    workflowLayer({ path: workflowPath }),
    loggerLayer({ sink: captured.sink }),
  );
  const orchLayer = orchestratorStub(state, eventsQueue);
  // RoutesLive and ServerLive must be peer-merged (not provideMerge'd) so
  // they share the SymphonyHttpRouter.Live instance via the outer memoMap.
  // Under provideMerge the route handlers register into a different
  // in-memory router than the one the served Layer snapshots from, and
  // every request 404s. Orchestrator+Logger are provided to RoutesLive as
  // dependencies (via Layer.provide) while ServerLive sits alongside.
  const routesWithDeps = Layer.provide(
    RoutesLive,
    Layer.merge(orchLayer, loggerLayer({ sink: captured.sink })),
  );
  const stack = Layer.mergeAll(ServerLive, routesWithDeps);
  const wired = Layer.provide(
    stack,
    Layer.merge(CliFlagsTest(0), baseLayer),
  );
  await Effect.runPromise(Layer.buildWithScope(wired, scope));
  // Read the bound port from the first "http server listening" log.
  const listening = captured.records.find(
    (r) => r["msg"] === "http server listening",
  );
  if (listening === undefined) {
    throw new Error(
      `expected listening log; got: ${JSON.stringify(captured.records)}`,
    );
  }
  const port = listening["port"];
  if (typeof port !== "number") {
    throw new Error("listening log missing port");
  }
  return {
    port,
    scope,
    get logs() {
      return captured.records;
    },
    events: eventsQueue,
  };
};

const closeServer = async (server: RunningServer): Promise<void> => {
  await Effect.runPromise(Scope.close(server.scope, Exit.succeed<void>(undefined)));
};

/* -------------------------------------------------------------------------- */
/* Tests.                                                                     */
/* -------------------------------------------------------------------------- */

describe("HTTP API + dashboard", () => {
  let tempDir: string;
  let workflowPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "symphony-api-test-"));
    workflowPath = join(tempDir, "WORKFLOW.md");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("GET /api/v1/state returns the spec-example fields with codex_totals", async () => {
    const state = makeState({
      running: [["issue-id-1", makeRunningEntry()]],
      retry: [["issue-id-2", makeRetryEntry()]],
    });
    const server = await startServer(workflowPath, state);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/state`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as Record<string, unknown>;
      expect(body["counts"]).toEqual({ running: 1, retrying: 1 });
      expect(body["codex_totals"]).toEqual({
        input_tokens: 5_000,
        output_tokens: 2_400,
        total_tokens: 7_400,
        seconds_running: 1834,
      });
      expect("claude_totals" in body).toBe(false);
      expect(Array.isArray(body["running"])).toBe(true);
      expect(Array.isArray(body["retrying"])).toBe(true);
      const running = body["running"] as ReadonlyArray<Record<string, unknown>>;
      expect(running[0]?.["issue_identifier"]).toBe("MT-649");
    } finally {
      await closeServer(server);
    }
  });

  it("GET /api/v1/<known-identifier> returns 200 with the running view", async () => {
    const state = makeState({
      running: [["issue-id-1", makeRunningEntry()]],
    });
    const server = await startServer(workflowPath, state);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/MT-649`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body["status"]).toBe("running");
      expect(body["issue_identifier"]).toBe("MT-649");
      expect(body["issue_id"]).toBe("issue-id-1");
      expect((body["workspace"] as Record<string, unknown>)?.["path"]).toBe(
        "/tmp/symphony_workspaces/MT-649",
      );
      expect(body["running"]).not.toBeNull();
      expect((body["logs"] as Record<string, unknown>)?.["codex_session_logs"]).toEqual([]);
      expect(body["tracked"]).toEqual({});
    } finally {
      await closeServer(server);
    }
  });

  it("GET /api/v1/<retrying-identifier> omits the running field", async () => {
    const state = makeState({
      retry: [["issue-id-2", makeRetryEntry()]],
    });
    const server = await startServer(workflowPath, state);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/MT-650`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body["status"]).toBe("retrying");
      expect(body["running"]).toBeNull();
      expect(body["retry"]).not.toBeNull();
      expect((body["retry"] as Record<string, unknown>)?.["attempt"]).toBe(3);
      expect(body["last_error"]).toBe("no available orchestrator slots");
    } finally {
      await closeServer(server);
    }
  });

  it("GET /api/v1/<unknown> returns 404 with the issue_not_found envelope", async () => {
    const server = await startServer(workflowPath, makeState());
    try {
      const res = await fetch(
        `http://127.0.0.1:${server.port}/api/v1/MT-9999`,
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      const err = body["error"] as Record<string, unknown>;
      expect(err["code"]).toBe("issue_not_found");
      expect(typeof err["message"]).toBe("string");
    } finally {
      await closeServer(server);
    }
  });

  it("POST /api/v1/refresh enqueues ImmediateTickRequested and returns 202", async () => {
    const server = await startServer(workflowPath, makeState());
    try {
      const res = await fetch(
        `http://127.0.0.1:${server.port}/api/v1/refresh`,
        { method: "POST" },
      );
      expect(res.status).toBe(202);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body["queued"]).toBe(true);
      expect(body["coalesced"]).toBe(false);
      expect(body["operations"]).toEqual(["poll", "reconcile"]);
      expect(typeof body["requested_at"]).toBe("string");
      // The orchestrator stub queue should have received the event.
      const peeked = await Effect.runPromise(Queue.poll(server.events));
      expect(peeked._tag).toBe("Some");
      if (peeked._tag === "Some") {
        expect(peeked.value._tag).toBe("ImmediateTickRequested");
      }
    } finally {
      await closeServer(server);
    }
  });

  it("POST /api/v1/refresh coalesces a second request inside the 1s window", async () => {
    const server = await startServer(workflowPath, makeState());
    try {
      const first = await fetch(
        `http://127.0.0.1:${server.port}/api/v1/refresh`,
        { method: "POST" },
      );
      const firstBody = (await first.json()) as Record<string, unknown>;
      expect(firstBody["coalesced"]).toBe(false);
      const second = await fetch(
        `http://127.0.0.1:${server.port}/api/v1/refresh`,
        { method: "POST" },
      );
      expect(second.status).toBe(202);
      const secondBody = (await second.json()) as Record<string, unknown>;
      expect(secondBody["queued"]).toBe(false);
      expect(secondBody["coalesced"]).toBe(true);
      // Only the first request should have enqueued an event.
      const peekedA = await Effect.runPromise(Queue.poll(server.events));
      const peekedB = await Effect.runPromise(Queue.poll(server.events));
      expect(peekedA._tag).toBe("Some");
      expect(peekedB._tag).toBe("None");
    } finally {
      await closeServer(server);
    }
  });

  it("PATCH /api/v1/refresh returns 405 with Allow: POST", async () => {
    const server = await startServer(workflowPath, makeState());
    try {
      const res = await fetch(
        `http://127.0.0.1:${server.port}/api/v1/refresh`,
        { method: "PATCH" },
      );
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      const body = (await res.json()) as Record<string, unknown>;
      expect((body["error"] as Record<string, unknown>)?.["code"]).toBe(
        "method_not_allowed",
      );
    } finally {
      await closeServer(server);
    }
  });

  it("POST /api/v1/state returns 405 with Allow: GET", async () => {
    const server = await startServer(workflowPath, makeState());
    try {
      const res = await fetch(
        `http://127.0.0.1:${server.port}/api/v1/state`,
        { method: "POST" },
      );
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
    } finally {
      await closeServer(server);
    }
  });

  it("GET / returns HTML with the running-table when a session is active", async () => {
    const state = makeState({
      running: [["issue-id-1", makeRunningEntry()]],
    });
    const server = await startServer(workflowPath, state);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("<!doctype html>");
      expect(body).toContain(`<meta http-equiv="refresh" content="5">`);
      expect(body).toContain("MT-649");
      expect(body).toContain("turn_completed");
    } finally {
      await closeServer(server);
    }
  });

  it("GET / escapes XSS payloads in issue titles", async () => {
    const issue = makeIssue({
      identifier: "<script>alert('xss')</script>",
    });
    const state = makeState({
      running: [["issue-id-1", makeRunningEntry({ issue })]],
    });
    const server = await startServer(workflowPath, state);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      const body = await res.text();
      expect(body).not.toContain("<script>alert('xss')</script>");
      expect(body).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
    } finally {
      await closeServer(server);
    }
  });
});
