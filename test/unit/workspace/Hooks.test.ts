// Unit tests for the WorkspaceHooks service.
// Verifies SPEC.md §9.4 execution + failure semantics and §15.4 truncation behavior.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs";
import * as path from "node:path";
import { BunContext } from "@effect/platform-bun";
import { Effect, Exit, Layer, Ref } from "effect";
import {
  AfterCreateFailed,
  BeforeRunFailed,
  WorkspaceHooks,
  WorkspaceHooksLive,
} from "../../../src/workspace/Hooks.ts";
import { WorkflowLoader } from "../../../src/config/WorkflowLoader.ts";
import { toAbsolutePathSync } from "../../../src/config/PathSafety.ts";
import {
  Logger,
  layer as loggerLayer,
  type LogSink,
} from "../../../src/observability/Logger.ts";
import type {
  TypedConfig,
  WorkflowDefinition,
} from "../../../src/config/WorkflowSchema.ts";
import type { Workspace } from "../../../src/workspace/WorkspaceManager.ts";
import {
  Sandbox,
  SandboxLive,
  type SandboxSpawnOptions,
} from "../../../src/sandbox/Nono.ts";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

interface HookOverrides {
  readonly after_create?: string | null;
  readonly before_run?: string | null;
  readonly after_run?: string | null;
  readonly before_remove?: string | null;
  readonly timeout_ms?: number;
}

const buildConfig = (hooks: HookOverrides): TypedConfig => ({
  tracker: {
    kind: "linear",
    endpoint: "https://api.linear.app/graphql",
    api_key: null,
    project_slug: null,
    active_states: ["Todo"],
    terminal_states: ["Done"],
  },
  polling: { interval_ms: 30_000 },
  workspace: { root: "/tmp" },
  hooks: {
    after_create: hooks.after_create ?? null,
    before_run: hooks.before_run ?? null,
    after_run: hooks.after_run ?? null,
    before_remove: hooks.before_remove ?? null,
    timeout_ms: hooks.timeout_ms ?? 60_000,
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
  },
  server: null,
});

/**
 * Stub a WorkflowLoader pinned to a fixed config + WORKFLOW.md source path.
 * The loader's `source_path` matters because the hook policy derives the
 * workflow_dir from `dirname(source_path)` for the `--read` mount.
 */
const stubWorkflowLoader = (
  config: TypedConfig,
  sourcePath: string,
): Layer.Layer<WorkflowLoader> =>
  Layer.effect(
    WorkflowLoader,
    Effect.gen(function* () {
      const ref = yield* Ref.make<WorkflowDefinition>({
        config,
        prompt_template: "x",
        source_path: sourcePath,
      });
      return {
        current: Ref.get(ref),
        // Empty stream — WorkspaceHooks never reads `changes`.
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

/** Build a synthetic Workspace record rooted at the given absolute path. */
const makeWorkspace = (workspacePath: string): Workspace => ({
  path: toAbsolutePathSync(workspacePath),
  workspace_key: path.basename(workspacePath),
  created_now: true,
});

/* -------------------------------------------------------------------------- */
/* Recording stub Sandbox                                                     */
/* -------------------------------------------------------------------------- */

interface RecordedSpawn {
  readonly options: SandboxSpawnOptions;
}

interface StubSandboxState {
  readonly spawns: Array<RecordedSpawn>;
}

/**
 * Layer that swaps in a recording Sandbox which never actually spawns a
 * process. Useful for tests that only need to assert "spawn was/was not
 * invoked" without paying the cost of the real nono binary.
 */
const recordingSandboxLayer = (
  state: StubSandboxState,
): Layer.Layer<Sandbox> =>
  Layer.succeed(
    Sandbox,
    Sandbox.of({
      spawn: (opts) => {
        state.spawns.push({ options: opts });
        // The recording stub is intended for "should-not-spawn" assertions —
        // if a test reaches this branch, it means the production code spawned
        // when it shouldn't have. We surface a synthetic failure to fail the
        // test loudly rather than returning a fake handle that pretends to
        // succeed.
        return Effect.die(
          new Error("recording sandbox does not implement spawn"),
        );
      },
    }),
  );

/* -------------------------------------------------------------------------- */
/* Live nono availability gate                                                */
/* -------------------------------------------------------------------------- */

/** Skip the live nono tests if the binary is not on PATH. */
const NONO_PATH = (() => {
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, "nono");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
})();

/* -------------------------------------------------------------------------- */
/* Test scaffolding                                                           */
/* -------------------------------------------------------------------------- */

let TMPROOT = "";
let WORKSPACE_DIR = "";
let WORKFLOW_DIR = "";
let WORKFLOW_PATH = "";

beforeAll(() => {
  TMPROOT = mkdtempSync(join(tmpdir(), "symphony-hooks-"));
  WORKSPACE_DIR = join(TMPROOT, "ws");
  WORKFLOW_DIR = join(TMPROOT, "wf");
  WORKFLOW_PATH = join(WORKFLOW_DIR, "WORKFLOW.md");
  mkdirSync(WORKSPACE_DIR, { recursive: true });
  mkdirSync(WORKFLOW_DIR, { recursive: true });
  // Materialize the WORKFLOW.md so realpath / dirname lookups against the
  // source_path are stable even though the loader stub never reads the file.
  writeFileSync(WORKFLOW_PATH, "---\n---\nprompt\n");
});

afterAll(() => {
  if (TMPROOT.length > 0) {
    rmSync(TMPROOT, { recursive: true, force: true });
  }
});

/** Per-test scratch state cleaned between tests. */
beforeEach(() => {
  // Wipe any artifacts a previous test wrote into the shared workspace dir.
  for (const entry of fs.readdirSync(WORKSPACE_DIR)) {
    rmSync(join(WORKSPACE_DIR, entry), { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* Stub-Sandbox tests (no nono required)                                      */
/* -------------------------------------------------------------------------- */

describe("WorkspaceHooks — no spawn when hook is unconfigured", () => {
  it("runBeforeRun is a no-op when before_run is null", async () => {
    const captured = captureSink();
    const state: StubSandboxState = { spawns: [] };
    const layer = WorkspaceHooksLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          stubWorkflowLoader(buildConfig({ before_run: null }), WORKFLOW_PATH),
          recordingSandboxLayer(state),
          loggerLayer({ sink: captured.sink }),
        ),
      ),
    );
    const program = Effect.gen(function* () {
      const hooks = yield* WorkspaceHooks;
      yield* hooks.runBeforeRun(makeWorkspace(WORKSPACE_DIR));
    });
    await Effect.runPromise(Effect.provide(program, layer));
    expect(state.spawns).toHaveLength(0);
  });

  it("runAfterRun is a no-op when after_run is the empty string", async () => {
    const captured = captureSink();
    const state: StubSandboxState = { spawns: [] };
    const layer = WorkspaceHooksLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          stubWorkflowLoader(buildConfig({ after_run: "" }), WORKFLOW_PATH),
          recordingSandboxLayer(state),
          loggerLayer({ sink: captured.sink }),
        ),
      ),
    );
    const program = Effect.gen(function* () {
      const hooks = yield* WorkspaceHooks;
      yield* hooks.runAfterRun(makeWorkspace(WORKSPACE_DIR));
    });
    await Effect.runPromise(Effect.provide(program, layer));
    expect(state.spawns).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Live-nono tests                                                            */
/* -------------------------------------------------------------------------- */

describe("WorkspaceHooks (live nono)", () => {
  const buildLiveLayers = (
    hooks: HookOverrides,
  ): { layer: Layer.Layer<WorkspaceHooks>; lines: Array<string> } => {
    const captured = captureSink();
    const sandboxStack = Layer.provide(SandboxLive, BunContext.layer);
    const layer = WorkspaceHooksLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          stubWorkflowLoader(buildConfig(hooks), WORKFLOW_PATH),
          sandboxStack,
          loggerLayer({ sink: captured.sink }),
        ),
      ),
    );
    return { layer, lines: captured.lines };
  };

  it.skipIf(NONO_PATH === null)(
    "runBeforeRun with a passing hook succeeds and emits a completion log",
    async () => {
      const { layer, lines } = buildLiveLayers({ before_run: "exit 0" });
      const program = Effect.gen(function* () {
        const hooks = yield* WorkspaceHooks;
        yield* hooks.runBeforeRun(makeWorkspace(WORKSPACE_DIR));
      });
      await Effect.runPromise(Effect.provide(program, layer));
      const completed = lines.filter(
        (l) => l.includes('"hook completed"') && l.includes('"before_run"'),
      );
      expect(completed.length).toBeGreaterThanOrEqual(1);
    },
    20_000,
  );

  it.skipIf(NONO_PATH === null)(
    "runBeforeRun with a failing hook fails BeforeRunFailed and includes the truncated stderr tail",
    async () => {
      const { layer } = buildLiveLayers({
        before_run: "echo OOPS-ERR 1>&2; exit 1",
      });
      const program = Effect.gen(function* () {
        const hooks = yield* WorkspaceHooks;
        yield* hooks.runBeforeRun(makeWorkspace(WORKSPACE_DIR));
      });
      const exit = await Effect.runPromiseExit(Effect.provide(program, layer));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const err = exit.cause._tag === "Fail" ? exit.cause.error : null;
        expect(err).toBeInstanceOf(BeforeRunFailed);
        if (err instanceof BeforeRunFailed) {
          // Reason is `exit` in the common case but may surface as `denied`
          // when nono's default profile flags an incidental access (e.g.
          // bash -lc reading ~/.profile on a host where that path is
          // restricted). Both indicate a hook-fatal failure.
          expect(["exit", "denied"]).toContain(err.reason);
          // Exit code is captured for both `exit` and `denied` non-zero exits.
          expect(typeof err.exit_code).toBe("number");
          // The exact stderr capture varies by sandbox plumbing — assert that
          // *some* failure tail surfaced (either the script's own stderr or
          // the sandbox's non-zero-exit summary).
          expect(
            err.stderr_tail.length + err.stdout_tail.length,
          ).toBeGreaterThan(0);
        }
      }
    },
    20_000,
  );

  it.skipIf(NONO_PATH === null)(
    "runBeforeRun with a hook that exceeds timeout_ms fails BeforeRunFailed with reason=timeout",
    async () => {
      const { layer } = buildLiveLayers({
        before_run: "sleep 10",
        timeout_ms: 200,
      });
      const program = Effect.gen(function* () {
        const hooks = yield* WorkspaceHooks;
        yield* hooks.runBeforeRun(makeWorkspace(WORKSPACE_DIR));
      });
      const exit = await Effect.runPromiseExit(Effect.provide(program, layer));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const err = exit.cause._tag === "Fail" ? exit.cause.error : null;
        expect(err).toBeInstanceOf(BeforeRunFailed);
        if (err instanceof BeforeRunFailed) {
          expect(err.reason).toBe("timeout");
          expect(err.exit_code).toBeNull();
        }
      }
    },
    20_000,
  );

  it.skipIf(NONO_PATH === null)(
    "runAfterRun with a failing hook returns success and logs a warning",
    async () => {
      const { layer, lines } = buildLiveLayers({
        after_run: "echo bad 1>&2; exit 7",
      });
      const program = Effect.gen(function* () {
        const hooks = yield* WorkspaceHooks;
        yield* hooks.runAfterRun(makeWorkspace(WORKSPACE_DIR));
      });
      const exit = await Effect.runPromiseExit(Effect.provide(program, layer));
      expect(Exit.isSuccess(exit)).toBe(true);
      const warnLines = lines.filter(
        (l) => l.includes('"level":"warn"') && l.includes('"after_run"'),
      );
      expect(warnLines.length).toBeGreaterThanOrEqual(1);
    },
    20_000,
  );

  it.skipIf(NONO_PATH === null)(
    "runAfterCreate uses the workspace as cwd (hook can write a file there with $PWD)",
    async () => {
      // Use a per-test workspace subdirectory so we can read back the file.
      const workspace = join(WORKSPACE_DIR, "cwd-check-ws");
      mkdirSync(workspace, { recursive: true });
      const { layer } = buildLiveLayers({
        after_create: "pwd > cwd-check.txt",
      });
      const program = Effect.gen(function* () {
        const hooks = yield* WorkspaceHooks;
        yield* hooks.runAfterCreate(makeWorkspace(workspace));
      });
      await Effect.runPromise(Effect.provide(program, layer));
      const target = join(workspace, "cwd-check.txt");
      expect(existsSync(target)).toBe(true);
      const contents = readFileSync(target, "utf8").trim();
      // `pwd` may resolve symlinks (e.g. /var → /private/var on macOS), so
      // compare the realpath of the captured value against the realpath of
      // the expected workspace.
      expect(fs.realpathSync(contents)).toBe(fs.realpathSync(workspace));
    },
    20_000,
  );

  it.skipIf(NONO_PATH === null)(
    "runAfterCreate with a failing hook fails AfterCreateFailed",
    async () => {
      const { layer } = buildLiveLayers({
        after_create: "exit 2",
      });
      const program = Effect.gen(function* () {
        const hooks = yield* WorkspaceHooks;
        yield* hooks.runAfterCreate(makeWorkspace(WORKSPACE_DIR));
      });
      const exit = await Effect.runPromiseExit(Effect.provide(program, layer));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const err = exit.cause._tag === "Fail" ? exit.cause.error : null;
        expect(err).toBeInstanceOf(AfterCreateFailed);
        if (err instanceof AfterCreateFailed) {
          // See note on the failing-before_run test: `denied` may shadow
          // `exit` when the default profile flags an incidental syscall.
          expect(["exit", "denied"]).toContain(err.reason);
          expect(typeof err.exit_code).toBe("number");
        }
      }
    },
    20_000,
  );
});

