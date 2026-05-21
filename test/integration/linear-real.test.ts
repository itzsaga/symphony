// Real-Linear integration tests (§17.8). Gated on LINEAR_API_KEY. Verifies
// LinearClient against a live workspace and runs an end-to-end orchestrator smoke.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FetchHttpClient, HttpClient } from "@effect/platform";
import { Cause, Duration, Effect, Exit, Layer, Option, Schedule } from "effect";
import {
  LinearClient,
  type LinearClientService,
  make as makeLinearClient,
} from "../../src/linear/LinearClient.ts";
import type { LinearClientError } from "../../src/linear/schemas.ts";
import {
  drainCleanup,
  emitSkipBanner,
  HAS_LINEAR_API_KEY,
  INTEGRATION_WORKSPACE_ROOT,
  LINEAR_API_KEY,
  LINEAR_ENDPOINT,
  mutationFor,
  TEST_PROJECT_SLUG,
} from "./setup.ts";

/* -------------------------------------------------------------------------- */
/* Resolved paths                                                             */
/* -------------------------------------------------------------------------- */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const MAIN_PATH = join(REPO_ROOT, "src", "main.ts");

/* -------------------------------------------------------------------------- */
/* Skip banner                                                                */
/* -------------------------------------------------------------------------- */

// Without the key, emit a single banner line to stderr so `bun test` output
// makes the skip reason unambiguous to operators. Per §17.8: "A skipped
// real-integration test SHOULD be reported as skipped, not silently treated
// as passed."
if (!HAS_LINEAR_API_KEY) {
  emitSkipBanner();
}

/* -------------------------------------------------------------------------- */
/* Shared LinearClient (used by both query tests and the cleanup harness)     */
/* -------------------------------------------------------------------------- */

/**
 * A near-instant retry schedule. The §17.8 suite still wants to exercise
 * Linear's real retry semantics (which the production schedule handles
 * upstream of these tests) but we don't want to wait minutes when a
 * transient failure surfaces.
 */
const TEST_RETRY_SCHEDULE = Schedule.spaced(Duration.millis(250)).pipe(
  Schedule.compose(Schedule.recurs(2)),
);

/**
 * Build a fresh `LinearClientService` bound to the real Linear endpoint and
 * the resolved API key. We construct one HttpClient per call so the test
 * doesn't share resources between cases — keeps lifetime trivially scoped.
 *
 * The returned Effect requires an `HttpClient` in its environment; callers
 * provide it via `Effect.provide(FetchHttpClient.layer)` so we never hand-
 * roll a fetch loop.
 */
const withLinearService = <A>(
  body: (svc: LinearClientService) => Effect.Effect<A, LinearClientError>,
): Effect.Effect<A, LinearClientError> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    // Cast LINEAR_API_KEY: the outer skipIf guarantees it's non-null when
    // these tests execute, but the value is typed as `string | null` for
    // the module-level constant. We assert + throw rather than `!` so any
    // wiring regression surfaces immediately.
    if (LINEAR_API_KEY === null) {
      throw new Error("LINEAR_API_KEY is null inside a gated test");
    }
    const svc = makeLinearClient(
      LINEAR_ENDPOINT,
      LINEAR_API_KEY,
      client,
      TEST_PROJECT_SLUG,
      ["Todo", "In Progress"],
      TEST_RETRY_SCHEDULE,
    );
    return yield* body(svc);
  }).pipe(Effect.provide(FetchHttpClient.layer));

/**
 * Run a LinearClient Effect to a typed exit. Mirrors the helper used in the
 * unit tests; tests pattern-match on the tagged error when they assert
 * specific failure categories.
 */
const runLinear = async <A>(
  effect: Effect.Effect<A, LinearClientError>,
): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) {
    const err = failure.value;
    throw new Error(
      `LinearClient call failed: ${err._tag} ${JSON.stringify(err)}`,
    );
  }
  throw new Error(`LinearClient call defected: ${Cause.pretty(exit.cause)}`);
};

/* -------------------------------------------------------------------------- */
/* Cleanup harness                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Run every recorded cleanup mutation, swallowing per-entry failures so a
 * single broken cleanup does not leak unrelated artifacts. The summary is
 * written to stderr so an operator can spot leftovers manually.
 */
const drainAndCleanup = async (): Promise<void> => {
  const entries = drainCleanup();
  if (entries.length === 0) return;
  if (LINEAR_API_KEY === null) return; // belt-and-braces

  for (const entry of entries) {
    const mutation = mutationFor(entry.kind);
    const eff = withLinearService((svc) =>
      svc.executeRaw(mutation, { id: entry.id }),
    );
    const exit = await Effect.runPromiseExit(eff);
    if (Exit.isFailure(exit)) {
      process.stderr.write(
        `integration cleanup failed for ${entry.kind}=${entry.id} (${entry.label}): ${Cause.pretty(exit.cause)}\n`,
      );
    }
  }
};

/* -------------------------------------------------------------------------- */
/* Workspace root lifecycle                                                   */
/* -------------------------------------------------------------------------- */

beforeAll(() => {
  if (!HAS_LINEAR_API_KEY) return;
  if (!existsSync(INTEGRATION_WORKSPACE_ROOT)) {
    mkdirSync(INTEGRATION_WORKSPACE_ROOT, { recursive: true });
  }
});

afterAll(async () => {
  if (!HAS_LINEAR_API_KEY) return;
  await drainAndCleanup();
  rmSync(INTEGRATION_WORKSPACE_ROOT, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Per-suite skip helper                                                      */
/* -------------------------------------------------------------------------- */

// `bun:test`'s skipIf accepts a boolean; when truthy, the case is reported
// as skipped (not silently passed). We invert HAS_LINEAR_API_KEY because we
// want to skip when the key is *absent*.
const skipIfNoKey = !HAS_LINEAR_API_KEY;

/* -------------------------------------------------------------------------- */
/* LinearClient query tests                                                   */
/* -------------------------------------------------------------------------- */

describe("LinearClient against live Linear", () => {
  it.skipIf(skipIfNoKey)(
    "fetchCandidateIssues returns at least one issue for the test project",
    async () => {
      const issues = await runLinear(
        withLinearService((svc) => svc.fetchCandidateIssues),
      );
      // The bootstrap doc instructs the operator to seed the project with at
      // least one Todo or In-Progress fixture issue. If this assertion fails,
      // the project isn't bootstrapped — see test/integration/README.md.
      expect(issues.length).toBeGreaterThan(0);
      const first = issues[0];
      if (first === undefined) throw new Error("unreachable");
      expect(typeof first.id).toBe("string");
      expect(typeof first.identifier).toBe("string");
      expect(["Todo", "In Progress"]).toContain(first.state);
    },
    30_000,
  );

  it.skipIf(skipIfNoKey)(
    "fetchIssuesByStates([\"Done\"]) returns terminal-state issues",
    async () => {
      const issues = await runLinear(
        withLinearService((svc) => svc.fetchIssuesByStates(["Done"])),
      );
      // We do NOT require Done issues to exist in the project — operators
      // may not have seeded any. The assertion is on the shape (returns an
      // array; no throw), not the count.
      expect(Array.isArray(issues)).toBe(true);
      for (const issue of issues) {
        expect(issue.state).toBe("Done");
      }
    },
    30_000,
  );

  it.skipIf(skipIfNoKey)(
    "fetchIssueStatesByIds returns the expected state for a known id",
    async () => {
      const candidates = await runLinear(
        withLinearService((svc) => svc.fetchCandidateIssues),
      );
      const known = candidates[0];
      if (known === undefined) {
        throw new Error(
          "no candidate issues to pick a known id from; bootstrap the test project per README",
        );
      }
      const minimal = await runLinear(
        withLinearService((svc) => svc.fetchIssueStatesByIds([known.id])),
      );
      expect(minimal).toHaveLength(1);
      const only = minimal[0];
      if (only === undefined) throw new Error("unreachable");
      expect(only.id).toBe(known.id);
      expect(only.identifier).toBe(known.identifier);
      expect(only.state).toBe(known.state);
    },
    30_000,
  );

  it.skipIf(skipIfNoKey)(
    "executeRaw round-trips a viewer query",
    async () => {
      const raw = await runLinear(
        withLinearService((svc) =>
          svc.executeRaw(
            `query SymphonyIntegrationViewer { viewer { id email } }`,
            {},
          ),
        ),
      );
      // The MCP tool returns the raw envelope; we verify the standard
      // GraphQL shape rather than asserting on the viewer fields (those
      // depend on which API key is in use).
      expect(typeof raw).toBe("object");
      if (raw === null || typeof raw !== "object") {
        throw new Error("viewer query returned a non-object");
      }
      const envelope = raw as { data?: unknown; errors?: unknown };
      expect("data" in envelope || "errors" in envelope).toBe(true);
      if (envelope.data !== undefined) {
        const data = envelope.data as { viewer?: { id?: unknown } };
        expect(typeof data.viewer?.id).toBe("string");
      }
    },
    30_000,
  );
});

/* -------------------------------------------------------------------------- */
/* End-to-end smoke: spawn the orchestrator against the real key             */
/* -------------------------------------------------------------------------- */

/**
 * Build a minimal WORKFLOW.md body wired against the live Linear endpoint.
 * `polling.interval_ms` is a few seconds so the orchestrator picks up a
 * candidate quickly; `agent_runner.max_turns=2` bounds Claude's cost.
 *
 * The prompt deliberately tells Claude to exit immediately — we are only
 * verifying that the orchestrator dispatches and that one turn completes;
 * the contents of the turn are out of scope for this acceptance test.
 */
const smokeWorkflowBody = (params: {
  readonly apiKey: string;
  readonly projectSlug: string;
  readonly workspaceRoot: string;
}): string => `---
tracker:
  kind: linear
  api_key: ${params.apiKey}
  project_slug: ${params.projectSlug}
polling:
  interval_ms: 5000
workspace:
  root: ${params.workspaceRoot}
agent_runner:
  kind: claude_code
  max_turns: 2
  turn_timeout_ms: 60000
  stall_timeout_ms: 30000
  bare: true
---
You are running inside a Symphony integration smoke test. Respond with the
single word "done" and exit. Do not call any tools.
`;

/**
 * Read accumulated stderr from a `Bun.spawn`'d child. We drain via async
 * readers so the buffer never blocks the subprocess.
 */
interface RunningChild {
  readonly proc: ReturnType<typeof Bun.spawn>;
  readonly stderr: () => string;
  readonly stopWith: (signal: NodeJS.Signals) => Promise<number>;
}

/**
 * Spawn the daemon and wait until either (a) the matcher predicate returns
 * true for any stderr line accumulated so far, or (b) the timeout elapses.
 * Either case resolves to a `RunningChild` handle that exposes the buffered
 * stderr and a `stopWith` method.
 *
 * The matcher operates on the cumulative stderr buffer so callers can look
 * for any of several markers without coordinating on log line order.
 */
const startUntilStderrMatches = async (
  args: ReadonlyArray<string>,
  cwd: string,
  matcher: (stderr: string) => boolean,
  timeoutMs: number,
): Promise<RunningChild> => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", MAIN_PATH, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  let stderrBuf = "";
  let resolved = false;
  const matched = new Promise<void>((resolveMatch, rejectMatch) => {
    const timer = setTimeout(() => {
      if (!resolved) {
        rejectMatch(
          new Error(
            `matcher not satisfied within ${timeoutMs}ms; stderr so far:\n${stderrBuf}`,
          ),
        );
      }
    }, timeoutMs);
    const drainStderr = async (): Promise<void> => {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        stderrBuf += decoder.decode(value, { stream: true });
        if (!resolved && matcher(stderrBuf)) {
          resolved = true;
          clearTimeout(timer);
          resolveMatch();
        }
      }
    };
    const drainStdout = async (): Promise<void> => {
      const reader = proc.stdout.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) return;
      }
    };
    void drainStderr();
    void drainStdout();
  });

  await matched;

  const stopWith = async (signal: NodeJS.Signals): Promise<number> => {
    proc.kill(signal);
    return await proc.exited;
  };
  return {
    proc,
    stderr: () => stderrBuf,
    stopWith,
  };
};

describe("orchestrator smoke against live Linear", () => {
  it.skipIf(skipIfNoKey)(
    "spawns the daemon, dispatches at least one issue, observes a Claude turn, then shuts down cleanly",
    async () => {
      if (LINEAR_API_KEY === null) {
        throw new Error("unreachable — skipIfNoKey guards this case");
      }

      // Per-run workflow file: distinct path so concurrent invocations of
      // the suite can't collide on a shared file handle.
      const wfDir = join(INTEGRATION_WORKSPACE_ROOT, `wf-${Date.now()}`);
      mkdirSync(wfDir, { recursive: true });
      const wfPath = join(wfDir, "WORKFLOW.md");
      const wsRoot = join(wfDir, "workspaces");
      writeFileSync(
        wfPath,
        smokeWorkflowBody({
          apiKey: LINEAR_API_KEY,
          projectSlug: TEST_PROJECT_SLUG,
          workspaceRoot: wsRoot,
        }),
      );

      // Wait for *both* the HTTP server bind line AND at least one
      // candidate-poll log line — together those prove the orchestrator
      // has loaded the workflow, started polling, and that we can hit
      // /api/v1/state without the server crashing first.
      const child = await startUntilStderrMatches(
        ["--port", "0", wfPath],
        wfDir,
        (stderr) =>
          stderr.includes('"msg":"http server listening"') &&
          (stderr.includes("\"msg\":\"candidate poll\"") ||
            stderr.includes("\"msg\":\"dispatched")),
        90_000,
      );

      try {
        // Pull the bound HTTP port out of the listening log record.
        const stderr = child.stderr();
        const listeningLine = stderr
          .split("\n")
          .find((l) => l.includes('"msg":"http server listening"'));
        if (listeningLine === undefined) {
          throw new Error("http server listening line missing from stderr");
        }
        const parsed = JSON.parse(listeningLine) as {
          readonly port: number;
        };
        // /api/v1/state should respond 200 with a state envelope reflecting
        // a running orchestrator. The spec defines `running` and
        // `retrying` keys at the top level; both lists may be empty if
        // dispatch hasn't yet picked anything up — the success criterion
        // is "we get a parseable shape back".
        const resp = await fetch(
          `http://127.0.0.1:${parsed.port}/api/v1/state`,
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as Record<string, unknown>;
        expect("running" in body || "retrying" in body).toBe(true);

        // The §17.8 acceptance criterion calls for "at least one Claude
        // turn complete". We observe that via the structured-log line
        // emitted by the ClaudeSubprocess pipeline once a turn finishes.
        // If no Todo/In-Progress issues exist in the test project, the
        // orchestrator will simply log "candidate poll empty" forever and
        // this assertion fails — that's by design: the project bootstrap
        // is part of the §17.8 contract.
        const turnObserved = await waitForStderrMatch(
          child,
          (s) =>
            s.includes("\"msg\":\"turn complete\"") ||
            s.includes("\"msg\":\"worker completed\"") ||
            s.includes("\"msg\":\"result\""),
          120_000,
        );
        expect(turnObserved).toBe(true);
      } finally {
        const exitCode = await child.stopWith("SIGTERM");
        // Spec §17.7: SIGTERM produces a clean exit (code 0).
        expect(exitCode).toBe(0);
      }
    },
    300_000,
  );
});

/**
 * Wait until `matcher` is satisfied by the running child's stderr, or until
 * `timeoutMs` elapses. Resolves to `true` on match, `false` on timeout. We
 * don't fail the test on timeout — the caller decides how to react.
 */
const waitForStderrMatch = async (
  child: RunningChild,
  matcher: (stderr: string) => boolean,
  timeoutMs: number,
): Promise<boolean> => {
  const start = Date.now();
  // Polling is fine here — stderr is already being drained by the spawn
  // helper, so `child.stderr()` returns the live buffer. We poll every
  // 250ms which is plenty for human-scale log emission.
  while (Date.now() - start < timeoutMs) {
    if (matcher(child.stderr())) return true;
    await new Promise<void>((res) => {
      setTimeout(res, 250);
    });
  }
  return false;
};
