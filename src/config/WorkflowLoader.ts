// WorkflowLoader Effect service: holds the current WorkflowDefinition in a
// SubscriptionRef and watches WORKFLOW.md, re-parsing on every change.
import { type FSWatcher, watch as fsWatch } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname } from "node:path";
import {
  Context,
  Duration,
  Effect,
  Layer,
  Queue,
  Stream,
  SubscriptionRef,
} from "effect";
import { Logger } from "../observability/Logger.ts";
import { parseWorkflow, validateForDispatch } from "./parseWorkflow.ts";
import {
  MissingWorkflowFile,
  type ParseFailure,
  type ValidationError,
  type WorkflowDefinition,
} from "./WorkflowSchema.ts";

/* -------------------------------------------------------------------------- */
/* Service interface + Tag                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The WorkflowLoader service. Holds the current effective `WorkflowDefinition`
 * (last known good) and exposes a stream of every successful reload.
 *
 * The orchestrator subscribes to `changes` to react to live edits and calls
 * `validateForDispatch` defensively before each dispatch tick (§6.2 / §6.3).
 */
export interface WorkflowLoaderService {
  /** Read the current effective workflow definition. */
  readonly current: Effect.Effect<WorkflowDefinition>;
  /**
   * Stream of every successful reload. The `SubscriptionRef.changes` stream
   * replays the latest value to new subscribers, so consumers always receive
   * the current state on subscription.
   */
  readonly changes: Stream.Stream<WorkflowDefinition>;
  /**
   * Re-run §6.3 dispatch preflight against the current definition. Used by
   * the orchestrator before each dispatch in case a watch event was missed
   * (§6.2: "Implementations SHOULD also re-validate/reload defensively").
   */
  readonly validateForDispatch: Effect.Effect<void, ValidationError>;
}

/** The WorkflowLoader service tag. */
export class WorkflowLoader extends Context.Tag("symphony/config/WorkflowLoader")<
  WorkflowLoader,
  WorkflowLoaderService
>() {}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

/** Default debounce window for fs.watch events (per spec testing notes). */
const DEFAULT_DEBOUNCE_MS = 250;

/**
 * Read + parse a workflow file from disk into a `WorkflowDefinition`. Surfaces
 * `MissingWorkflowFile` for I/O errors and propagates the parser's
 * `WorkflowParseError` / `WorkflowFrontMatterNotAMap` for malformed content.
 */
const loadAndParse = (
  resolvedPath: string,
): Effect.Effect<WorkflowDefinition, MissingWorkflowFile | ParseFailure> =>
  Effect.gen(function* () {
    const content = yield* Effect.tryPromise({
      try: () => readFile(resolvedPath, "utf8"),
      catch: (cause) =>
        new MissingWorkflowFile({ path: resolvedPath, cause }),
    });
    return yield* parseWorkflow(content, resolvedPath);
  });

/**
 * Format a parse/IO failure into a short operator-visible string for log
 * payloads. Keeps the warn-on-reload path concise without losing tag info.
 */
const formatFailure = (err: MissingWorkflowFile | ParseFailure): string => {
  switch (err._tag) {
    case "MissingWorkflowFile":
      return `${err._tag}: ${err.path}`;
    case "WorkflowParseError":
      return `${err._tag}: ${err.message}`;
    case "WorkflowFrontMatterNotAMap":
      return `${err._tag}: front matter is ${err.actualKind}, expected map`;
  }
};

/**
 * Compute a tiny human-readable diff between two workflow definitions for the
 * info log on successful reload. We only surface the most operator-relevant
 * scalars (interval, max_turns, port) and fall back to "no scalar diff" when
 * everything we inspect is unchanged — the reload may still have edited the
 * prompt body or other fields, which the operator can confirm visually.
 */
const summarizeDiff = (
  prev: WorkflowDefinition,
  next: WorkflowDefinition,
): string => {
  const parts: Array<string> = [];
  const a = prev.config;
  const b = next.config;
  if (a.agent_runner.max_turns !== b.agent_runner.max_turns) {
    parts.push(
      `agent_runner.max_turns=${a.agent_runner.max_turns}->${b.agent_runner.max_turns}`,
    );
  }
  if (a.polling.interval_ms !== b.polling.interval_ms) {
    parts.push(
      `polling.interval_ms=${a.polling.interval_ms}->${b.polling.interval_ms}`,
    );
  }
  const prevPort = a.server?.port ?? null;
  const nextPort = b.server?.port ?? null;
  if (prevPort !== nextPort) {
    parts.push(`server.port=${String(prevPort)}->${String(nextPort)}`);
  }
  if (prev.prompt_template !== next.prompt_template) {
    parts.push("prompt_template changed");
  }
  return parts.length === 0 ? "no scalar diff" : parts.join(", ");
};

/* -------------------------------------------------------------------------- */
/* Layer factory                                                              */
/* -------------------------------------------------------------------------- */

/** Options for the WorkflowLoader Layer factory. */
export interface WorkflowLoaderOptions {
  /** Path to the WORKFLOW.md file. Resolved via realpath at startup. */
  readonly path: string;
  /** Optional override for the debounce window in ms (default 250). */
  readonly debounceMs?: number;
}

/**
 * Build a WorkflowLoader Layer from a path. The Layer is scoped: opening it
 * forks a watcher fiber, and closing the scope interrupts the watcher and
 * tears down the underlying `fs.watch` handle (no fd leak).
 *
 * Startup performs a synchronous-style load + parse + dispatch preflight; if
 * any of those fail the Layer build itself fails so the operator sees the
 * error before any orchestration starts (§16.1).
 */
export const layer = (
  options: WorkflowLoaderOptions,
): Layer.Layer<WorkflowLoader, MissingWorkflowFile | ParseFailure | ValidationError, Logger> =>
  Layer.scoped(WorkflowLoader, make(options));

/**
 * Default Live Layer: takes the workflow path from the caller. There is no
 * sensible global default for the path, so a factory invocation is required.
 */
export const WorkflowLoaderLive = layer;

/**
 * Construct the service inside a Scope. Returns a `WorkflowLoaderService`
 * once the watcher fiber is forked. Fails the whole scoped Effect (and thus
 * the Layer build) if the initial load + preflight does not succeed.
 */
const make = (
  options: WorkflowLoaderOptions,
): Effect.Effect<
  WorkflowLoaderService,
  MissingWorkflowFile | ParseFailure | ValidationError,
  Logger | import("effect/Scope").Scope
> =>
  Effect.gen(function* () {
    const log = yield* Logger;
    const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

    // Resolve symlinks ONCE at startup and watch the realpath. If the file
    // is later swapped via symlink retarget the watcher stays pinned to the
    // original target — that matches the spec's "resolve realpath once"
    // requirement and avoids surprising rebinds at runtime.
    const resolvedPath = yield* Effect.tryPromise({
      try: () => realpath(options.path),
      catch: (cause) =>
        new MissingWorkflowFile({ path: options.path, cause }),
    });

    // Initial load + parse. Any failure here aborts the Layer build, which
    // surfaces as an operator-visible startup error per §16.1.
    const initial = yield* loadAndParse(resolvedPath);
    yield* validateForDispatch(initial);

    const ref = yield* SubscriptionRef.make(initial);

    yield* log.info({
      msg: "workflow loaded",
      path: resolvedPath,
      max_turns: initial.config.agent_runner.max_turns,
      polling_interval_ms: initial.config.polling.interval_ms,
    });

    // Queue carries debounced reload triggers from the fs.watch callback into
    // the Effect-land processor fiber. We don't carry the event name — the
    // processor always re-reads the file, which sidesteps editor-specific
    // event ordering quirks (rename vs change, multiple writes, etc.).
    const events = yield* Queue.unbounded<void>();

    // Register an Effect-land finalizer that shuts the queue at scope close,
    // which in turn unblocks and drains the processor fiber forked below.
    yield* Effect.addFinalizer(() => Queue.shutdown(events));

    // Open the native fs.watch in a finalized scope so the fd is always
    // released, even if the processor fiber crashes for an unrelated reason.
    const watchedDir = dirname(resolvedPath);
    const watchedName = basename(resolvedPath);
    const watcher: FSWatcher = yield* Effect.acquireRelease(
      Effect.sync(() =>
        fsWatch(watchedDir, { persistent: false }, (_evt, fname) => {
          // The fname callback argument can be null on some platforms; when
          // unknown we still trigger a reload because the only file we care
          // about is in `watchedDir`.
          if (fname === null || fname === watchedName) {
            // The queue is unbounded, so offer cannot fail synchronously. We
            // use the fire-and-forget runtime hop (`runFork`) because the
            // fs.watch callback runs outside of any Effect fiber.
            Effect.runFork(Queue.offer(events, undefined));
          }
        }),
      ),
      (w) => Effect.sync(() => w.close()),
    );
    // Hold a reference to silence "unused" lints in case future code needs to
    // poke the watcher directly. The acquireRelease above owns its lifecycle.
    void watcher;

    // Processor fiber: stream events out of the queue, debounce bursts (per
    // editors that fire 3-5 events per save), and on each settled event
    // re-read + re-parse the file. Invalid content is logged at warn level
    // and the prior good definition is preserved (§6.2).
    const processor = Stream.fromQueue(events).pipe(
      Stream.debounce(Duration.millis(debounceMs)),
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const result = yield* Effect.either(loadAndParse(resolvedPath));
          if (result._tag === "Left") {
            yield* log.warn({
              msg: "workflow reload failed; keeping last known good",
              path: resolvedPath,
              error: formatFailure(result.left),
            });
            return;
          }
          const next = result.right;
          const prev = yield* SubscriptionRef.get(ref);
          yield* SubscriptionRef.set(ref, next);
          yield* log.info({
            msg: "workflow reloaded",
            path: resolvedPath,
            diff: summarizeDiff(prev, next),
          });
        }),
      ),
    );

    // Fork the processor into the current scope. When the scope closes the
    // queue is shut down (finalizer above), which terminates the stream and
    // the fiber exits cleanly.
    yield* Effect.forkScoped(processor);

    const service: WorkflowLoaderService = {
      current: SubscriptionRef.get(ref),
      changes: ref.changes,
      validateForDispatch: Effect.flatMap(SubscriptionRef.get(ref), (wf) =>
        validateForDispatch(wf),
      ),
    };
    return service;
  });
