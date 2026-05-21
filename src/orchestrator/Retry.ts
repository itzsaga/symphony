// Pure retry-backoff math + retry-timer fiber lifecycle helpers per spec §8.4.
// Computes continuation/failure delays and tracks the per-issue timer fiber map.
import { Duration, Effect, Fiber, Ref } from "effect";

/* -------------------------------------------------------------------------- */
/* Constants — kept in lockstep with `src/orchestrator/State.ts`.             */
/* -------------------------------------------------------------------------- */

/** Continuation retry delay after a clean worker exit (§8.4). */
export const CONTINUATION_RETRY_DELAY_MS = 1_000;

/** Base for the exponential-backoff retry formula (§8.4). */
export const FAILURE_RETRY_BASE_MS = 10_000;

/**
 * Default cap on the exponential-backoff result. Spec §5.3.5 names
 * `agent.max_retry_backoff_ms` with a default of 5 minutes; the reducer
 * (`State.onWorkerExited`) and the reconciler (`Reconcile.reconcileStalled`)
 * both honor this default while the orchestrator's runtime `handleRetryFire`
 * reads the live `config.agent_runner.max_retry_backoff_ms` instead. The two
 * paths converge whenever the config carries the default value.
 */
export const DEFAULT_MAX_RETRY_BACKOFF_MS = 300_000;

/* -------------------------------------------------------------------------- */
/* Backoff math.                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Compute the exponential-backoff delay for a failure retry, capped at
 * `capMs`. Formula per spec §8.4:
 *
 *   delay = min(10_000 * 2^(attempt - 1), capMs)
 *
 * `attempt` is 1-indexed; the first retry uses 10s. `attempt <= 0` is
 * clamped to 1 so a caller that subtracts past zero doesn't get a negative
 * exponent (and thus a sub-second delay).
 */
export const computeFailureBackoffMs = (
  attempt: number,
  capMs: number,
): number => {
  const exponent = Math.max(0, attempt - 1);
  const raw = FAILURE_RETRY_BASE_MS * Math.pow(2, exponent);
  return Math.min(raw, capMs);
};

/**
 * Compute the continuation-retry delay after a clean worker exit. Always
 * 1 second per spec §8.4 ("the continuation retry uses a fixed delay
 * regardless of attempt"). Kept as a function rather than the bare constant
 * so the call site reads symmetrically with `computeFailureBackoffMs`.
 */
export const computeContinuationDelayMs = (): number =>
  CONTINUATION_RETRY_DELAY_MS;

/* -------------------------------------------------------------------------- */
/* Retry-timer fiber registry.                                                */
/*                                                                            */
/* The Orchestrator owns one of these and stores it in its scope. The map     */
/* keeps a per-issue handle so a new `ScheduleRetry` can interrupt an         */
/* existing timer before forking the new one (§8.4 "Cancel any existing      */
/* retry timer for the same issue").                                         */
/* -------------------------------------------------------------------------- */

/** Type alias mirrors the field on `RetryEntry.timer_handle`. */
export type RetryFiber = Fiber.Fiber<void, never>;

/** Per-issue registry of outstanding retry-timer fibers. */
export interface RetryRegistry {
  /** Cancel the existing fiber (if any) and store the new one under `issueId`. */
  readonly replace: (
    issueId: string,
    fiber: RetryFiber,
  ) => Effect.Effect<void>;
  /** Cancel and remove the timer fiber for `issueId`, if any. */
  readonly cancel: (issueId: string) => Effect.Effect<void>;
  /** Cancel every outstanding timer fiber (used on orchestrator shutdown). */
  readonly cancelAll: Effect.Effect<void>;
}

/** Build an empty `RetryRegistry`. Backed by a `Ref<Map<string, Fiber>>`. */
export const makeRetryRegistry: Effect.Effect<RetryRegistry> = Effect.gen(
  function* () {
    const ref = yield* Ref.make(new Map<string, RetryFiber>());

    const replace = (
      issueId: string,
      fiber: RetryFiber,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const m = yield* Ref.get(ref);
        const prev = m.get(issueId);
        const next = new Map(m);
        next.set(issueId, fiber);
        yield* Ref.set(ref, next);
        if (prev !== undefined) {
          // Fire-and-forget the interrupt of the prior fiber. We don't await
          // it because the caller is forking a fresh timer right after and
          // doesn't need to block on the old one being torn down.
          yield* Fiber.interrupt(prev).pipe(Effect.forkDaemon);
        }
      });

    const cancel = (issueId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const m = yield* Ref.get(ref);
        const prev = m.get(issueId);
        if (prev === undefined) return;
        const next = new Map(m);
        next.delete(issueId);
        yield* Ref.set(ref, next);
        yield* Fiber.interrupt(prev).pipe(Effect.forkDaemon);
      });

    const cancelAll: Effect.Effect<void> = Effect.gen(function* () {
      const m = yield* Ref.get(ref);
      yield* Ref.set(ref, new Map());
      for (const fiber of m.values()) {
        yield* Fiber.interrupt(fiber).pipe(Effect.forkDaemon);
      }
    });

    const registry: RetryRegistry = { replace, cancel, cancelAll };
    return registry;
  },
);

/* -------------------------------------------------------------------------- */
/* Timer fiber body.                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Sleep for `delayMs` and then run `onFire`. Returns an Effect that the
 * caller forks into the orchestrator's scope. Sleep uses `Effect.sleep`
 * (Duration), which respects `TestClock` in tests.
 *
 * The returned Effect's failure channel is `never` so the caller can model
 * the stored fiber as `Fiber.Fiber<void, never>` and matches
 * `RetryEntry.timer_handle`'s typing.
 */
export const retryTimerEffect = (
  delayMs: number,
  onFire: Effect.Effect<void>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Effect.sleep(Duration.millis(delayMs));
    yield* onFire;
  });
