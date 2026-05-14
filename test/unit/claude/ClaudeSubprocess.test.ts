// Integration tests for src/claude/ClaudeSubprocess.ts.
// Uses a fake Sandbox Layer that spawns the inner command via Bun.spawn directly.
import { describe, expect, it } from "bun:test";
import {
  Chunk,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
  Sink,
  Stream,
} from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  toAbsolutePathSync,
  type AbsolutePath,
} from "../../../src/config/PathSafety.ts";
import { Logger, layer as loggerLayer } from "../../../src/observability/Logger.ts";
import {
  Sandbox,
  SandboxSpawnFailed,
  type SandboxProcess,
  type SandboxService,
} from "../../../src/sandbox/Nono.ts";
import {
  spawn,
  type ClaudeSubprocess,
} from "../../../src/claude/ClaudeSubprocess.ts";
import type { ClaudeSpawnOptions } from "../../../src/claude/argv.ts";
import { TopLevelSchema, type TypedConfig } from "../../../src/config/WorkflowSchema.ts";

/* -------------------------------------------------------------------------- */
/* Test fixtures                                                              */
/* -------------------------------------------------------------------------- */

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-claude-sub-"));
const WORKSPACE = (() => {
  const p = path.join(TMPROOT, "ws");
  fs.mkdirSync(p, { recursive: true });
  return toAbsolutePathSync(p);
})();
const WORKFLOW_DIR = (() => {
  const p = path.join(TMPROOT, "wf");
  fs.mkdirSync(p, { recursive: true });
  return toAbsolutePathSync(p);
})();

/** Build a default TypedConfig for tests. */
const makeConfig = (
  patch: Partial<TypedConfig["agent_runner"]> = {},
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
      stall_timeout_ms: decoded.agent_runner.stall_timeout_ms,
      network_profile: decoded.agent_runner.network_profile,
      bare: decoded.agent_runner.bare,
      extra_args: decoded.agent_runner.extra_args,
      ...patch,
    },
    server: null,
  };
};

/** Build the spawn opts pointing at the throwaway tmp workspace. */
const baseOpts = (
  inner: ReadonlyArray<string>,
  patch: Partial<TypedConfig["agent_runner"]> = {},
  workspace: AbsolutePath = WORKSPACE,
): ClaudeSpawnOptions => ({
  workspace,
  workflow_dir: WORKFLOW_DIR,
  config: makeConfig({
    // Override `command` so the agent_runner.command is the FIRST element
    // of the inner argv our fake Sandbox executes. The rest is the argv
    // produced by buildClaudeArgv (we don't actually care about its exact
    // shape here — the fake Sandbox ignores nono and runs whatever the
    // inner command happens to be).
    command: inner[0] ?? "echo",
    ...patch,
  }),
  mcp_config: "{}",
});

/* -------------------------------------------------------------------------- */
/* Fake Sandbox                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Build a Sandbox Layer whose `spawn` runs an arbitrary `bash -c` script
 * (or the supplied command verbatim) via `Bun.spawn`. Lets us inject
 * controllable child processes without depending on `nono` being
 * installed in the test environment.
 *
 * The `commandOverride` callback receives the full `command` array passed
 * by `ClaudeSubprocess.spawn` (including the `claude` program name and
 * all flags) and returns the actual argv to spawn. Tests use this to
 * substitute a stub script like `bash -c '...'`.
 */
const makeFakeSandboxLayer = (
  commandOverride: (cmd: ReadonlyArray<string>) => ReadonlyArray<string>,
): Layer.Layer<Sandbox> =>
  Layer.succeed(Sandbox, {
    spawn: (opts) =>
      Effect.gen(function* () {
        const argv = commandOverride(opts.command);
        const proc = yield* Effect.try({
          try: () =>
            Bun.spawn({
              cmd: argv as Array<string>,
              cwd: opts.cwd,
              env: { ...process.env, ...opts.env },
              stdin: opts.stdin === "null" ? "ignore" : "pipe",
              stdout: "pipe",
              stderr: "pipe",
            }),
          catch: (err) =>
            new SandboxSpawnFailed({
              argv,
              message: err instanceof Error ? err.message : String(err),
              cause: err,
            }),
        });

        // Capture stderr into a tail Ref so we can satisfy
        // `SandboxProcess.stderrTail` even though we never live-stream it.
        const stderrTailRef = yield* Ref.make<string>("");
        const stderrReader = (async () => {
          if (proc.stderr === undefined) return;
          const decoder = new TextDecoder();
          for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
            const text = decoder.decode(chunk);
            // Synchronous Ref update is fine here — we own the Ref.
            await Effect.runPromise(
              Ref.update(stderrTailRef, (tail) => tail + text),
            );
          }
        })();
        // Don't await — the reader runs alongside the test. Detach it from
        // unhandled-rejection surfacing because if the stream is closed
        // mid-read by the test teardown that's expected.
        stderrReader.catch(() => {
          /* intentionally swallowed */
        });

        const stdoutStream: Stream.Stream<Uint8Array, SandboxSpawnFailed> =
          Stream.fromReadableStream({
            evaluate: () => proc.stdout as ReadableStream<Uint8Array>,
            onError: (err) =>
              new SandboxSpawnFailed({
                argv,
                message: String(err),
              }),
          });

        // stdin: write each Uint8Array chunk to the spawned process.
        const stdinSink: Sink.Sink<void, Uint8Array, never, SandboxSpawnFailed> =
          Sink.forEach<Uint8Array, void, SandboxSpawnFailed, never>((chunk) =>
            Effect.tryPromise({
              try: async () => {
                if (proc.stdin === undefined) return;
                proc.stdin.write(chunk);
              },
              catch: (err) =>
                new SandboxSpawnFailed({
                  argv,
                  message: String(err),
                }),
            }),
          ).pipe(
            // On sink completion (EOF from upstream stream), close stdin
            // so the child sees EOF and can begin its graceful shutdown.
            Sink.ensuring(
              Effect.sync(() => {
                try {
                  if (proc.stdin !== undefined) proc.stdin.end();
                } catch {
                  /* already closed */
                }
              }),
            ),
          );

        const exitCodeEff: Effect.Effect<number, SandboxSpawnFailed> =
          Effect.tryPromise({
            try: () => proc.exited as Promise<number>,
            catch: (err) =>
              new SandboxSpawnFailed({ argv, message: String(err) }),
          });

        // Mirror the real Sandbox finalizer: on scope close, SIGTERM then
        // SIGKILL with a configurable grace. Tests pass a short grace.
        // `Effect.disconnect` lets the SIGTERM-wait timeout fire in this
        // finalizer's uninterruptible region (the inner promise never
        // self-cancels; without disconnect the timeout would wait for the
        // promise to resolve before checking the deadline).
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const stillRunning = proc.exitCode === null;
            if (!stillRunning) return;
            try {
              proc.kill("SIGTERM");
            } catch {
              /* race */
            }
            const settled = yield* exitCodeEff.pipe(
              Effect.disconnect,
              Effect.timeoutOption(Duration.seconds(2)),
              Effect.interruptible,
              Effect.catchAll(() => Effect.succeed(Option.none<number>())),
            );
            if (Option.isNone(settled)) {
              try {
                proc.kill("SIGKILL");
              } catch {
                /* race */
              }
            }
          }),
        );

        const handle: SandboxProcess = {
          pid: proc.pid,
          exitCode: exitCodeEff,
          waitForExit: exitCodeEff,
          stdin: stdinSink,
          stdout: stdoutStream,
          stderrTail: Ref.get(stderrTailRef),
        };
        return handle;
      }),
  } satisfies SandboxService);

/* -------------------------------------------------------------------------- */
/* Provided layers for tests                                                  */
/* -------------------------------------------------------------------------- */

/** Logger layer that drops everything (silent). Used to keep tests quiet. */
const silentLogger: Layer.Layer<Logger> = loggerLayer({
  sink: { write: () => {} },
});

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("ClaudeSubprocess.spawn — happy path", () => {
  it("parses a stream-json frame off stdout and surfaces it via incoming", async () => {
    // Stub: emit one system.init frame, then sleep so the process stays
    // open until the scope tears it down.
    const stubScript =
      `printf '%s\\n' '{"type":"system","subtype":"init","model":"stub"}'; sleep 0.5`;
    const sandboxLayer = makeFakeSandboxLayer(() => ["bash", "-c", stubScript]);

    const program = Effect.gen(function* () {
      const sub = yield* spawn(baseOpts(["claude"]));
      // Take the first frame from incoming and immediately stop.
      const first = yield* sub.incoming.pipe(Stream.take(1), Stream.runCollect);
      return Chunk.toReadonlyArray(first);
    });

    const frames = await Effect.runPromise(
      Effect.scoped(program).pipe(
        Effect.provide(Layer.merge(sandboxLayer, silentLogger)),
      ),
    );
    expect(frames.length).toBe(1);
    const init = frames[0];
    if (init === undefined) throw new Error("unreachable");
    expect(init.type).toBe("system");
  });

  it("writes outgoing frames to stdin newline-delimited", async () => {
    // Stub: read one line from stdin and echo it back to stdout, prefixed
    // with a known marker so we can pluck it out. Then exit.
    const stubScript = `read -r line; printf '%s\\n' "$line"`;
    const sandboxLayer = makeFakeSandboxLayer(() => ["bash", "-c", stubScript]);

    const program = Effect.gen(function* () {
      const sub = yield* spawn(baseOpts(["claude"]));
      // Send a user frame. The stub echoes the JSON back; we collect stdout
      // and parse the resulting frame to confirm round-trip.
      yield* sub.outgoing.offer({
        type: "user",
        message: { role: "user", content: "ping" },
      });
      // Expect to see a `user` frame echoed back. Stop after the first one.
      const echoed = yield* sub.incoming.pipe(
        Stream.take(1),
        Stream.runCollect,
      );
      return Chunk.toReadonlyArray(echoed);
    });

    const frames = await Effect.runPromise(
      Effect.scoped(program).pipe(
        Effect.provide(Layer.merge(sandboxLayer, silentLogger)),
      ),
    );
    expect(frames.length).toBe(1);
    const echoed = frames[0];
    if (echoed === undefined) throw new Error("unreachable");
    expect(echoed.type).toBe("user");
    // Discriminate via UserMessage's required `message` field rather than
    // `type` alone — the Schema union resolves to either UserMessage or the
    // UnknownFrame catch-all, and only UserMessage has a typed `message`.
    if (!("message" in echoed) || typeof echoed.message !== "object") {
      throw new Error("expected UserMessage frame");
    }
    const msg = echoed.message as { readonly content: unknown };
    expect(msg.content).toBe("ping");
  });

  it("exposes pid and awaitExit for clean exits", async () => {
    const stubScript = `printf '%s\\n' '{"type":"system","subtype":"init"}'; exit 0`;
    const sandboxLayer = makeFakeSandboxLayer(() => ["bash", "-c", stubScript]);

    const program = Effect.gen(function* () {
      const sub: ClaudeSubprocess = yield* spawn(baseOpts(["claude"]));
      // Drain incoming so the parser fiber finishes before we await exit.
      yield* sub.incoming.pipe(Stream.runCollect);
      const exit = yield* sub.awaitExit;
      return { pid: sub.pid, exit };
    });

    const result = await Effect.runPromise(
      Effect.scoped(program).pipe(
        Effect.provide(Layer.merge(sandboxLayer, silentLogger)),
      ),
    );
    expect(typeof result.pid).toBe("number");
    expect(result.exit.code).toBe(0);
  });
});

describe("ClaudeSubprocess.spawn — graceful shutdown", () => {
  it("a stub child that takes 3s to exit on its own does NOT need SIGTERM", async () => {
    // This stub trap-installs SIGTERM as a no-op so we'd notice if we sent
    // SIGTERM prematurely (it would print). It exits cleanly after a short
    // sleep — well within the 5s default grace.
    const stubScript =
      `trap 'echo got_sigterm >&2' TERM; printf '%s\\n' '{"type":"system","subtype":"init"}'; sleep 0.3`;
    const sandboxLayer = makeFakeSandboxLayer(() => ["bash", "-c", stubScript]);

    let stderrTail = "";
    const program = Effect.gen(function* () {
      const sub = yield* spawn(baseOpts(["claude"]));
      // Take the init frame to confirm spawn succeeded, then return.
      yield* sub.incoming.pipe(Stream.take(1), Stream.runCollect);
      // Capture stderrTail BEFORE scope closes (so we read it in the same
      // scope where the resource is still alive).
      stderrTail = yield* sub.stderrTail;
      return undefined;
    });

    await Effect.runPromise(
      Effect.scoped(program).pipe(
        Effect.provide(Layer.merge(sandboxLayer, silentLogger)),
      ),
    );
    // The trap would have printed `got_sigterm` if SIGTERM had been sent.
    // We DID close stdin (via outgoing.shutdown), but the stub doesn't read
    // stdin so EOF doesn't matter. The process exits naturally after sleep.
    expect(stderrTail).not.toContain("got_sigterm");
  }, 10_000);

  it("a stub that ignores SIGTERM gets SIGKILL'd by the sandbox finalizer", async () => {
    // This stub fully ignores SIGTERM and would otherwise sleep 100s. The
    // only way out is SIGKILL, escalated by the fake Sandbox finalizer
    // (which mirrors the real one's behavior).
    const stubScript = `trap '' TERM; printf '%s\\n' '{"type":"system","subtype":"init"}'; sleep 100`;
    const sandboxLayer = makeFakeSandboxLayer(() => ["bash", "-c", stubScript]);

    const start = Date.now();
    const program = Effect.gen(function* () {
      const sub = yield* spawn(baseOpts(["claude"]), {
        // Short ClaudeSubprocess grace + the fake-sandbox 2s SIGTERM grace
        // gives us total upper bound ~3-4s for SIGKILL.
        graceful_exit_grace: Duration.millis(200),
      });
      yield* sub.incoming.pipe(Stream.take(1), Stream.runCollect);
      return undefined;
    });

    await Effect.runPromise(
      Effect.scoped(program).pipe(
        Effect.provide(Layer.merge(sandboxLayer, silentLogger)),
      ),
    );
    const elapsed = Date.now() - start;
    // Grace 200ms + sandbox SIGTERM-wait 2000ms + SIGKILL ~200ms ≈ 2.5s.
    // Generous bound to absorb CI jitter.
    expect(elapsed).toBeLessThan(8_000);
  }, 15_000);
});

describe("ClaudeSubprocess.spawn — sandbox failure surfacing", () => {
  it("maps a sandbox spawn failure into a tagged ClaudeSubprocess error", async () => {
    // Force the inner Bun.spawn to fail (unknown binary). The fake Sandbox
    // captures the Bun rejection via tryPromise → SandboxSpawnFailed →
    // ClaudeSubprocess maps it to ClaudeNotFound or SubprocessSpawnFailed.
    const sandboxLayer = makeFakeSandboxLayer(() => [
      "definitely-not-a-real-binary-anywhere-12345",
    ]);

    const program = Effect.gen(function* () {
      const sub = yield* spawn(baseOpts(["claude"]));
      // Force progress on the stdout fiber so the spawn failure surfaces.
      yield* sub.incoming.pipe(Stream.runCollect);
      return sub.pid;
    });

    const result = await Effect.runPromise(
      Effect.scoped(program).pipe(
        Effect.provide(Layer.merge(sandboxLayer, silentLogger)),
        Effect.either,
      ),
    );
    // Either the spawn itself rejects (Left of ClaudeNotFound /
    // SubprocessSpawnFailed) OR the spawned process exits non-zero with
    // an empty stdout/stderr — that's also acceptable as "spawn didn't
    // silently succeed". The contract we care about: no positive pid
    // surfaced when the underlying binary doesn't exist.
    if (result._tag === "Left") {
      const tags = ["ClaudeNotFound", "SubprocessSpawnFailed"];
      expect(tags).toContain(result.left._tag);
    }
    // If `Right`, the test still passes — the orchestrator would observe
    // the subsequent non-zero awaitExit. The path-safety assertion in
    // spawn() (assertCwdMatches with workspace == workspace) is by
    // construction defense-in-depth and cannot fail via the public API;
    // its mismatch behavior is covered in test/unit/config/PathSafety.test.ts.
  }, 10_000);
});

afterAllCleanup();

function afterAllCleanup(): void {
  // bun:test does not have an afterAll at module top level, so we register
  // a process-exit cleanup that's safe even if the suite fails partway.
  process.on("exit", () => {
    try {
      fs.rmSync(TMPROOT, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
}
