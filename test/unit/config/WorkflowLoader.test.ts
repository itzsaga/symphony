// Unit tests for the WorkflowLoader service: initial load, file watch reload,
// invalid-reload preservation, dispatch preflight, and scope teardown.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer, Scope } from "effect";
import { WorkflowLoader, layer } from "../../../src/config/WorkflowLoader.ts";
import {
  Logger,
  type LogRecord,
  type LogSink,
  layer as loggerLayer,
} from "../../../src/observability/Logger.ts";

/* -------------------------------------------------------------------------- */
/* Test fixtures and helpers                                                  */
/* -------------------------------------------------------------------------- */

/** Build a valid WORKFLOW.md body string with controllable fields. */
const validWorkflow = (overrides?: {
  apiKey?: string;
  projectSlug?: string;
  maxTurns?: number;
}): string => {
  const apiKey = overrides?.apiKey ?? "tok-abc";
  const projectSlug = overrides?.projectSlug ?? "my-project";
  const maxTurns = overrides?.maxTurns ?? 20;
  return `---
tracker:
  kind: linear
  api_key: ${apiKey}
  project_slug: ${projectSlug}
agent_runner:
  max_turns: ${maxTurns}
---
prompt body
`;
};

/** Capture sink for assertion against emitted log records. */
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

/** Sleep inside an Effect for `ms` milliseconds (for debounce settling). */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Default debounce + safety margin: 250ms debounce + 250ms breathing room. */
const RELOAD_WAIT_MS = 500;

describe("WorkflowLoader", () => {
  let tempDir: string;
  let workflowPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "symphony-loader-test-"));
    workflowPath = join(tempDir, "WORKFLOW.md");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads + parses on startup; current returns the parsed definition", async () => {
    writeFileSync(workflowPath, validWorkflow({ maxTurns: 7 }));
    const captured = captureSink();
    const program = Effect.gen(function* () {
      const loader = yield* WorkflowLoader;
      return yield* loader.current;
    });
    const wf = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          Layer.provideMerge(
            layer({ path: workflowPath }),
            loggerLayer({ sink: captured.sink }),
          ),
        ),
      ),
    );
    expect(wf.config.agent_runner.max_turns).toBe(7);
    expect(wf.config.tracker.api_key).toBe("tok-abc");
    expect(wf.config.tracker.project_slug).toBe("my-project");
    // Startup should have logged a "workflow loaded" record.
    expect(
      captured.records.some(
        (r) => r["msg"] === "workflow loaded" && r.level === "info",
      ),
    ).toBe(true);
  });

  it("fails Layer build when the initial workflow is invalid (preflight)", async () => {
    // Missing api_key — preflight should fail.
    writeFileSync(
      workflowPath,
      `---
tracker:
  kind: linear
  project_slug: ok
---
body
`,
    );
    const captured = captureSink();
    const program = Effect.gen(function* () {
      yield* WorkflowLoader;
    });
    const exit = await Effect.runPromiseExit(
      program.pipe(
        Effect.provide(
          Layer.provideMerge(
            layer({ path: workflowPath }),
            loggerLayer({ sink: captured.sink }),
          ),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("fails Layer build when the workflow file does not exist", async () => {
    const missingPath = join(tempDir, "DOES_NOT_EXIST.md");
    const captured = captureSink();
    const program = Effect.gen(function* () {
      yield* WorkflowLoader;
    });
    const exit = await Effect.runPromiseExit(
      program.pipe(
        Effect.provide(
          Layer.provideMerge(
            layer({ path: missingPath }),
            loggerLayer({ sink: captured.sink }),
          ),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("emits on changes and updates current when the file is rewritten with valid content", async () => {
    writeFileSync(workflowPath, validWorkflow({ maxTurns: 7 }));
    const captured = captureSink();
    // Use a manual Scope so we can run a long-lived program: open the loader,
    // mutate the file, observe the update, then close the scope.
    const scope = await Effect.runPromise(Scope.make());
    try {
      const built = await Effect.runPromise(
        Layer.buildWithScope(
          Layer.provideMerge(
            layer({ path: workflowPath, debounceMs: 100 }),
            loggerLayer({ sink: captured.sink }),
          ),
          scope,
        ),
      );
      const program = Effect.gen(function* () {
        const l = yield* WorkflowLoader;
        return yield* l.current;
      });
      const before = await Effect.runPromise(
        program.pipe(Effect.provide(built)),
      );
      expect(before.config.agent_runner.max_turns).toBe(7);

      // Rewrite with a new max_turns; wait for debounce + reload.
      writeFileSync(workflowPath, validWorkflow({ maxTurns: 30 }));
      await sleep(RELOAD_WAIT_MS);

      const after = await Effect.runPromise(
        program.pipe(Effect.provide(built)),
      );
      expect(after.config.agent_runner.max_turns).toBe(30);

      // A reload-success info record should have been emitted.
      expect(
        captured.records.some((r) => r["msg"] === "workflow reloaded"),
      ).toBe(true);
    } finally {
      await Effect.runPromise(
        Scope.close(scope, Exit.succeed<void>(undefined)),
      );
    }
  });

  it("preserves last-known-good and warns when reload content is invalid", async () => {
    writeFileSync(workflowPath, validWorkflow({ maxTurns: 7 }));
    const captured = captureSink();
    const scope = await Effect.runPromise(Scope.make());
    try {
      const built = await Effect.runPromise(
        Layer.buildWithScope(
          Layer.provideMerge(
            layer({ path: workflowPath, debounceMs: 100 }),
            loggerLayer({ sink: captured.sink }),
          ),
          scope,
        ),
      );
      const program = Effect.gen(function* () {
        const l = yield* WorkflowLoader;
        return yield* l.current;
      });

      // Confirm initial state.
      const before = await Effect.runPromise(
        program.pipe(Effect.provide(built)),
      );
      expect(before.config.agent_runner.max_turns).toBe(7);

      // Rewrite with content the parser explicitly rejects: codex.* namespace.
      writeFileSync(
        workflowPath,
        `---
codex:
  command: codex app-server
---
body
`,
      );
      await sleep(RELOAD_WAIT_MS);

      // current should still be the original (last-known-good).
      const after = await Effect.runPromise(
        program.pipe(Effect.provide(built)),
      );
      expect(after.config.agent_runner.max_turns).toBe(7);

      // A warn record with the failure message should have been emitted.
      expect(
        captured.records.some(
          (r) =>
            r.level === "warn" &&
            r["msg"] === "workflow reload failed; keeping last known good",
        ),
      ).toBe(true);
    } finally {
      await Effect.runPromise(
        Scope.close(scope, Exit.succeed<void>(undefined)),
      );
    }
  });

  it("validateForDispatch detects missing tracker.api_key after $VAR resolution", async () => {
    // Reference an unset env var so $VAR resolution yields null and the
    // schema treats api_key as absent. Preflight should then reject it.
    delete process.env["SYMPHONY_LOADER_TEST_TOKEN"];
    writeFileSync(
      workflowPath,
      `---
tracker:
  kind: linear
  api_key: $SYMPHONY_LOADER_TEST_TOKEN
  project_slug: ok
---
body
`,
    );
    const captured = captureSink();
    // Initial preflight runs at startup, so the Layer build itself fails.
    const program = Effect.gen(function* () {
      const l = yield* WorkflowLoader;
      return yield* l.validateForDispatch;
    });
    const exit = await Effect.runPromiseExit(
      program.pipe(
        Effect.provide(
          Layer.provideMerge(
            layer({ path: workflowPath }),
            loggerLayer({ sink: captured.sink }),
          ),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);

    // Now confirm the same check via the service hook against a workflow that
    // parses but lacks api_key. We craft this by setting the env at startup
    // (so build succeeds) then unsetting it does NOT change the cached
    // definition (env is read at parse time only) — instead, write a workflow
    // with a literal blank api_key... actually the parser strips empty $VARs,
    // so the simplest path is to rewrite the file post-build to omit api_key,
    // wait for the reload, and assert validateForDispatch fails.
    process.env["SYMPHONY_LOADER_TEST_TOKEN"] = "real-token";
    writeFileSync(
      workflowPath,
      `---
tracker:
  kind: linear
  api_key: $SYMPHONY_LOADER_TEST_TOKEN
  project_slug: ok
---
body
`,
    );
    const scope = await Effect.runPromise(Scope.make());
    try {
      const built = await Effect.runPromise(
        Layer.buildWithScope(
          Layer.provideMerge(
            layer({ path: workflowPath, debounceMs: 100 }),
            loggerLayer({ sink: captured.sink }),
          ),
          scope,
        ),
      );
      // Build succeeded. Now drop the api_key (set to an unset $VAR) and
      // wait for the reload to apply.
      delete process.env["SYMPHONY_LOADER_TEST_TOKEN"];
      writeFileSync(
        workflowPath,
        `---
tracker:
  kind: linear
  api_key: $SYMPHONY_LOADER_TEST_TOKEN
  project_slug: ok
---
body
`,
      );
      await sleep(RELOAD_WAIT_MS);
      const program2 = Effect.gen(function* () {
        const l = yield* WorkflowLoader;
        return yield* l.validateForDispatch;
      });
      const exit2 = await Effect.runPromiseExit(
        program2.pipe(Effect.provide(built)),
      );
      expect(Exit.isFailure(exit2)).toBe(true);
    } finally {
      await Effect.runPromise(
        Scope.close(scope, Exit.succeed<void>(undefined)),
      );
      delete process.env["SYMPHONY_LOADER_TEST_TOKEN"];
    }
  });

  it("interrupts the watcher fiber when the Layer scope closes", async () => {
    writeFileSync(workflowPath, validWorkflow({ maxTurns: 7 }));
    const captured = captureSink();
    const scope = await Effect.runPromise(Scope.make());
    const built = await Effect.runPromise(
      Layer.buildWithScope(
        Layer.provideMerge(
          layer({ path: workflowPath, debounceMs: 100 }),
          loggerLayer({ sink: captured.sink }),
        ),
        scope,
      ),
    );
    const readCurrent = Effect.gen(function* () {
      const l = yield* WorkflowLoader;
      return yield* l.current;
    });

    // Sanity check: a live reload before close updates current.
    writeFileSync(workflowPath, validWorkflow({ maxTurns: 11 }));
    await sleep(RELOAD_WAIT_MS);
    const beforeClose = await Effect.runPromise(
      readCurrent.pipe(Effect.provide(built)),
    );
    expect(beforeClose.config.agent_runner.max_turns).toBe(11);

    // Count reload-info records before closing the scope.
    const reloadCountBefore = captured.records.filter(
      (r) => r["msg"] === "workflow reloaded",
    ).length;

    // Close the scope; this should interrupt the watcher fiber and release
    // the underlying fs.watch fd.
    await Effect.runPromise(
      Scope.close(scope, Exit.succeed<void>(undefined)),
    );

    // Mutate the file post-close and confirm no further reload fires. A
    // surviving watcher would log a "workflow reloaded" record within the
    // RELOAD_WAIT_MS window.
    writeFileSync(workflowPath, validWorkflow({ maxTurns: 99 }));
    await sleep(RELOAD_WAIT_MS);
    const reloadCountAfter = captured.records.filter(
      (r) => r["msg"] === "workflow reloaded",
    ).length;
    expect(reloadCountAfter).toBe(reloadCountBefore);

    // The cached `current` snapshot stays at the last successful reload
    // because the SubscriptionRef itself outlives the closed scope (only
    // the watcher fiber + fs.watch fd are torn down).
    const afterClose = await Effect.runPromise(
      readCurrent.pipe(Effect.provide(built)),
    );
    expect(afterClose.config.agent_runner.max_turns).toBe(11);
  });
});
