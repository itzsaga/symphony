// Unit tests for src/orchestrator/Retry.ts: backoff math and the registry's
// cancel-then-replace semantics.
import { describe, expect, it } from "bun:test";
import { Deferred, Effect, Fiber, Ref, TestClock, TestContext } from "effect";
import {
  CONTINUATION_RETRY_DELAY_MS,
  FAILURE_RETRY_BASE_MS,
  computeContinuationDelayMs,
  computeFailureBackoffMs,
  makeRetryRegistry,
  retryTimerEffect,
} from "../../../src/orchestrator/Retry.ts";

/**
 * Poll an Effect-returning predicate until it returns true. Used for
 * fiber-interrupt observations where we need the interrupt finalizer
 * to settle before the next assertion runs. Bounded at ~2s of real time
 * to avoid hanging the test runner on a regression.
 */
const pollUntilTrue = (
  read: () => Effect.Effect<boolean>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let i = 0; i < 200; i++) {
      const ok = yield* read();
      if (ok) return;
      yield* Effect.sleep("10 millis");
    }
    throw new Error("pollUntilTrue exceeded the 2s budget");
  });

const pollUntilCount = (
  read: () => Effect.Effect<number>,
  atLeast: number,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let i = 0; i < 200; i++) {
      const v = yield* read();
      if (v >= atLeast) return;
      yield* Effect.sleep("10 millis");
    }
    throw new Error("pollUntilCount exceeded the 2s budget");
  });

/* -------------------------------------------------------------------------- */
/* Backoff math.                                                              */
/* -------------------------------------------------------------------------- */

describe("computeFailureBackoffMs", () => {
  it("returns 10s on attempt 1", () => {
    expect(computeFailureBackoffMs(1, 300_000)).toBe(FAILURE_RETRY_BASE_MS);
  });

  it("returns 20s on attempt 2", () => {
    expect(computeFailureBackoffMs(2, 300_000)).toBe(20_000);
  });

  it("returns 40s on attempt 3", () => {
    expect(computeFailureBackoffMs(3, 300_000)).toBe(40_000);
  });

  it("returns 160s on attempt 5", () => {
    expect(computeFailureBackoffMs(5, 300_000)).toBe(160_000);
  });

  it("caps at the supplied max", () => {
    expect(computeFailureBackoffMs(20, 300_000)).toBe(300_000);
    expect(computeFailureBackoffMs(100, 300_000)).toBe(300_000);
  });

  it("respects a smaller cap", () => {
    expect(computeFailureBackoffMs(3, 30_000)).toBe(30_000);
  });

  it("clamps attempt <= 0 to attempt 1 behavior (10s)", () => {
    expect(computeFailureBackoffMs(0, 300_000)).toBe(FAILURE_RETRY_BASE_MS);
    expect(computeFailureBackoffMs(-5, 300_000)).toBe(FAILURE_RETRY_BASE_MS);
  });
});

describe("computeContinuationDelayMs", () => {
  it("always returns the fixed continuation delay", () => {
    expect(computeContinuationDelayMs()).toBe(CONTINUATION_RETRY_DELAY_MS);
    expect(CONTINUATION_RETRY_DELAY_MS).toBe(1_000);
  });
});

/* -------------------------------------------------------------------------- */
/* RetryRegistry.                                                              */
/* -------------------------------------------------------------------------- */

describe("makeRetryRegistry", () => {
  it("replace interrupts the prior fiber for the same issue id", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const reg = yield* makeRetryRegistry;
        const interrupted = yield* Ref.make(false);

        // First fiber: never-completes, sets the flag on interrupt finalizer.
        const firstFiber = yield* Effect.forkDaemon(
          Effect.never.pipe(
            Effect.onInterrupt(() => Ref.set(interrupted, true)),
          ),
        );
        yield* reg.replace("issue-1", firstFiber);
        // Confirm the first fiber is alive before we replace it.
        expect((yield* Fiber.status(firstFiber))._tag).not.toBe("Done");

        // Second fiber: another never-completes — we only care that the
        // first was interrupted by the replacement.
        const secondFiber = yield* Effect.forkDaemon(Effect.never);
        yield* reg.replace("issue-1", secondFiber);

        // Wait until the first fiber's interrupt finalizer set the flag.
        yield* pollUntilTrue(() => Ref.get(interrupted));
        const observed = yield* Ref.get(interrupted);
        expect(observed).toBe(true);

        // Clean up the second fiber so the scope can close.
        yield* Fiber.interrupt(secondFiber).pipe(Effect.forkDaemon);
      }),
    );
    await Effect.runPromise(program);
  });

  it("cancel interrupts and removes the issue's timer fiber", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const reg = yield* makeRetryRegistry;
        const interrupted = yield* Ref.make(false);
        const fiber = yield* Effect.forkDaemon(
          Effect.never.pipe(
            Effect.onInterrupt(() => Ref.set(interrupted, true)),
          ),
        );
        yield* reg.replace("issue-1", fiber);
        yield* reg.cancel("issue-1");
        yield* pollUntilTrue(() => Ref.get(interrupted));
        expect(yield* Ref.get(interrupted)).toBe(true);
      }),
    );
    await Effect.runPromise(program);
  });

  it("cancel is a no-op when no fiber is registered for the issue", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const reg = yield* makeRetryRegistry;
        // Should not throw / fail.
        yield* reg.cancel("missing");
      }),
    );
    await Effect.runPromise(program);
  });

  it("cancelAll interrupts every registered fiber", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const reg = yield* makeRetryRegistry;
        const counter = yield* Ref.make(0);
        const make = () =>
          Effect.forkDaemon(
            Effect.never.pipe(
              Effect.onInterrupt(() => Ref.update(counter, (n) => n + 1)),
            ),
          );
        const a = yield* make();
        const b = yield* make();
        const c = yield* make();
        yield* reg.replace("a", a);
        yield* reg.replace("b", b);
        yield* reg.replace("c", c);
        yield* reg.cancelAll;
        yield* pollUntilCount(() => Ref.get(counter), 3);
        expect(yield* Ref.get(counter)).toBeGreaterThanOrEqual(3);
      }),
    );
    await Effect.runPromise(program);
  });
});

/* -------------------------------------------------------------------------- */
/* retryTimerEffect — uses TestClock for determinism.                         */
/* -------------------------------------------------------------------------- */

describe("retryTimerEffect", () => {
  it("fires onFire after the configured delay (TestClock)", async () => {
    const program = Effect.gen(function* () {
      const fired = yield* Deferred.make<true>();
      const onFire = Deferred.succeed(fired, true).pipe(Effect.asVoid);
      const fiber = yield* Effect.forkDaemon(retryTimerEffect(5_000, onFire));
      // Advance the clock past the delay.
      yield* TestClock.adjust("5 seconds");
      const result = yield* Deferred.await(fired);
      yield* Fiber.interrupt(fiber);
      return result;
    });
    const ran = await Effect.runPromise(
      program.pipe(Effect.provide(TestContext.TestContext)),
    );
    expect(ran).toBe(true);
  });

  it("does not fire onFire before the delay elapses", async () => {
    const program = Effect.gen(function* () {
      const fired = yield* Ref.make(false);
      const onFire = Ref.set(fired, true);
      const fiber = yield* Effect.forkDaemon(retryTimerEffect(10_000, onFire));
      // Advance 5s — less than the delay; onFire should NOT have run.
      yield* TestClock.adjust("5 seconds");
      const status = yield* Ref.get(fired);
      yield* Fiber.interrupt(fiber);
      return status;
    });
    const status = await Effect.runPromise(
      program.pipe(Effect.provide(TestContext.TestContext)),
    );
    expect(status).toBe(false);
  });
});
