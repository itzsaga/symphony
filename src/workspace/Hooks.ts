// WorkspaceHooks Effect service: runs WORKFLOW.md lifecycle hooks in the nono sandbox.
// Implements SPEC.md §9.4 execution + failure semantics and §15.4 trust/truncation guidance.
import { dirname } from "node:path";
import { Chunk, Context, Data, Duration, Effect, Layer, Stream } from "effect";
import type { Cause } from "effect";
import {
  toAbsolutePathSync,
  type AbsolutePath,
} from "../config/PathSafety.ts";
import { WorkflowLoader } from "../config/WorkflowLoader.ts";
import { Logger } from "../observability/Logger.ts";
import { Sandbox, type SandboxError } from "../sandbox/Nono.ts";
import type { Workspace } from "./WorkspaceManager.ts";

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Built-in nono profile used for hook execution. SPEC.md §9.4 references a
 * `developer` profile name, but that is not one of the profiles shipped by
 * nono v0.43.x (verified built-ins: `default`, `claude-code`, `claude-no-kc`,
 * `codex`, `node-dev`, `python-dev`, `rust-dev`, `go-dev`, `linux-host-compat`,
 * `opencode`, `openclaw`, `swival`). `default` is the most conservative built-in
 * present on every install; the per-workflow override mentioned in the spec's
 * "out of scope" list (a future `hooks.sandbox_profile` field) would let users
 * select e.g. `node-dev` when a hook runs `bun install`.
 */
const HOOK_SANDBOX_PROFILE = "default";

/**
 * Per-stream truncation limit for hook output captured into the failure log
 * entry. SPEC.md §15.4 says "Hook output SHOULD be truncated in logs"; 4 KiB
 * per stream keeps a single failure record around 8 KiB worst case while still
 * giving the operator enough context to diagnose typical hook errors.
 */
const HOOK_OUTPUT_TAIL_BYTES = 4 * 1024;

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Discriminator for *why* a fatal hook failure happened — useful both for
 * structured logs and for callers that want to surface "the script exited 1"
 * differently from "the sandbox refused to start the script".
 */
export type HookFailureReason = "exit" | "timeout" | "spawn" | "denied";

/** Common payload carried by every fatal `HookError` variant. */
interface HookErrorPayload {
  readonly stdout_tail: string;
  readonly stderr_tail: string;
  readonly exit_code: number | null;
  readonly reason: HookFailureReason;
}

/**
 * `after_create` hook failed or timed out. Per §9.4 this is fatal to workspace
 * creation; the caller (orchestrator/WorkspaceManager wrapper) is responsible
 * for any partial-workspace cleanup policy.
 */
export class AfterCreateFailed extends Data.TaggedError(
  "HookErrorAfterCreateFailed",
)<HookErrorPayload> {}

/**
 * `before_run` hook failed or timed out. Per §9.4 this is fatal to the current
 * dispatch attempt; the orchestrator surfaces this on the run record and does
 * not invoke the agent runner.
 */
export class BeforeRunFailed extends Data.TaggedError(
  "HookErrorBeforeRunFailed",
)<HookErrorPayload> {}

/** Discriminated union of every error this service raises. */
export type HookError = AfterCreateFailed | BeforeRunFailed;

/* -------------------------------------------------------------------------- */
/* Service Tag                                                                */
/* -------------------------------------------------------------------------- */

/**
 * WorkspaceHooks service interface. Each method targets one of the four
 * lifecycle hooks defined in §9.4. The two "fatal" hooks (`after_create`,
 * `before_run`) propagate `HookError`; the two "best-effort" hooks
 * (`after_run`, `before_remove`) return `Effect<void, never>` and log on
 * failure so cleanup/teardown always proceeds.
 */
export interface WorkspaceHooksService {
  readonly runAfterCreate: (
    workspace: Workspace,
  ) => Effect.Effect<void, HookError>;
  readonly runBeforeRun: (
    workspace: Workspace,
  ) => Effect.Effect<void, HookError>;
  readonly runAfterRun: (workspace: Workspace) => Effect.Effect<void>;
  readonly runBeforeRemove: (workspace: Workspace) => Effect.Effect<void>;
}

/** The WorkspaceHooks service tag. */
export class WorkspaceHooks extends Context.Tag(
  "symphony/workspace/WorkspaceHooks",
)<WorkspaceHooks, WorkspaceHooksService>() {}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

/** The four hook slots, used in logs and to key into `config.hooks.*`. */
type HookName = "after_create" | "before_run" | "after_run" | "before_remove";

/**
 * Concatenate a `Chunk<Uint8Array>` into a single UTF-8 string, then keep at
 * most {@link HOOK_OUTPUT_TAIL_BYTES} characters from the *start* — operators
 * almost always want the first error message a script printed, not the tail
 * of a long stdout buffer. `Buffer.from(...).toString("utf8")` handles partial
 * multi-byte sequences across chunk boundaries safely enough for log payloads.
 */
const decodeAndTruncate = (chunks: Chunk.Chunk<Uint8Array>): string => {
  const buffers = Chunk.toReadonlyArray(chunks);
  const total = buffers.reduce((n, b) => n + b.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const b of buffers) {
    merged.set(b, offset);
    offset += b.length;
  }
  const text = Buffer.from(merged).toString("utf8");
  return text.slice(0, HOOK_OUTPUT_TAIL_BYTES);
};

/**
 * Construct the appropriate fatal `HookError` for a given hook slot. Keeps
 * the per-method error mapping concise — only `after_create` and `before_run`
 * call this; the best-effort hooks log directly without producing a typed
 * error.
 */
const makeFatalError = (
  hook: "after_create" | "before_run",
  payload: HookErrorPayload,
): HookError =>
  hook === "after_create"
    ? new AfterCreateFailed(payload)
    : new BeforeRunFailed(payload);

/* -------------------------------------------------------------------------- */
/* Layer                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Build a `WorkspaceHooks` wired against the current `WorkflowLoader` snapshot,
 * the `Sandbox` service, and the structured `Logger`. The hook script + timeout
 * are read from `WorkflowLoader.current` on every invocation so a runtime
 * config reload that changes either is honored on the next dispatch (per §6.2).
 */
export const WorkspaceHooksLive: Layer.Layer<
  WorkspaceHooks,
  never,
  WorkflowLoader | Sandbox | Logger
> = Layer.effect(
  WorkspaceHooks,
  Effect.gen(function* () {
    const loader = yield* WorkflowLoader;
    const sandbox = yield* Sandbox;
    const log = yield* Logger;

    /**
     * Run a single hook script inside the sandbox. Returns `Effect<RunOutcome>`
     * — never fails — so the caller can decide whether to convert a
     * non-success outcome into a typed error (fatal hooks) or just log it
     * (best-effort hooks). Centralizing the spawn + drain + timeout + capture
     * here keeps the four public methods to a few lines each.
     */
    const runOne = (
      hook: HookName,
      script: string,
      workspace: Workspace,
      workflowDir: AbsolutePath,
      timeoutMs: number,
    ): Effect.Effect<RunOutcome> =>
      Effect.scoped(
        Effect.gen(function* () {
          const startedAt = Date.now();
          yield* log.info({
            msg: "hook started",
            hook,
            workspace: workspace.path,
            timeout_ms: timeoutMs,
          });

          // Spawn under the `kind: "hook"` policy with workspace as cwd, the
          // workflow directory as a read mount, and stdin closed (hooks have
          // no use for stdin and leaving it open as a pipe would force the
          // caller to manage an unused sink).
          const spawned = yield* Effect.either(
            sandbox.spawn({
              command: ["bash", "-lc", script],
              cwd: workspace.path,
              policy: {
                kind: "hook",
                workspace: workspace.path,
                workflow_dir: workflowDir,
                profile: HOOK_SANDBOX_PROFILE,
              },
              env: {},
              stdin: "null",
            }),
          );

          if (spawned._tag === "Left") {
            // Spawn-stage failure — typically `SandboxSpawnFailed`. We log it
            // and return a non-zero outcome so the caller can map it to a
            // fatal `HookError` (or swallow, for best-effort hooks).
            const err = spawned.left;
            const tail = sandboxErrorStderrTail(err);
            yield* log.warn({
              msg: "hook spawn failed",
              hook,
              workspace: workspace.path,
              error_tag: err._tag,
              stderr_tail: tail,
            });
            return {
              kind: "failure",
              reason: "spawn",
              exitCode: null,
              stdoutTail: "",
              stderrTail: tail,
              durationMs: Date.now() - startedAt,
            } as const;
          }

          const proc = spawned.right;
          // Drain stdout into a single Chunk so we can capture the head of it
          // for the failure log entry. Without an active stdout consumer the
          // OS pipe can fill on chatty scripts and stall the process; the
          // collect-then-truncate pattern matches what the Sandbox suite
          // already uses for `cat`-style round-trips.
          const stdoutFiber = yield* proc.stdout.pipe(
            Stream.runCollect,
            Effect.catchAll(() =>
              Effect.succeed(Chunk.empty<Uint8Array>()),
            ),
            Effect.fork,
          );

          // Race the wait against the configured timeout. `Effect.timeout`
          // injects a `TimeoutException` on the timeout branch which we map
          // to `reason: "timeout"` below. The interrupt the timeout produces
          // tears down the spawn scope, which in turn SIGTERMs (then SIGKILLs
          // after the sandbox grace) the child process.
          const waited = yield* proc.waitForExit.pipe(
            Effect.timeout(Duration.millis(timeoutMs)),
            Effect.either,
          );
          const stdoutChunks = yield* stdoutFiber.await.pipe(
            Effect.map((exit) =>
              exit._tag === "Success" ? exit.value : Chunk.empty<Uint8Array>(),
            ),
          );
          const stdoutTail = decodeAndTruncate(stdoutChunks);
          const stderrTail = (
            yield* proc.stderrTail.pipe(Effect.catchAllCause(() => Effect.succeed("")))
          ).slice(0, HOOK_OUTPUT_TAIL_BYTES);
          const durationMs = Date.now() - startedAt;

          if (waited._tag === "Right") {
            // Clean exit (waitForExit only resolves with the code on success).
            yield* log.info({
              msg: "hook completed",
              hook,
              workspace: workspace.path,
              exit_code: waited.right,
              duration_ms: durationMs,
            });
            return {
              kind: "success",
              exitCode: waited.right,
              stdoutTail,
              stderrTail,
              durationMs,
            } as const;
          }

          // Failure branch: either a `SandboxError` (non-zero exit, denial,
          // or spawn race) or a `TimeoutException` from `Effect.timeout`.
          const err = waited.left;
          if (isTimeoutException(err)) {
            yield* log.warn({
              msg: "hook timed out",
              hook,
              workspace: workspace.path,
              timeout_ms: timeoutMs,
              duration_ms: durationMs,
              stdout_tail: stdoutTail,
              stderr_tail: stderrTail,
            });
            return {
              kind: "failure",
              reason: "timeout",
              exitCode: null,
              stdoutTail,
              stderrTail,
              durationMs,
            } as const;
          }

          // Non-timeout SandboxError. Discriminate on `_tag` so we surface
          // denials separately from ordinary non-zero exits.
          const reason: HookFailureReason =
            err._tag === "SandboxAccessDenied"
              ? "denied"
              : err._tag === "SandboxSpawnFailed"
                ? "spawn"
                : "exit";
          const exitCode =
            err._tag === "SandboxAccessDenied" ||
            err._tag === "SandboxNonZeroExit"
              ? err.exitCode
              : null;
          yield* log.warn({
            msg: "hook failed",
            hook,
            workspace: workspace.path,
            error_tag: err._tag,
            reason,
            exit_code: exitCode,
            duration_ms: durationMs,
            stdout_tail: stdoutTail,
            stderr_tail: stderrTail,
          });
          return {
            kind: "failure",
            reason,
            exitCode,
            stdoutTail,
            stderrTail,
            durationMs,
          } as const;
        }),
      );

    /**
     * Resolve the script + timeout + workflow_dir for a given hook slot from
     * the loader snapshot. Returns `null` when the hook is unconfigured (the
     * caller short-circuits to `Effect.void`).
     */
    const resolveHook = (
      hook: HookName,
    ): Effect.Effect<{
      readonly script: string;
      readonly timeoutMs: number;
      readonly workflowDir: AbsolutePath;
    } | null> =>
      Effect.map(loader.current, (wf) => {
        const script = wf.config.hooks[hook];
        if (script === null || script.length === 0) return null;
        return {
          script,
          timeoutMs: wf.config.hooks.timeout_ms,
          workflowDir: toAbsolutePathSync(dirname(wf.source_path)),
        };
      });

    const runFatal = (
      hook: "after_create" | "before_run",
      workspace: Workspace,
    ): Effect.Effect<void, HookError> =>
      Effect.gen(function* () {
        const resolved = yield* resolveHook(hook);
        if (resolved === null) return;
        const outcome = yield* runOne(
          hook,
          resolved.script,
          workspace,
          resolved.workflowDir,
          resolved.timeoutMs,
        );
        if (outcome.kind === "success") return;
        return yield* Effect.fail(
          makeFatalError(hook, {
            stdout_tail: outcome.stdoutTail,
            stderr_tail: outcome.stderrTail,
            exit_code: outcome.exitCode,
            reason: outcome.reason,
          }),
        );
      });

    const runBestEffort = (
      hook: "after_run" | "before_remove",
      workspace: Workspace,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const resolved = yield* resolveHook(hook);
        if (resolved === null) return;
        // Outcome is logged inside `runOne`; we discard it here because the
        // best-effort contract says cleanup proceeds regardless.
        yield* runOne(
          hook,
          resolved.script,
          workspace,
          resolved.workflowDir,
          resolved.timeoutMs,
        );
      });

    const service: WorkspaceHooksService = {
      runAfterCreate: (workspace) => runFatal("after_create", workspace),
      runBeforeRun: (workspace) => runFatal("before_run", workspace),
      runAfterRun: (workspace) => runBestEffort("after_run", workspace),
      runBeforeRemove: (workspace) => runBestEffort("before_remove", workspace),
    };
    return service;
  }),
);

/* -------------------------------------------------------------------------- */
/* Internal types + small helpers used by the Layer body                      */
/* -------------------------------------------------------------------------- */

/**
 * Outcome of a single `runOne` call. Modeled as a discriminated union so the
 * caller can pattern-match on `kind` and produce either a success path or the
 * appropriate fatal/best-effort error path.
 */
type RunOutcome =
  | {
      readonly kind: "success";
      readonly exitCode: number;
      readonly stdoutTail: string;
      readonly stderrTail: string;
      readonly durationMs: number;
    }
  | {
      readonly kind: "failure";
      readonly reason: HookFailureReason;
      readonly exitCode: number | null;
      readonly stdoutTail: string;
      readonly stderrTail: string;
      readonly durationMs: number;
    };

/**
 * Best-effort stderr extraction for spawn-stage `SandboxError`s. Spawn failures
 * don't have a captured stderr tail (the process never ran), so we fall back to
 * the error's `message` field for diagnostic surfacing.
 */
const sandboxErrorStderrTail = (err: SandboxError): string => {
  switch (err._tag) {
    case "SandboxSpawnFailed":
      return err.message.slice(0, HOOK_OUTPUT_TAIL_BYTES);
    case "SandboxAccessDenied":
      return err.denial.slice(0, HOOK_OUTPUT_TAIL_BYTES);
    case "SandboxNonZeroExit":
      return err.stderrTail.slice(0, HOOK_OUTPUT_TAIL_BYTES);
  }
};

/**
 * Type guard for `Cause.TimeoutException` without depending on the runtime
 * symbol export. `Effect.timeout` always surfaces the exception with the
 * literal `_tag: "TimeoutException"`, so a tag check is enough here.
 */
const isTimeoutException = (
  err: SandboxError | Cause.TimeoutException,
): err is Cause.TimeoutException => err._tag === "TimeoutException";

/* -------------------------------------------------------------------------- */
/* Re-exports kept here so downstream callers don't need to dig into the      */
/* per-hook payload shape.                                                    */
/* -------------------------------------------------------------------------- */

export type { Workspace };
