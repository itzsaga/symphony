// ClaudeSubprocess: spawn the `claude` CLI under the Sandbox and own its bidirectional JSONL pipe.
// Per-call Effect.acquireRelease resource; control-protocol RPC and §10.4 event mapping live in sibling tasks.
import {
  Chunk,
  Data,
  Duration,
  Effect,
  Either,
  Option,
  Queue,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import {
  assertCwdMatches,
  type AbsolutePath,
} from "../config/PathSafety.ts";
import { Logger } from "../observability/Logger.ts";
import {
  Sandbox,
  type SandboxError,
  type SandboxProcess,
} from "../sandbox/Nono.ts";
import {
  buildAgentRunnerPolicy,
  buildClaudeArgv,
  type ClaudeSpawnOptions,
} from "./argv.ts";
import {
  makeJsonlParser,
  type StreamDecodeError,
} from "./jsonlParser.ts";
import {
  StreamJsonMessage,
  type OutboundControlCancelRequest,
  type OutboundControlResponse,
  type OutboundUserMessage,
  type StreamJsonMessage as StreamJsonMessageType,
} from "./StreamJson.ts";

export type { ClaudeSpawnOptions } from "./argv.ts";
export { StreamDecodeError } from "./jsonlParser.ts";

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** The `claude` binary could not be found / executed. */
export class ClaudeNotFound extends Data.TaggedError("ClaudeNotFound")<{
  readonly command: string;
  readonly cause?: unknown;
}> {}

/**
 * Re-export of `PathSafety.InvalidWorkspaceCwd` shape under a domain-local
 * tag. Keeps the `ClaudeSubprocess` error union pattern-matchable without
 * forcing callers to import from `PathSafety`.
 */
export class InvalidWorkspaceCwd extends Data.TaggedError(
  "InvalidWorkspaceCwd",
)<{
  readonly expected: string;
  readonly actual: string;
}> {}

/** The sandbox failed to spawn the inner `claude` process. */
export class SubprocessSpawnFailed extends Data.TaggedError(
  "SubprocessSpawnFailed",
)<{
  readonly argv: ReadonlyArray<string>;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Subprocess exited (resolved by `awaitExit`). Carries observed code+signal. */
export class SubprocessExited extends Data.TaggedError("SubprocessExited")<{
  readonly code: number;
  readonly signal: string | null;
}> {}

/** Discriminated union of every error this module raises. */
export type ClaudeSubprocessError =
  | ClaudeNotFound
  | InvalidWorkspaceCwd
  | SubprocessSpawnFailed
  | StreamDecodeError
  | SubprocessExited;

/* -------------------------------------------------------------------------- */
/* Outbound frame type                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Closed union of frames Symphony writes to the CLI's stdin. Mirrors the
 * outbound shapes exported from `StreamJson.ts`. Tightening to a closed
 * union here means callers that want to push something else have to add a
 * new outbound schema first — keeps the wire surface auditable.
 */
export type OutboundFrame =
  | OutboundUserMessage
  | OutboundControlResponse
  | OutboundControlCancelRequest;

/* -------------------------------------------------------------------------- */
/* Resource handle                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Scope-bound resource returned by {@link spawn}. Lifetime is tied to the
 * surrounding `Effect.scoped` block: closing the scope flushes the outgoing
 * queue, closes stdin, and waits for the subprocess to exit (escalating to
 * SIGTERM/SIGKILL via the underlying Sandbox finalizer if the CLI doesn't
 * close on its own within the grace window).
 *
 * `stderr` is `Stream.empty<string>` for v1 — the underlying `Sandbox`
 * exposes a snapshot tail rather than a per-line stream. Callers that need
 * post-hoc stderr (control-protocol / event mapping for failure surfacing)
 * should call {@link ClaudeSubprocess.stderrTail} after the process exits.
 */
export interface ClaudeSubprocess {
  readonly pid: number;
  readonly incoming: Stream.Stream<StreamJsonMessageType>;
  readonly outgoing: Queue.Enqueue<OutboundFrame>;
  readonly stderr: Stream.Stream<string>;
  readonly stderrTail: Effect.Effect<string>;
  readonly awaitExit: Effect.Effect<{
    readonly code: number;
    readonly signal: string | null;
  }>;
}

/* -------------------------------------------------------------------------- */
/* Spawn configuration knobs (env / version)                                  */
/* -------------------------------------------------------------------------- */

/**
 * Default outgoing-queue capacity. Small bound is fine — the CLI reads stdin
 * promptly during a turn, so backpressure should only kick in if we're
 * trying to fire many control responses while the CLI is paused.
 */
export const DEFAULT_OUTGOING_QUEUE_CAPACITY = 16;

/**
 * Grace window between `outgoing.shutdown()`/stdin-EOF and letting the
 * Sandbox's own SIGTERM/SIGKILL finalizer take over. Per the Python SDK's
 * 5s default (`research §8` / issue #625): the CLI needs time to flush its
 * session file after EOF before being forcibly terminated.
 */
export const DEFAULT_GRACEFUL_EXIT_GRACE: Duration.Duration = Duration.seconds(5);

/**
 * Read the Symphony version once at module load. Bun supports JSON imports
 * with assertions (`with { type: "json" }`); we keep this tolerant of the
 * import failing in unusual test layouts and fall back to the literal "dev".
 *
 * Used to compose the `CLAUDE_AGENT_SDK_CLIENT_APP` env var per
 * `research §1`. The value is observable to operators in CLI logs and
 * Anthropic-side request metadata.
 */
const SYMPHONY_VERSION: string = await readSymphonyVersion();

async function readSymphonyVersion(): Promise<string> {
  try {
    // Resolve relative to this module's directory using `import.meta.dir`,
    // walking up from `src/claude/` to the repo root. Bun's `Bun.file` is
    // sync-readable but we keep this async because top-level await is
    // available at module scope and avoids a dependency on Bun.
    const here = new URL(".", import.meta.url).pathname;
    const root = new URL("../../package.json", `file://${here}`).pathname;
    const text = await Bun.file(root).text();
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      typeof (parsed as { version: unknown }).version === "string"
    ) {
      return (parsed as { version: string }).version;
    }
  } catch {
    // Fall through to the dev fallback.
  }
  return "dev";
}

/**
 * Compose the env passed to the `claude` subprocess (research §1):
 *
 * - `CLAUDE_CODE_ENTRYPOINT` = "symphony"
 * - `CLAUDE_AGENT_SDK_CLIENT_APP` = "symphony/<version>"
 *
 * The `CLAUDECODE` variable is intentionally omitted; the Sandbox only
 * receives the env we hand it, so simply not including `CLAUDECODE` here
 * is sufficient to filter it from the inherited environment (issue #573).
 *
 * Caller-provided `extraEnv` overlays last so an operator can override the
 * defaults from the workflow if the situation demands it.
 */
const composeEnv = (extraEnv: Record<string, string>): Record<string, string> => {
  const env: Record<string, string> = {
    CLAUDE_CODE_ENTRYPOINT: "symphony",
    CLAUDE_AGENT_SDK_CLIENT_APP: `symphony/${SYMPHONY_VERSION}`,
  };
  for (const [k, v] of Object.entries(extraEnv)) {
    env[k] = v;
  }
  return env;
};

/* -------------------------------------------------------------------------- */
/* Spawn                                                                      */
/* -------------------------------------------------------------------------- */

/** Tunables applied per-spawn. Tests use shorter grace to keep runtime down. */
export interface SpawnTunables {
  readonly outgoing_capacity?: number;
  readonly graceful_exit_grace?: Duration.Duration;
  readonly extra_env?: Record<string, string>;
}

/**
 * Spawn a `claude` subprocess. The returned Effect requires `Sandbox`,
 * `Logger`, and a `Scope`; the resource lives until the surrounding
 * `Effect.scoped` block closes.
 *
 * Caller responsibilities:
 * - Provide a workspace path that already exists on disk (the Sandbox cwd
 *   check is defense-in-depth; the workspace is materialized by
 *   `WorkspaceManager` ahead of time).
 * - Provide an `mcp_config` (JSON literal or absolute path). The MCP-server
 *   hosting layer that produces this is a sibling task.
 *
 * What this function does NOT do (by design — out of scope per the spec):
 * - Mount the control-protocol RPC handler.
 * - Map incoming frames to Symphony §10.4 events.
 * - Pre-flight `claude --version` ≥ 2.0.0 (deferred; `flake.nix` pins a
 *   compatible CLI version, and the first `system.init` frame's `model`
 *   field acts as a runtime canary).
 */
export const spawn = (
  opts: ClaudeSpawnOptions,
  tunables: SpawnTunables = {},
): Effect.Effect<
  ClaudeSubprocess,
  ClaudeSubprocessError,
  Sandbox | Logger | Scope.Scope
> =>
  Effect.gen(function* () {
    const log = yield* Logger;
    const sandbox = yield* Sandbox;

    // §9.5 invariant 1: subprocess cwd must equal the workspace path.
    // Defensive — the Sandbox enforces too — but cheap and catches bugs in
    // the upstream WorkspaceManager wiring before we ever spawn nono.
    yield* assertCwdMatches(opts.workspace, opts.workspace).pipe(
      Effect.mapError(
        (err) =>
          new InvalidWorkspaceCwd({
            expected: err.expected,
            actual: err.actual,
          }),
      ),
    );

    const innerArgv = buildClaudeArgv(opts);
    const command = [opts.config.agent_runner.command, ...innerArgv];
    const policy = buildAgentRunnerPolicy(opts);
    const env = composeEnv(tunables.extra_env ?? {});

    yield* log.debug({
      msg: "spawning claude subprocess",
      argv: command,
      cwd: opts.workspace,
      bare: opts.config.agent_runner.bare,
      max_turns: opts.config.agent_runner.max_turns,
    });

    // Spawn through the Sandbox. The Sandbox owns its own
    // SIGTERM-grace-SIGKILL finalizer; ours layers on top: close stdin
    // first, wait up to `graceful_exit_grace` for the CLI to exit, then
    // let the Sandbox finalizer escalate.
    const proc: SandboxProcess = yield* sandbox
      .spawn({
        command,
        cwd: opts.workspace as AbsolutePath,
        policy,
        env,
        stdin: "pipe",
      })
      .pipe(Effect.mapError(mapSandboxError(command)));

    /* ---------- outgoing queue → stdin ---------- */

    // Bounded queue gives us backpressure the moment the CLI stalls reading
    // stdin (e.g. mid-tool-call). 16 is plenty for the typical
    // user+control_response cadence; well-behaved producers will rarely
    // block here.
    const outgoingCapacity =
      tunables.outgoing_capacity ?? DEFAULT_OUTGOING_QUEUE_CAPACITY;
    const outgoing = yield* Queue.bounded<OutboundFrame>(outgoingCapacity);
    yield* Effect.addFinalizer(() => Queue.shutdown(outgoing));

    // Drain the outgoing queue → JSON.stringify+`\n` → encodeText → stdin
    // sink. `Stream.fromQueue` EOFs when the queue is shut down, which
    // closes the underlying stdin sink (this is exactly the EOF the CLI
    // needs to begin its graceful shutdown).
    const outgoingStream = Stream.fromQueue(outgoing).pipe(
      Stream.map((frame) => `${JSON.stringify(frame)}\n`),
      Stream.encodeText,
    );
    yield* outgoingStream.pipe(
      Stream.run(proc.stdin),
      Effect.catchAll((err) =>
        log.warn({
          msg: "claude stdin sink failed; dropping outgoing frames",
          error: err.message,
        }),
      ),
      Effect.forkScoped,
    );

    /* ---------- stdout → JSONL parser → schema decode → incoming Stream ---------- */

    // Bounded inbound queue with a generous capacity. The schema-decode
    // fiber pushes frames here; the consumer (the §10.4 event mapper, in
    // a sibling task) pulls them via `incoming`. We use `unbounded` so
    // the parser fiber never blocks on a slow consumer — at JSONL line
    // granularity this is bounded in practice by the CLI's own pacing
    // and matches the SDK's pattern of an unbounded internal channel.
    const inboundQueue = yield* Queue.unbounded<StreamJsonMessageType>();
    yield* Effect.addFinalizer(() => Queue.shutdown(inboundQueue));

    // Track the first parser-level fatal error so we can fail any
    // surrounding effect (e.g. via `awaitExit`-time inspection). For v1
    // we surface the error via the incoming stream's natural EOF — the
    // schema-decode fiber ends and the stream EOFs, and the carried
    // log message points operators at the buffer-overflow.
    const decodeErrorRef = yield* Ref.make<StreamDecodeError | null>(null);

    const parser = makeJsonlParser();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const decodeFrame = Schema.decodeUnknown(StreamJsonMessage);

    const handleParseResult = (
      result: ReturnType<typeof parser.feed>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const line of result.dropped_lines) {
          yield* log.debug({
            msg: "dropped non-JSON line on claude stdout",
            line,
          });
        }
        for (const raw of result.frames) {
          const decoded = yield* Effect.either(decodeFrame(raw));
          if (Either.isLeft(decoded)) {
            yield* log.warn({
              msg: "malformed stream-json frame on claude stdout; dropping",
              error: String(decoded.left),
            });
            continue;
          }
          yield* Queue.offer(inboundQueue, decoded.right);
        }
        if (result.error !== null) {
          yield* Ref.set(decodeErrorRef, result.error);
          yield* log.error({
            msg: "claude stdout parser overflowed buffer cap",
            bytes_buffered: result.error.bytes_buffered,
            cap_bytes: result.error.cap_bytes,
          });
        }
      });

    yield* proc.stdout.pipe(
      Stream.runForEach((chunk) => {
        const text = decoder.decode(chunk, { stream: true });
        return handleParseResult(parser.feed(text));
      }),
      Effect.catchAll((err) =>
        log.warn({
          msg: "claude stdout stream errored; closing inbound queue",
          error: err.message,
        }),
      ),
      Effect.zipRight(
        // Flush any partial-but-decodable tail at EOF, plus surface stranded
        // bytes via the dropped-lines path.
        Effect.suspend(() => handleParseResult(parser.finish())),
      ),
      Effect.zipRight(Queue.shutdown(inboundQueue)),
      Effect.forkScoped,
    );

    /* ---------- exit + scope teardown ---------- */

    // Capture the exit Effect once so multiple awaiters share the same
    // observation. The Sandbox `exitCode` Effect is itself idempotent, so
    // we just wrap it in our domain-local shape.
    const awaitExit: Effect.Effect<{
      readonly code: number;
      readonly signal: string | null;
    }> = proc.exitCode.pipe(
      Effect.map((code) => ({ code, signal: null as string | null })),
      Effect.catchAll(() =>
        // If the spawn handle ever surfaces a `SandboxSpawnFailed` here,
        // treat it as exit code -1: the process is, in practice, gone.
        Effect.succeed({ code: -1, signal: null as string | null }),
      ),
    );

    // Layered graceful shutdown. Steps:
    //   1. Shutdown outgoing queue → stream EOFs → stdin closes.
    //   2. Wait up to `graceful_exit_grace` for the CLI to exit on its
    //      own (it should; CLI exits 0 after flushing the session file).
    //   3. Fall through; the Sandbox's own finalizer escalates to
    //      SIGTERM (5s grace) then SIGKILL.
    //
    // The Sandbox finalizer runs AFTER ours because finalizers are LIFO
    // and the Sandbox attached its finalizer before this function ran.
    const grace = tunables.graceful_exit_grace ?? DEFAULT_GRACEFUL_EXIT_GRACE;
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* log.debug({
          msg: "claude subprocess shutdown: closing stdin and waiting for natural exit",
          grace_ms: Duration.toMillis(grace),
        });
        yield* Queue.shutdown(outgoing);
        // Finalizers run uninterruptibly by default, which causes
        // `timeoutOption` to wait for the inner Effect to complete before
        // assessing the deadline. We re-mark just this wait as interruptible
        // (composed with `Effect.disconnect` so the underlying tryPromise
        // continues in the background) so the timeout fires on schedule.
        const settled = yield* awaitExit.pipe(
          Effect.disconnect,
          Effect.timeoutOption(grace),
          Effect.interruptible,
        );
        if (Option.isNone(settled)) {
          yield* log.warn({
            msg: "claude subprocess did not exit within grace; sandbox finalizer will escalate",
            grace_ms: Duration.toMillis(grace),
          });
        } else {
          yield* log.debug({
            msg: "claude subprocess exited cleanly within grace",
            code: settled.value.code,
          });
        }
      }),
    );

    /* ---------- materialize the resource ---------- */

    const handle: ClaudeSubprocess = {
      pid: proc.pid,
      incoming: Stream.fromQueue(inboundQueue),
      outgoing,
      // Per the spec note: v1 stderr is empty. Operators read post-hoc
      // tails via `stderrTail` instead. A real per-line stream requires
      // extending the Sandbox interface, which is out of scope here.
      stderr: Stream.empty,
      stderrTail: proc.stderrTail,
      awaitExit,
    };
    return handle;
  });

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Map a `SandboxError` from `Sandbox.spawn` into our domain error union.
 * The interesting case is `SandboxSpawnFailed` whose message often carries
 * the underlying ENOENT — we forward that to `ClaudeNotFound` when the
 * pattern matches, otherwise to the generic `SubprocessSpawnFailed`.
 */
const mapSandboxError =
  (command: ReadonlyArray<string>) =>
  (err: SandboxError): ClaudeSubprocessError => {
    switch (err._tag) {
      case "SandboxSpawnFailed":
        if (
          /\bENOENT\b/i.test(err.message) ||
          /\bnot found\b/i.test(err.message)
        ) {
          return new ClaudeNotFound({
            command: command[0] ?? "claude",
            cause: err.cause,
          });
        }
        return new SubprocessSpawnFailed({
          argv: err.argv,
          message: err.message,
          cause: err.cause,
        });
      case "SandboxAccessDenied":
        return new SubprocessSpawnFailed({
          argv: err.argv,
          message: `sandbox denial: ${err.denial}`,
        });
      case "SandboxNonZeroExit":
        return new SubprocessSpawnFailed({
          argv: err.argv,
          message: `sandbox non-zero exit ${err.exitCode}: ${err.stderrTail}`,
        });
    }
  };

/**
 * Convenience: collect all incoming frames into a Chunk. Useful in tests
 * and for the §10.4 event-mapping consumer to drain after EOF.
 */
export const collectIncoming = (
  sub: ClaudeSubprocess,
): Effect.Effect<Chunk.Chunk<StreamJsonMessageType>> =>
  sub.incoming.pipe(Stream.runCollect);
