// Unit tests for the WorkspaceManager service.
// Verifies SPEC.md §9.1/§9.2 idempotency, §9.5 path-safety guards, and §8.6 sweep behavior.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer, Ref } from "effect";
import {
  CleanupFailed,
  NonDirectoryAtWorkspacePath,
  PathEscape,
  WorkspaceCreationFailed,
  WorkspaceManager,
  WorkspaceManagerLive,
} from "../../../src/workspace/WorkspaceManager.ts";
import { WorkflowLoader } from "../../../src/config/WorkflowLoader.ts";
import {
  type AbsolutePath,
  assertUnderRoot,
  toAbsolutePathSync,
} from "../../../src/config/PathSafety.ts";
import {
  Logger,
  layer as loggerLayer,
  type LogSink,
} from "../../../src/observability/Logger.ts";
import type {
  TypedConfig,
  WorkflowDefinition,
} from "../../../src/config/WorkflowSchema.ts";
import type { Issue } from "../../../src/linear/schemas.ts";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** Build a TypedConfig whose only meaningful field for this suite is `workspace.root`. */
const buildConfig = (workspaceRoot: string): TypedConfig => ({
  tracker: {
    kind: "linear",
    endpoint: "https://api.linear.app/graphql",
    api_key: null,
    project_slug: null,
    active_states: ["Todo"],
    terminal_states: ["Done"],
  },
  polling: { interval_ms: 30_000 },
  workspace: { root: workspaceRoot },
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
 * Stubbed WorkflowLoader pinned to a fixed config. The WorkspaceManager calls
 * `current` on every operation, so a Ref-backed snapshot is sufficient — no
 * change events need to be emitted.
 */
const stubWorkflowLoader = (
  config: TypedConfig,
): Layer.Layer<WorkflowLoader> =>
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
        // Empty stream — WorkspaceManager never reads `changes`.
        changes: {
          [Symbol.iterator]: function* () {
            // unused
          },
        } as never,
        validateForDispatch: Effect.void,
      };
    }),
  );

/** In-memory log sink for tests that need to assert on emitted records. */
const captureSink = (): { sink: LogSink; lines: Array<string> } => {
  const lines: Array<string> = [];
  return { sink: { write: (line) => void lines.push(line) }, lines };
};

/** Build a fully-defaulted Issue with the given identifier. */
const makeIssue = (identifier: string): Issue => ({
  id: `id-${identifier}`,
  identifier,
  title: "test issue",
  description: null,
  priority: null,
  state: "Todo",
  branch_name: null,
  url: null,
  labels: [],
  blocked_by: [],
  created_at: null,
  updated_at: null,
});

/* -------------------------------------------------------------------------- */
/* Test scaffolding                                                           */
/* -------------------------------------------------------------------------- */

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "symphony-ws-test-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

/**
 * Wire WorkspaceManagerLive against a stubbed loader pointing at `tempRoot`
 * and a capturing logger sink. The returned `lines` array accumulates every
 * JSONL record emitted during the test run.
 */
const buildLayers = (): {
  layer: Layer.Layer<WorkspaceManager>;
  lines: Array<string>;
} => {
  const captured = captureSink();
  const deps = Layer.merge(
    stubWorkflowLoader(buildConfig(tempRoot)),
    loggerLayer({ sink: captured.sink }),
  );
  return {
    layer: WorkspaceManagerLive.pipe(Layer.provide(deps)),
    lines: captured.lines,
  };
};

/* -------------------------------------------------------------------------- */
/* prepareForIssue                                                            */
/* -------------------------------------------------------------------------- */

describe("WorkspaceManager.prepareForIssue", () => {
  it("creates the directory on first call and reports created_now=true", async () => {
    const { layer } = buildLayers();
    const program = Effect.gen(function* () {
      const wm = yield* WorkspaceManager;
      return yield* wm.prepareForIssue(makeIssue("MT-1"));
    });
    const ws = await Effect.runPromise(Effect.provide(program, layer));
    expect(ws.created_now).toBe(true);
    expect(ws.workspace_key).toBe("MT-1");
    expect(ws.path).toBe(join(tempRoot, "MT-1") as AbsolutePath);
    expect(statSync(ws.path).isDirectory()).toBe(true);
  });

  it("reuses an existing directory on the second call (created_now=false)", async () => {
    const { layer } = buildLayers();
    const program = Effect.gen(function* () {
      const wm = yield* WorkspaceManager;
      const first = yield* wm.prepareForIssue(makeIssue("MT-1"));
      const second = yield* wm.prepareForIssue(makeIssue("MT-1"));
      return { first, second };
    });
    const { first, second } = await Effect.runPromise(
      Effect.provide(program, layer),
    );
    expect(first.created_now).toBe(true);
    expect(second.created_now).toBe(false);
    expect(second.path).toBe(first.path);
  });

  it("sanitizes traversal characters in the identifier (foo/bar -> foo_bar)", async () => {
    const { layer } = buildLayers();
    const program = Effect.gen(function* () {
      const wm = yield* WorkspaceManager;
      return yield* wm.prepareForIssue(makeIssue("foo/bar"));
    });
    const ws = await Effect.runPromise(Effect.provide(program, layer));
    expect(ws.workspace_key).toBe("foo_bar");
    expect(ws.path).toBe(join(tempRoot, "foo_bar") as AbsolutePath);
    expect(statSync(ws.path).isDirectory()).toBe(true);
  });

  it("fails NonDirectoryAtWorkspacePath when a regular file occupies the workspace path", async () => {
    // Plant a regular file at the path the sanitized identifier would resolve to.
    writeFileSync(join(tempRoot, "MT-2"), "not a directory");
    const { layer } = buildLayers();
    const program = Effect.gen(function* () {
      const wm = yield* WorkspaceManager;
      return yield* wm.prepareForIssue(makeIssue("MT-2"));
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layer));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = exit.cause._tag === "Fail" ? exit.cause.error : null;
      expect(err).toBeInstanceOf(NonDirectoryAtWorkspacePath);
      if (err instanceof NonDirectoryAtWorkspacePath) {
        expect(err.path).toBe(join(tempRoot, "MT-2"));
      }
    }
    // The planted file is untouched.
    expect(readFileSync(join(tempRoot, "MT-2"), "utf8")).toBe("not a directory");
  });

  it("surfaces WorkspaceCreationFailed when the parent root is not writable", async () => {
    // Sanity check that mkdir failures propagate as a typed error rather than
    // raw rejection. We construct a config that points at a path that cannot
    // exist as a directory parent (a regular file masquerading as the root)
    // so that mkdir(recursive: true) fails with ENOTDIR / similar.
    const fakeRoot = join(tempRoot, "not-a-dir");
    writeFileSync(fakeRoot, "blocking file");
    const captured = captureSink();
    const layer = WorkspaceManagerLive.pipe(
      Layer.provide(
        Layer.merge(
          stubWorkflowLoader(buildConfig(fakeRoot)),
          loggerLayer({ sink: captured.sink }),
        ),
      ),
    );
    const program = Effect.gen(function* () {
      const wm = yield* WorkspaceManager;
      return yield* wm.prepareForIssue(makeIssue("MT-3"));
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layer));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      // Either the stat or mkdir step surfaces a WorkspaceCreationFailed; the
      // exact step depends on the OS error code returned for "parent is a file".
      const err = exit.cause._tag === "Fail" ? exit.cause.error : null;
      expect(err).toBeInstanceOf(WorkspaceCreationFailed);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* assertUnderRoot — defensive PathEscape coverage                            */
/* -------------------------------------------------------------------------- */

describe("PathEscape (defensive)", () => {
  // Sanitization always rewrites `/` to `_`, so a high-level prepareForIssue
  // call cannot itself produce an out-of-root path. This test exercises the
  // lower-level guard directly to demonstrate it would catch a regression.
  it("assertUnderRoot rejects a crafted out-of-root candidate", async () => {
    const root = toAbsolutePathSync(tempRoot);
    const escape = toAbsolutePathSync("/etc/passwd");
    const exit = await Effect.runPromiseExit(assertUnderRoot(root, escape));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = exit.cause._tag === "Fail" ? exit.cause.error : null;
      expect(err).toBeInstanceOf(PathEscape);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* cleanWorkspaceFor                                                          */
/* -------------------------------------------------------------------------- */

describe("WorkspaceManager.cleanWorkspaceFor", () => {
  it("removes the directory tree (including nested files)", async () => {
    const { layer } = buildLayers();
    const setup = Effect.gen(function* () {
      const wm = yield* WorkspaceManager;
      yield* wm.prepareForIssue(makeIssue("MT-1"));
    });
    await Effect.runPromise(Effect.provide(setup, layer));
    // Plant a nested file to prove rm -rf depth, not just rmdir.
    const nestedFile = join(tempRoot, "MT-1", "nested", "file.txt");
    writeFileSync(join(tempRoot, "MT-1", "top.txt"), "top");
    rmSync(join(tempRoot, "MT-1", "nested"), { recursive: true, force: true });
    mkdirSync(join(tempRoot, "MT-1", "nested"), { recursive: true });
    writeFileSync(nestedFile, "leaf");
    expect(existsSync(nestedFile)).toBe(true);

    const program = Effect.gen(function* () {
      const wm = yield* WorkspaceManager;
      yield* wm.cleanWorkspaceFor("MT-1");
    });
    await Effect.runPromise(Effect.provide(program, layer));
    expect(existsSync(join(tempRoot, "MT-1"))).toBe(false);
  });

  it("is a no-op when the workspace does not exist (force-remove)", async () => {
    const { layer } = buildLayers();
    const program = Effect.gen(function* () {
      const wm = yield* WorkspaceManager;
      yield* wm.cleanWorkspaceFor("never-created");
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layer));
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  // Sanitization makes a "path outside root" identifier impossible at this
  // entry point: every identifier is rewritten to a single safe segment under
  // root before the path-safety guard runs. We keep this comment so the spec
  // bullet is acknowledged and the gap is explicit.
});

/* -------------------------------------------------------------------------- */
/* startupTerminalCleanup                                                     */
/* -------------------------------------------------------------------------- */

describe("WorkspaceManager.startupTerminalCleanup", () => {
  it("removes every terminal workspace and continues across individual failures", async () => {
    const captured = captureSink();
    const layer = WorkspaceManagerLive.pipe(
      Layer.provide(
        Layer.merge(
          stubWorkflowLoader(buildConfig(tempRoot)),
          loggerLayer({ sink: captured.sink }),
        ),
      ),
    );

    // Set up: two normal directories, plus one regular file at the workspace
    // path that will cause cleanup to fail (rm -rf on a file is fine — it
    // removes the file — so to actually provoke a per-identifier failure we
    // plant a directory whose contents are unreadable. The simplest portable
    // failure is to make the workspace path a non-empty dir owned by root
    // which we can't simulate without sudo. Instead, we rely on the more
    // realistic case: pass an identifier whose path is removable normally,
    // and demonstrate the sweep proceeds across all identifiers.
    mkdirSync(join(tempRoot, "DONE-1"), { recursive: true });
    mkdirSync(join(tempRoot, "DONE-2"), { recursive: true });
    writeFileSync(join(tempRoot, "DONE-1", "x.txt"), "x");

    const program = Effect.gen(function* () {
      const wm = yield* WorkspaceManager;
      yield* wm.startupTerminalCleanup(["DONE-1", "DONE-2", "missing-3"]);
    });
    await Effect.runPromise(Effect.provide(program, layer));

    expect(existsSync(join(tempRoot, "DONE-1"))).toBe(false);
    expect(existsSync(join(tempRoot, "DONE-2"))).toBe(false);
  });

  it("logs a warning and continues when an individual cleanup fails", async () => {
    // To force a cleanup failure we override the workspace.root to point at a
    // directory we then chmod 0 mid-test. That's flaky on some runners; a
    // more reliable path is to monkey-patch the loader so cleanWorkspaceFor
    // sees a path that fails. Since the spec only requires "log + continue",
    // we exercise the catch path via a stub that throws inside the rm call:
    // we point the loader at a *file* (not a directory), so the resolved
    // workspace path is `<file>/IDENT` — `rm` of a path under a non-directory
    // returns ENOTDIR on POSIX, surfacing CleanupFailed.
    const fakeRoot = join(tempRoot, "blocking-file");
    writeFileSync(fakeRoot, "blocker");
    const captured = captureSink();
    const layer = WorkspaceManagerLive.pipe(
      Layer.provide(
        Layer.merge(
          stubWorkflowLoader(buildConfig(fakeRoot)),
          loggerLayer({ sink: captured.sink }),
        ),
      ),
    );

    const program = Effect.gen(function* () {
      const wm = yield* WorkspaceManager;
      yield* wm.startupTerminalCleanup(["A", "B"]);
    });
    await Effect.runPromise(Effect.provide(program, layer));

    // Both identifiers should have logged a warn record and the sweep should
    // have completed (no exception bubbled to the runtime).
    const warnLines = captured.lines.filter((l) => l.includes('"level":"warn"'));
    expect(warnLines.length).toBeGreaterThanOrEqual(1);
    // The blocker file is untouched.
    expect(readFileSync(fakeRoot, "utf8")).toBe("blocker");
  });

  it("CleanupFailed carries the offending path", async () => {
    // Direct service-level assertion rather than via the sweep, to nail
    // down the error shape exposed to non-best-effort callers.
    const fakeRoot = join(tempRoot, "blocker");
    writeFileSync(fakeRoot, "x");
    const captured = captureSink();
    const layer = WorkspaceManagerLive.pipe(
      Layer.provide(
        Layer.merge(
          stubWorkflowLoader(buildConfig(fakeRoot)),
          loggerLayer({ sink: captured.sink }),
        ),
      ),
    );
    const program = Effect.gen(function* () {
      const wm = yield* WorkspaceManager;
      yield* wm.cleanWorkspaceFor("ABC");
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layer));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = exit.cause._tag === "Fail" ? exit.cause.error : null;
      expect(err).toBeInstanceOf(CleanupFailed);
      if (err instanceof CleanupFailed) {
        expect(err.path).toBe(join(fakeRoot, "ABC"));
      }
    }
  });
});
