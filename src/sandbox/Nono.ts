// Sandbox service: wraps arbitrary commands in `nono run` with a Symphony policy.
// Returns a Scope-bound process handle with stdin sink, stdout stream, stderr tail, exit-code Effect.
import { Command, CommandExecutor } from "@effect/platform";
import {
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Scope,
  Sink,
  Stream,
} from "effect";
import type { AbsolutePath } from "../config/PathSafety.ts";
import { policyArgv, type SandboxPolicy } from "./policies.ts";

export type { SandboxPolicy } from "./policies.ts";

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Raised when the `nono` binary cannot be spawned at all (PATH miss,
 * permission error, missing exec bit, etc.). Distinct from `AccessDenied`
 * so callers can tell "sandbox infrastructure is broken" from "the inner
 * command tried to do something the policy forbids".
 */
export class SandboxSpawnFailed extends Data.TaggedError("SandboxSpawnFailed")<{
  readonly argv: ReadonlyArray<string>;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Best-effort signal that the sandbox refused a syscall. Detection is
 * heuristic — see `detectSandboxDenied` for the patterns we look for. The
 * `denial` field carries the raw stderr line(s) we matched on so callers
 * can re-surface them in operator logs.
 */
export class SandboxAccessDenied extends Data.TaggedError("SandboxAccessDenied")<{
  readonly argv: ReadonlyArray<string>;
  readonly exitCode: number;
  readonly denial: string;
}> {}

/**
 * The nono process exited with a non-zero exit code that doesn't look like
 * a sandbox denial. The `stderrTail` is a (truncated) snapshot of the most
 * recent stderr captured for diagnostic surfacing.
 */
export class SandboxNonZeroExit extends Data.TaggedError("SandboxNonZeroExit")<{
  readonly argv: ReadonlyArray<string>;
  readonly exitCode: number;
  readonly stderrTail: string;
}> {}

/** Discriminated union of every error this service raises. */
export type SandboxError =
  | SandboxSpawnFailed
  | SandboxAccessDenied
  | SandboxNonZeroExit;

/* -------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Options accepted by `Sandbox.spawn`. `command` is the inner argv (the
 * thing that runs *inside* the sandbox); the `nono run …` prefix is built
 * from `policy` by the service.
 */
export interface SandboxSpawnOptions {
  readonly command: ReadonlyArray<string>;
  readonly cwd: AbsolutePath;
  readonly policy: SandboxPolicy;
  readonly env: Record<string, string>;
  readonly stdin?: "pipe" | "inherit" | "null";
}

/* -------------------------------------------------------------------------- */
/* Output                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Scope-bound handle returned by `Sandbox.spawn`. Mirrors the shape of
 * `@effect/platform`'s `Process` but narrowed to the parts callers need and
 * with our typed `SandboxError` on `exitCode`/`waitForExit` so denial
 * detection surfaces as a typed failure instead of a generic `PlatformError`.
 *
 * `exitCode` resolves with the raw exit code; `waitForExit` runs the same
 * wait but raises `SandboxAccessDenied` / `SandboxNonZeroExit` if the
 * process exited unhealthily. Callers that just want "did this finish?"
 * use `exitCode`; callers that want "was this clean?" use `waitForExit`.
 */
export interface SandboxProcess {
  readonly pid: number;
  /** Resolves with the raw exit code (no failure on non-zero). */
  readonly exitCode: Effect.Effect<number, SandboxSpawnFailed>;
  /**
   * Resolves with the raw exit code on a clean exit (code 0). Fails with a
   * tagged `SandboxAccessDenied` if stderr matches a denial pattern, else
   * `SandboxNonZeroExit` for any other non-zero exit. Spawn-time errors
   * surface as `SandboxSpawnFailed`.
   */
  readonly waitForExit: Effect.Effect<number, SandboxError>;
  /** Stdin sink. Use with `Stream.run(input, proc.stdin)`. */
  readonly stdin: Sink.Sink<void, Uint8Array, never, SandboxSpawnFailed>;
  /** Stdout chunks. Lines/JSON parsing is the caller's responsibility. */
  readonly stdout: Stream.Stream<Uint8Array, SandboxSpawnFailed>;
  /**
   * Snapshot of the most recent ~8 KiB of stderr the child has produced.
   * Sandbox internally drains the underlying stderr stream into a rolling
   * tail (so denial detection always sees the bytes); we expose that
   * tail rather than a fresh Stream because the underlying readable is
   * single-consumer. Callers that need a per-line stderr feed should
   * keep a custom Stream sink wired in via the worker layer once that
   * pattern is established.
   */
  readonly stderrTail: Effect.Effect<string>;
}

/* -------------------------------------------------------------------------- */
/* Service Tag                                                                */
/* -------------------------------------------------------------------------- */

export interface SandboxService {
  readonly spawn: (
    opts: SandboxSpawnOptions,
  ) => Effect.Effect<SandboxProcess, SandboxError, Scope.Scope>;
}

export class Sandbox extends Context.Tag("symphony/sandbox/Sandbox")<
  Sandbox,
  SandboxService
>() {}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Default grace period between SIGTERM and SIGKILL on scope shutdown. The
 * spec calls out 5s as the default; expose `makeSandbox` so tests can
 * shorten it for the cancellation-termination test.
 */
export const DEFAULT_SHUTDOWN_GRACE = Duration.seconds(5);

/** How much stderr we keep in memory for denial pattern matching + reporting. */
const STDERR_TAIL_BYTES = 8 * 1024;

/**
 * Heuristic: does the captured stderr text look like a `nono` denial line?
 * The public docs don't enumerate the exact denial output; we look for the
 * tokens nono uses on macOS Seatbelt and Linux Landlock denial paths.
 *
 * If you find a stderr shape that should be classified as denial but isn't,
 * extend the patterns here — false negatives are tolerable (caller still
 * sees the non-zero exit) but false positives would mislabel ordinary
 * failures as security events.
 */
const DENIAL_PATTERNS: ReadonlyArray<RegExp> = [
  // nono's own user-visible prefix when it intercepts/denies a syscall.
  /\bnono:\s+(?:denied|deny|violation)\b/i,
  // Landlock/Seatbelt-derived messages bubbled through nono.
  /\b(?:sandbox|seatbelt|landlock)\b[^\n]*\bdeni(?:ed|al)\b/i,
  /\boperation not permitted\b[^\n]*\bnono\b/i,
];

const detectSandboxDenied = (stderrTail: string): string | null => {
  for (const re of DENIAL_PATTERNS) {
    const m = stderrTail.match(re);
    if (m !== null) return m[0];
  }
  return null;
};

/**
 * Append a chunk of stderr bytes to `tailRef`, capped at
 * {@link STDERR_TAIL_BYTES}. Old bytes are dropped FIFO so we never grow
 * unboundedly. Done in a tiny pure helper so it's testable in isolation
 * later if the cap ever needs revisiting.
 */
const appendCapped = (existing: string, addition: string): string => {
  const combined = existing + addition;
  if (combined.length <= STDERR_TAIL_BYTES) return combined;
  return combined.slice(combined.length - STDERR_TAIL_BYTES);
};

/**
 * Map a `@effect/platform` `PlatformError` into our typed `SandboxError`.
 * The platform error carries useful context in `.message`; preserving it
 * lets operators trace failures back to the nono argv that triggered them.
 */
const mapSpawnFailure = (
  argv: ReadonlyArray<string>,
  err: unknown,
): SandboxSpawnFailed => {
  const message =
    typeof err === "object" && err !== null && "message" in err
      ? String((err as { message: unknown }).message)
      : String(err);
  return new SandboxSpawnFailed({ argv, message, cause: err });
};

/* -------------------------------------------------------------------------- */
/* Service factory + Live Layer                                               */
/* -------------------------------------------------------------------------- */

/**
 * Build a `SandboxService` bound to the given `CommandExecutor` (so tests
 * can override behavior) and shutdown grace period (so the cancellation
 * test can use a sub-second value without the suite waiting 5s).
 *
 * The `CommandExecutor` from `@effect/platform-bun` already has scope-bound
 * lifecycle (the spawn `Effect.acquireRelease` finalizer SIGTERMs the
 * child). We layer a *softer* shutdown on top: SIGTERM, wait up to
 * `shutdownGrace`, then SIGKILL. The platform's own SIGTERM-on-finalize
 * still runs after ours (it's a no-op once the process has actually exited).
 */
export const makeSandbox = (
  executor: CommandExecutor.CommandExecutor,
  shutdownGrace: Duration.Duration = DEFAULT_SHUTDOWN_GRACE,
): SandboxService => ({
  spawn: (opts) =>
    Effect.gen(function* () {
      const argv = policyArgv(opts.policy, opts.command);

      // Build the platform Command. `Command.make("nono", ...argv)` uses
      // the first arg as the executable and the rest as argv-after-argv0,
      // matching `execve(2)` semantics — no shell interpolation.
      const baseCommand = Command.make("nono", ...argv);
      const withCwd = Command.workingDirectory(baseCommand, opts.cwd);
      const withEnv = Command.env(withCwd, opts.env);
      // The platform `CommandInput` is `"inherit" | "pipe" | Stream<…>`.
      // To honor our `"null"` mode (close stdin at spawn) we feed an empty
      // stream — the executor pipes it then EOFs the child's stdin.
      const stdinMode = opts.stdin ?? "pipe";
      const withStdin =
        stdinMode === "null"
          ? Command.stdin(withEnv, Stream.empty)
          : Command.stdin(withEnv, stdinMode);

      // Capture stderr alongside denial-pattern accumulation. We keep the
      // most recent ~8 KiB so the worker can include it in failure reports
      // without unbounded memory growth on a chatty process.
      const stderrTailRef = yield* Ref.make<string>("");

      // Start the process. The executor's own finalizer SIGTERMs the
      // child on scope close; we attach a stronger one below that adds
      // the SIGKILL escalation after `shutdownGrace`.
      const process = yield* executor.start(withStdin).pipe(
        Effect.mapError((err) => mapSpawnFailure(argv, err)),
      );

      // Drain stderr into a rolling ~8 KiB tail used by `waitForExit`
      // for denial-pattern matching and operator-friendly failure
      // messages. `forkScoped` ties this fiber's lifetime to the spawn
      // scope so it shuts down alongside the process.
      //
      // The platform `Process.stderr` is a single-consumer pull stream
      // over the underlying Node readable: this drain owns it. We
      // expose the captured tail to callers via `SandboxProcess.stderrTail`
      // rather than re-publishing the stream, which keeps the contract
      // honest about who reads from where.
      const decoder = new TextDecoder("utf-8", { fatal: false });
      yield* process.stderr.pipe(
        Stream.runForEach((chunk) =>
          Ref.update(stderrTailRef, (tail) =>
            appendCapped(tail, decoder.decode(chunk, { stream: true })),
          ),
        ),
        Effect.catchAll(() => Effect.void),
        Effect.forkScoped,
      );

      // Add a stronger shutdown hook: SIGTERM, wait up to `shutdownGrace`,
      // then SIGKILL. The platform's own finalizer also tries SIGTERM, so
      // a polite child sees one signal; a stuck child gets escalated.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const stillRunning = yield* process.isRunning.pipe(
            Effect.catchAll(() => Effect.succeed(false)),
          );
          if (!stillRunning) return;
          // First, polite SIGTERM. Ignore failures — the process may have
          // exited between the check and the kill.
          yield* process.kill("SIGTERM").pipe(Effect.ignore);
          // Race wait-for-exit against the grace period; if the grace
          // wins, escalate to SIGKILL. `timeoutOption` returns `None` when
          // the timeout fires before the wrapped Effect completes.
          const settled = yield* process.exitCode.pipe(
            Effect.timeoutOption(shutdownGrace),
            Effect.catchAll(() => Effect.succeed(Option.none())),
          );
          if (Option.isNone(settled)) {
            yield* process.kill("SIGKILL").pipe(Effect.ignore);
            // Best-effort wait for the kernel to reap.
            yield* process.exitCode.pipe(Effect.ignore);
          }
        }),
      );

      const exitCodeEff: Effect.Effect<number, SandboxSpawnFailed> =
        process.exitCode.pipe(
          Effect.map((code) => code as unknown as number),
          Effect.mapError((err) => mapSpawnFailure(argv, err)),
        );

      const waitForExitEff: Effect.Effect<number, SandboxError> = Effect.gen(
        function* () {
          const code = yield* exitCodeEff;
          if (code === 0) return code;
          const tail = yield* Ref.get(stderrTailRef);
          const denial = detectSandboxDenied(tail);
          if (denial !== null) {
            return yield* Effect.fail(
              new SandboxAccessDenied({
                argv,
                exitCode: code,
                denial,
              }),
            );
          }
          return yield* Effect.fail(
            new SandboxNonZeroExit({
              argv,
              exitCode: code,
              stderrTail: tail,
            }),
          );
        },
      );

      const handle: SandboxProcess = {
        pid: process.pid as unknown as number,
        exitCode: exitCodeEff,
        waitForExit: waitForExitEff,
        stdin: process.stdin.pipe(
          Sink.mapError((err) => mapSpawnFailure(argv, err)),
        ),
        stdout: process.stdout.pipe(
          Stream.mapError((err) => mapSpawnFailure(argv, err)),
        ),
        stderrTail: Ref.get(stderrTailRef),
      };
      return handle;
    }),
});

/**
 * Live Layer: build a `Sandbox` against the `CommandExecutor` already
 * provided in the environment. Production wiring composes this with
 * `BunContext.layer` (which provides `CommandExecutor` + `FileSystem`).
 * Tests can `Layer.provideMerge` a fake CommandExecutor to drive the
 * service deterministically without a real process tree.
 */
export const SandboxLive: Layer.Layer<
  Sandbox,
  never,
  CommandExecutor.CommandExecutor
> = Layer.effect(
  Sandbox,
  Effect.map(CommandExecutor.CommandExecutor, (executor) =>
    makeSandbox(executor),
  ),
);

/**
 * Variant of {@link SandboxLive} with an overridable shutdown-grace
 * Duration. Used by the cancellation-termination test so the suite
 * doesn't pay the full 5s default to verify SIGKILL escalation works.
 */
export const SandboxLiveWithGrace = (
  grace: Duration.Duration,
): Layer.Layer<Sandbox, never, CommandExecutor.CommandExecutor> =>
  Layer.effect(
    Sandbox,
    Effect.map(CommandExecutor.CommandExecutor, (executor) =>
      makeSandbox(executor, grace),
    ),
  );

/* -------------------------------------------------------------------------- */
/* Re-exports kept here so downstream tasks don't need to know which file     */
/* the policies module lives in.                                              */
/* -------------------------------------------------------------------------- */

export {
  agentRunnerArgv,
  AGENT_RUNNER_BASE_READS,
  claudeHomePath,
  hookArgv,
  policyArgv,
} from "./policies.ts";
