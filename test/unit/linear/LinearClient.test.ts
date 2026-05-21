// Service-level tests for the LinearClient: error categories, pagination,
// empty-input shortcut, executeRaw passthrough, and Live Layer wiring.
import { describe, expect, it } from "bun:test";
import {
  HttpClient,
  HttpClientResponse,
} from "@effect/platform";
import * as HttpClientError from "@effect/platform/HttpClientError";
import { Cause, Duration, Effect, Exit, Layer, Option, Ref, Schedule } from "effect";
import {
  LinearClient,
  LinearClientLive,
  make,
} from "../../../src/linear/LinearClient.ts";

/**
 * Near-zero retry schedule used by every test that exercises a retry path.
 * Tests still verify that retries happen (script length / request count) but
 * we don't want to actually sleep for the production exponential cap.
 */
const TEST_RETRY_SCHEDULE = Schedule.spaced(Duration.millis(1)).pipe(
  Schedule.compose(Schedule.recurs(4)),
);
import type {
  Issue,
  LinearClientError,
} from "../../../src/linear/schemas.ts";
import { WorkflowLoader } from "../../../src/config/WorkflowLoader.ts";
import type {
  TypedConfig,
  WorkflowDefinition,
} from "../../../src/config/WorkflowSchema.ts";

/* -------------------------------------------------------------------------- */
/* Fake HttpClient utilities                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A scripted HttpClient that hands back a queue of canned responses (or
 * `Effect.fail` instances) in order, recording every request it observed.
 *
 * Each entry in `script` is consumed by exactly one `execute` call; if more
 * calls arrive than there are scripts, the test fails fast — both because
 * that's a programming bug and because it produces the cleanest assertion
 * surface.
 */
interface ScriptedClient {
  readonly client: HttpClient.HttpClient;
  readonly requests: ReadonlyArray<{ url: string; body: unknown }>;
  readonly remaining: () => number;
}

const scriptedClient = (
  script: ReadonlyArray<
    | { kind: "ok"; status: number; json: unknown }
    | { kind: "transport"; message: string }
  >,
): ScriptedClient => {
  const requests: Array<{ url: string; body: unknown }> = [];
  let cursor = 0;
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      // Pull the JSON body that bodyJson produced. The encoded body is a
      // Uint8Array variant of HttpBody; decode it back to the structured value
      // for assertions in the per-test body inspection.
      const body = request.body;
      let bodyJson: unknown = null;
      if (body._tag === "Uint8Array") {
        const text = new TextDecoder().decode(body.body);
        try {
          bodyJson = text.length > 0 ? JSON.parse(text) : null;
        } catch {
          bodyJson = text;
        }
      }
      requests.push({ url: request.url, body: bodyJson });
      const entry = script[cursor];
      cursor += 1;
      if (entry === undefined) {
        return yield* Effect.fail(
          new HttpClientError.RequestError({
            request,
            reason: "Transport",
            description: `unexpected extra request at index ${cursor - 1}`,
          }),
        );
      }
      if (entry.kind === "transport") {
        return yield* Effect.fail(
          new HttpClientError.RequestError({
            request,
            reason: "Transport",
            description: entry.message,
          }),
        );
      }
      const webResponse = new Response(JSON.stringify(entry.json), {
        status: entry.status,
        headers: { "Content-Type": "application/json" },
      });
      return HttpClientResponse.fromWeb(request, webResponse);
    }),
  );
  return {
    client,
    get requests() {
      return requests;
    },
    remaining: () => script.length - cursor,
  };
};

/* -------------------------------------------------------------------------- */
/* Issue payload fixtures                                                     */
/* -------------------------------------------------------------------------- */

const ENDPOINT = "https://api.linear.app/graphql";
const API_KEY = "lin_test_key";
const PROJECT_SLUG = "my-project";

/** Build a raw-issue node literal that round-trips through the schema. */
const rawNode = (id: string): unknown => ({
  id,
  identifier: `ABC-${id}`,
  title: `Title ${id}`,
  description: null,
  priority: 2,
  state: { name: "Todo" },
  branchName: null,
  url: null,
  labels: { nodes: [] },
  inverseRelations: { nodes: [] },
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-02T00:00:00.000Z",
});

const okPage = (
  ids: ReadonlyArray<string>,
  next?: { after: string },
): unknown => ({
  data: {
    issues: {
      nodes: ids.map(rawNode),
      pageInfo: {
        endCursor: next?.after ?? null,
        hasNextPage: next !== undefined,
      },
    },
  },
});

const runErr = async <E>(
  effect: Effect.Effect<unknown, E>,
): Promise<E> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    throw new Error("expected failure, got success");
  }
  const failure = Cause.failureOption(exit.cause);
  if (Option.isNone(failure)) {
    throw new Error(
      `expected typed failure, got defect/interrupt: ${Cause.pretty(exit.cause)}`,
    );
  }
  return failure.value;
};

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("LinearClient.fetchCandidateIssues", () => {
  it("walks pages and preserves Linear's ordering across them", async () => {
    const sc = scriptedClient([
      { kind: "ok", status: 200, json: okPage(["1", "2"], { after: "cur1" }) },
      { kind: "ok", status: 200, json: okPage(["3", "4"]) },
    ]);
    const svc = make(
      ENDPOINT,
      API_KEY,
      sc.client,
      PROJECT_SLUG,
      ["Todo"],
      TEST_RETRY_SCHEDULE,
    );
    const issues = await Effect.runPromise(svc.fetchCandidateIssues);
    expect(issues.map((i) => i.id)).toEqual(["1", "2", "3", "4"]);
    expect(sc.requests).toHaveLength(2);
    // First page should send `after=null`; second should pass the cursor through.
    const firstBody = sc.requests[0]?.body as {
      variables: { after: string | null };
    };
    const secondBody = sc.requests[1]?.body as {
      variables: { after: string | null };
    };
    expect(firstBody.variables.after).toBeNull();
    expect(secondBody.variables.after).toBe("cur1");
  });

  it("raises LinearMissingEndCursor when hasNextPage=true but endCursor is null", async () => {
    const sc = scriptedClient([
      {
        kind: "ok",
        status: 200,
        json: {
          data: {
            issues: {
              nodes: [rawNode("1")],
              pageInfo: { endCursor: null, hasNextPage: true },
            },
          },
        },
      },
    ]);
    const svc = make(
      ENDPOINT,
      API_KEY,
      sc.client,
      PROJECT_SLUG,
      ["Todo"],
      TEST_RETRY_SCHEDULE,
    );
    const err = await runErr(svc.fetchCandidateIssues);
    expect((err as { _tag: string })._tag).toBe("LinearMissingEndCursor");
  });

  it("maps a transport error to LinearRequestFail (after retries exhausted)", async () => {
    // 5 attempts = initial + 4 retries by the LinearClient retry schedule.
    const sc = scriptedClient(
      Array.from({ length: 5 }, () => ({
        kind: "transport" as const,
        message: "ECONNREFUSED",
      })),
    );
    const svc = make(
      ENDPOINT,
      API_KEY,
      sc.client,
      PROJECT_SLUG,
      ["Todo"],
      TEST_RETRY_SCHEDULE,
    );
    const err = await runErr(svc.fetchCandidateIssues);
    expect((err as { _tag: string })._tag).toBe("LinearRequestFail");
    expect(sc.remaining()).toBe(0);
  });

  it("maps a non-2xx response to LinearStatusFail (carrying status code)", async () => {
    const sc = scriptedClient([
      { kind: "ok", status: 401, json: { message: "unauthorized" } },
    ]);
    const svc = make(
      ENDPOINT,
      API_KEY,
      sc.client,
      PROJECT_SLUG,
      ["Todo"],
      TEST_RETRY_SCHEDULE,
    );
    const err = await runErr(svc.fetchCandidateIssues);
    expect((err as { _tag: string })._tag).toBe("LinearStatusFail");
    expect((err as { status: number }).status).toBe(401);
  });

  it("retries 5xx responses and eventually fails with LinearStatusFail", async () => {
    // 5 attempts of 503 should exhaust the schedule and surface 503.
    const sc = scriptedClient(
      Array.from({ length: 5 }, () => ({
        kind: "ok" as const,
        status: 503,
        json: { error: "unavailable" },
      })),
    );
    const svc = make(
      ENDPOINT,
      API_KEY,
      sc.client,
      PROJECT_SLUG,
      ["Todo"],
      TEST_RETRY_SCHEDULE,
    );
    const err = await runErr(svc.fetchCandidateIssues);
    expect((err as { _tag: string })._tag).toBe("LinearStatusFail");
    expect((err as { status: number }).status).toBe(503);
    // Should have actually retried — we expect more than one request.
    expect(sc.requests.length).toBeGreaterThan(1);
  });

  it("maps a GraphQL errors[] payload to LinearGraphqlErrors", async () => {
    const sc = scriptedClient([
      {
        kind: "ok",
        status: 200,
        json: {
          errors: [{ message: "Field 'whoops' doesn't exist" }],
        },
      },
    ]);
    const svc = make(
      ENDPOINT,
      API_KEY,
      sc.client,
      PROJECT_SLUG,
      ["Todo"],
      TEST_RETRY_SCHEDULE,
    );
    const err = await runErr(svc.fetchCandidateIssues);
    expect((err as { _tag: string })._tag).toBe("LinearGraphqlErrors");
    expect((err as { errors: ReadonlyArray<{ message: string }> }).errors[0]?.message).toMatch(
      /whoops/,
    );
  });

  it("maps a malformed payload to LinearUnknownPayload", async () => {
    const sc = scriptedClient([
      {
        kind: "ok",
        status: 200,
        json: { data: { issues: { wrongShape: true } } },
      },
    ]);
    const svc = make(
      ENDPOINT,
      API_KEY,
      sc.client,
      PROJECT_SLUG,
      ["Todo"],
      TEST_RETRY_SCHEDULE,
    );
    const err = await runErr(svc.fetchCandidateIssues);
    expect((err as { _tag: string })._tag).toBe("LinearUnknownPayload");
  });

  it("sets the Authorization header without the 'Bearer ' prefix", async () => {
    const sc = scriptedClient([
      { kind: "ok", status: 200, json: okPage(["1"]) },
    ]);
    const svc = make(
      ENDPOINT,
      API_KEY,
      sc.client,
      PROJECT_SLUG,
      ["Todo"],
      TEST_RETRY_SCHEDULE,
    );
    await Effect.runPromise(svc.fetchCandidateIssues);
    // The fake HttpClient doesn't expose headers directly through our capture;
    // instead we re-issue the same Effect against a header-capturing client.
    const captured: { authorization: string | null } = { authorization: null };
    const capturingClient = HttpClient.make((request) => {
      captured.authorization = request.headers["authorization"] ?? null;
      const webResponse = new Response(JSON.stringify(okPage(["1"])), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      return Effect.succeed(HttpClientResponse.fromWeb(request, webResponse));
    });
    const svc2 = make(
      ENDPOINT,
      API_KEY,
      capturingClient,
      PROJECT_SLUG,
      ["Todo"],
      TEST_RETRY_SCHEDULE,
    );
    await Effect.runPromise(svc2.fetchCandidateIssues);
    expect(captured.authorization).toBe(API_KEY);
    expect(captured.authorization?.startsWith("Bearer ")).toBe(false);
  });
});

describe("LinearClient.fetchIssuesByStates", () => {
  it("returns [] without making an HTTP call when the input is empty (§17.3)", async () => {
    const sc = scriptedClient([]);
    const svc = make(
      ENDPOINT,
      API_KEY,
      sc.client,
      PROJECT_SLUG,
      ["Todo"],
      TEST_RETRY_SCHEDULE,
    );
    const out = await Effect.runPromise(svc.fetchIssuesByStates([]));
    expect(out).toEqual([]);
    expect(sc.requests).toHaveLength(0);
  });

  it("forwards the supplied state names as $states variable", async () => {
    const sc = scriptedClient([
      { kind: "ok", status: 200, json: okPage(["1"]) },
    ]);
    const svc = make(
      ENDPOINT,
      API_KEY,
      sc.client,
      PROJECT_SLUG,
      ["Todo"],
      TEST_RETRY_SCHEDULE,
    );
    await Effect.runPromise(svc.fetchIssuesByStates(["Done", "Cancelled"]));
    const sentBody = sc.requests[0]?.body as {
      variables: { states: ReadonlyArray<string> };
    };
    expect(sentBody.variables.states).toEqual(["Done", "Cancelled"]);
  });
});

describe("LinearClient.fetchIssueStatesByIds", () => {
  it("returns minimal issues with normalized states", async () => {
    const sc = scriptedClient([
      {
        kind: "ok",
        status: 200,
        json: {
          data: {
            issues: {
              nodes: [
                { id: "iss-1", identifier: "MT-1", state: { name: "Done" } },
                { id: "iss-2", identifier: "MT-2", state: { name: "Todo" } },
              ],
            },
          },
        },
      },
    ]);
    const svc = make(
      ENDPOINT,
      API_KEY,
      sc.client,
      PROJECT_SLUG,
      ["Todo"],
      TEST_RETRY_SCHEDULE,
    );
    const out = await Effect.runPromise(
      svc.fetchIssueStatesByIds(["iss-1", "iss-2"]),
    );
    expect(out).toEqual([
      { id: "iss-1", identifier: "MT-1", state: "Done" },
      { id: "iss-2", identifier: "MT-2", state: "Todo" },
    ]);
  });

  it("returns [] without an HTTP call when the input is empty", async () => {
    const sc = scriptedClient([]);
    const svc = make(
      ENDPOINT,
      API_KEY,
      sc.client,
      PROJECT_SLUG,
      ["Todo"],
      TEST_RETRY_SCHEDULE,
    );
    const out = await Effect.runPromise(svc.fetchIssueStatesByIds([]));
    expect(out).toEqual([]);
    expect(sc.requests).toHaveLength(0);
  });
});

describe("LinearClient.executeRaw", () => {
  it("returns the raw { data, errors } envelope unchanged (no normalization)", async () => {
    const raw = {
      data: { something: "arbitrary", nested: { ok: true } },
      errors: [{ message: "soft warning", path: ["something"] }],
    };
    const sc = scriptedClient([{ kind: "ok", status: 200, json: raw }]);
    const svc = make(
      ENDPOINT,
      API_KEY,
      sc.client,
      PROJECT_SLUG,
      ["Todo"],
      TEST_RETRY_SCHEDULE,
    );
    const out = await Effect.runPromise(svc.executeRaw("query { x }", { v: 1 }));
    // The envelope round-trips through schema decode but the inner `data`
    // payload is `Schema.Unknown` so it is preserved verbatim. Errors[] is
    // preserved as well — executeRaw does NOT promote it to LinearGraphqlErrors.
    expect((out as { data: unknown }).data).toEqual(raw.data);
    expect((out as { errors: ReadonlyArray<unknown> }).errors).toEqual(
      raw.errors,
    );
  });

  it("forwards query and variables verbatim to the endpoint", async () => {
    const sc = scriptedClient([
      { kind: "ok", status: 200, json: { data: {} } },
    ]);
    const svc = make(
      ENDPOINT,
      API_KEY,
      sc.client,
      PROJECT_SLUG,
      ["Todo"],
      TEST_RETRY_SCHEDULE,
    );
    await Effect.runPromise(svc.executeRaw("query Y { y }", { id: "abc" }));
    expect(sc.requests[0]?.body).toEqual({
      query: "query Y { y }",
      variables: { id: "abc" },
    });
  });

  it("still maps transport / status / decode failures to LinearClientError", async () => {
    const sc = scriptedClient([
      { kind: "ok", status: 400, json: { error: "bad" } },
    ]);
    const svc = make(
      ENDPOINT,
      API_KEY,
      sc.client,
      PROJECT_SLUG,
      ["Todo"],
      TEST_RETRY_SCHEDULE,
    );
    const err = await runErr(svc.executeRaw("query { x }"));
    expect((err as { _tag: string })._tag).toBe("LinearStatusFail");
  });
});

/* -------------------------------------------------------------------------- */
/* Live Layer wiring against WorkflowLoader                                   */
/* -------------------------------------------------------------------------- */

const fakeConfig = (overrides?: Partial<TypedConfig["tracker"]>): TypedConfig => ({
  tracker: {
    kind: "linear",
    endpoint: ENDPOINT,
    api_key: API_KEY,
    project_slug: PROJECT_SLUG,
    active_states: ["Todo"],
    terminal_states: ["Done"],
    ...overrides,
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
    max_concurrent_agents: 10,
    max_concurrent_agents_by_state: {},
    max_retry_backoff_ms: 300_000,
  },
  server: null,
});

/**
 * Build a stubbed WorkflowLoader that always returns the supplied config and
 * never emits change events. Suitable for unit-testing LinearClientLive
 * without touching the filesystem.
 */
const stubWorkflowLoader = (config: TypedConfig): Layer.Layer<WorkflowLoader> =>
  Layer.effect(
    WorkflowLoader,
    Effect.gen(function* () {
      const ref = yield* Ref.make<WorkflowDefinition>({
        config,
        prompt_template: "x",
        source_path: "/tmp/WORKFLOW.md",
      });
      return {
        current: Ref.get(ref),
        // Empty stream — the LinearClient never reads `changes`.
        changes: {
          [Symbol.iterator]: function* () {
            // unused
          },
        } as never,
        validateForDispatch: Effect.void,
      };
    }),
  );

describe("LinearClientLive", () => {
  it("reads endpoint + api_key + project_slug from the WorkflowLoader snapshot", async () => {
    const sc = scriptedClient([
      { kind: "ok", status: 200, json: okPage(["1"]) },
    ]);
    const program = Effect.gen(function* () {
      const lc = yield* LinearClient;
      return yield* lc.fetchCandidateIssues;
    });
    const out = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          LinearClientLive.pipe(
            Layer.provide(
              Layer.merge(
                stubWorkflowLoader(fakeConfig()),
                Layer.succeed(HttpClient.HttpClient, sc.client),
              ),
            ),
          ),
        ),
      ),
    );
    expect(out).toHaveLength(1);
    expect((out[0] as Issue).id).toBe("1");
    // The captured request should target the endpoint from the loader.
    expect(sc.requests[0]?.url).toContain("api.linear.app");
  });

  it("fails LinearRequestFail when api_key is null in the loader snapshot", async () => {
    const sc = scriptedClient([]);
    const program = Effect.gen(function* () {
      const lc = yield* LinearClient;
      return yield* lc.fetchCandidateIssues;
    });
    const result = await Effect.runPromiseExit(
      program.pipe(
        Effect.provide(
          LinearClientLive.pipe(
            Layer.provide(
              Layer.merge(
                stubWorkflowLoader(fakeConfig({ api_key: null })),
                Layer.succeed(HttpClient.HttpClient, sc.client),
              ),
            ),
          ),
        ),
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(sc.requests).toHaveLength(0);
    if (Exit.isFailure(result)) {
      // Drill into the cause to find the tag.
      const fail = await Effect.runPromise(
        Effect.either(
          program.pipe(
            Effect.provide(
              LinearClientLive.pipe(
                Layer.provide(
                  Layer.merge(
                    stubWorkflowLoader(fakeConfig({ api_key: null })),
                    Layer.succeed(HttpClient.HttpClient, sc.client),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      expect(fail._tag).toBe("Left");
      if (fail._tag === "Left") {
        expect((fail.left as LinearClientError)._tag).toBe("LinearRequestFail");
      }
    }
  });
});
