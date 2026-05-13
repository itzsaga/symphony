// Unit tests for the Logger observability service.
// Verifies JSONL emission, FiberRef-scoped context, ring-buffer eviction, and sink-failure isolation.
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  DEFAULT_CAPACITY,
  Logger,
  LoggerLive,
  type LogRecord,
  type LogSink,
  layer,
  recentEvents,
  withIssue,
  withSession,
} from "../../../src/observability/Logger.ts";

/** Create an in-memory sink that records every line written to it. */
const captureSink = (): { sink: LogSink; lines: ReadonlyArray<string> } => {
  const lines: Array<string> = [];
  return {
    sink: { write: (line) => void lines.push(line) },
    get lines() {
      return lines;
    },
  };
};

describe("Logger", () => {
  it("emits parseable JSON lines containing timestamp + level + payload", async () => {
    const captured = captureSink();
    const program = Effect.gen(function* () {
      const log = yield* Logger;
      yield* log.info({ msg: "hello", port: 8080 });
      yield* log.error({ msg: "boom", code: 17 });
    });
    await Effect.runPromise(
      program.pipe(Effect.provide(layer({ sink: captured.sink }))),
    );
    expect(captured.lines).toHaveLength(2);
    const first = JSON.parse(captured.lines[0]!) as LogRecord;
    const second = JSON.parse(captured.lines[1]!) as LogRecord;
    expect(first.level).toBe("info");
    expect(first.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
    );
    expect(first["msg"]).toBe("hello");
    expect(first["port"]).toBe(8080);
    expect(second.level).toBe("error");
    expect(second["code"]).toBe(17);
  });

  it("withIssue merges fields only inside the wrapped scope", async () => {
    const captured = captureSink();
    const program = Effect.gen(function* () {
      const log = yield* Logger;
      yield* log.info({ msg: "before" });
      yield* withIssue({ issue_id: "abc", issue_identifier: "MT-1" })(
        Effect.gen(function* () {
          const inner = yield* Logger;
          yield* inner.info({ msg: "inside" });
        }),
      );
      yield* log.info({ msg: "after" });
    });
    await Effect.runPromise(
      program.pipe(Effect.provide(layer({ sink: captured.sink }))),
    );
    expect(captured.lines).toHaveLength(3);
    const [before, inside, after] = captured.lines.map(
      (line) => JSON.parse(line) as LogRecord,
    );
    expect(before).not.toHaveProperty("issue_id");
    expect(before).not.toHaveProperty("issue_identifier");
    expect(inside!.issue_id).toBe("abc");
    expect(inside!.issue_identifier).toBe("MT-1");
    expect(after).not.toHaveProperty("issue_id");
    expect(after).not.toHaveProperty("issue_identifier");
  });

  it("withSession merges session_id only inside the wrapped scope", async () => {
    const captured = captureSink();
    const program = withSession({ session_id: "sess-9" })(
      Effect.gen(function* () {
        const log = yield* Logger;
        yield* log.info({ msg: "in-session" });
      }),
    ).pipe(
      Effect.flatMap(() =>
        Effect.gen(function* () {
          const log = yield* Logger;
          yield* log.info({ msg: "out-of-session" });
        }),
      ),
    );
    await Effect.runPromise(
      program.pipe(Effect.provide(layer({ sink: captured.sink }))),
    );
    const records = captured.lines.map((line) => JSON.parse(line) as LogRecord);
    expect(records).toHaveLength(2);
    expect(records[0]!.session_id).toBe("sess-9");
    expect(records[1]).not.toHaveProperty("session_id");
  });

  it("nested context merges parent + child fields", async () => {
    const captured = captureSink();
    const program = withSession({ session_id: "S" })(
      withIssue({ issue_id: "I", issue_identifier: "MT-5" })(
        Effect.gen(function* () {
          const log = yield* Logger;
          yield* log.info({ msg: "nested" });
        }),
      ),
    );
    await Effect.runPromise(
      program.pipe(Effect.provide(layer({ sink: captured.sink }))),
    );
    const record = JSON.parse(captured.lines[0]!) as LogRecord;
    expect(record.session_id).toBe("S");
    expect(record.issue_id).toBe("I");
    expect(record.issue_identifier).toBe("MT-5");
  });

  it("ring buffer drops oldest records when full", async () => {
    const captured = captureSink();
    const capacity = 3;
    const program = Effect.gen(function* () {
      const log = yield* Logger;
      for (let i = 0; i < 5; i++) {
        yield* log.info({ msg: "n", i });
      }
      return yield* recentEvents;
    });
    const events = await Effect.runPromise(
      program.pipe(
        Effect.provide(layer({ sink: captured.sink, capacity })),
      ),
    );
    expect(events).toHaveLength(capacity);
    const indices = events.map((e) => e["i"]);
    expect(indices).toEqual([2, 3, 4]);
  });

  it("sink failure does not abort the parent fiber", async () => {
    let written = 0;
    const flakySink: LogSink = {
      write: (_line) => {
        written++;
        throw new Error("sink exploded");
      },
    };
    const program = Effect.gen(function* () {
      const log = yield* Logger;
      yield* log.info({ msg: "first" });
      yield* log.info({ msg: "second" });
      return yield* recentEvents;
    });
    const events = await Effect.runPromise(
      program.pipe(Effect.provide(layer({ sink: flakySink }))),
    );
    // The fiber kept running despite the sink throwing on every write,
    // and both records still landed in the ring buffer.
    expect(written).toBe(2);
    expect(events).toHaveLength(2);
  });

  it("recentEvents returns a snapshot that callers cannot mutate the buffer through", async () => {
    const captured = captureSink();
    const program = Effect.gen(function* () {
      const log = yield* Logger;
      yield* log.info({ msg: "one" });
      const first = yield* recentEvents;
      yield* log.info({ msg: "two" });
      const second = yield* recentEvents;
      return { first, second };
    });
    const { first, second } = await Effect.runPromise(
      program.pipe(Effect.provide(layer({ sink: captured.sink }))),
    );
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
  });

  it("LoggerLive uses the default capacity of 500", async () => {
    expect(DEFAULT_CAPACITY).toBe(500);
    // Layer is constructible without throwing.
    const program = Effect.gen(function* () {
      const log = yield* Logger;
      return typeof log.info;
    });
    const result = await Effect.runPromise(
      program.pipe(Effect.provide(LoggerLive)),
    );
    expect(result).toBe("function");
  });

  it("safely serializes circular references", async () => {
    const captured = captureSink();
    interface Cyclic {
      name: string;
      self?: Cyclic;
    }
    const cyclic: Cyclic = { name: "ouroboros" };
    cyclic.self = cyclic;
    const program = Effect.gen(function* () {
      const log = yield* Logger;
      yield* log.warn({ msg: "loop", cyclic });
    });
    await Effect.runPromise(
      program.pipe(Effect.provide(layer({ sink: captured.sink }))),
    );
    expect(captured.lines).toHaveLength(1);
    const parsed = JSON.parse(captured.lines[0]!) as {
      cyclic: { name: string; self: string };
    };
    expect(parsed.cyclic.name).toBe("ouroboros");
    expect(parsed.cyclic.self).toBe("<circular>");
  });
});
