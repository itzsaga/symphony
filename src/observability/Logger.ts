// Logger service for Symphony v1.
// Structured JSONL records to stderr + in-memory ring buffer with FiberRef-scoped context.
import { Context, Effect, FiberRef, Layer, Ref, Schema } from "effect";

/** Allowed log levels. */
export const LogLevel = Schema.Literal("debug", "info", "warn", "error");
export type LogLevel = Schema.Schema.Type<typeof LogLevel>;

/**
 * Schema for an emitted log record. Context fields (issue_id, issue_identifier,
 * session_id) are optional and merged in only when set via the corresponding
 * scope helper.
 */
export const LogRecord = Schema.Struct(
  {
    timestamp: Schema.String,
    level: LogLevel,
    issue_id: Schema.optional(Schema.String),
    issue_identifier: Schema.optional(Schema.String),
    session_id: Schema.optional(Schema.String),
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type LogRecord = Schema.Schema.Type<typeof LogRecord>;

/** FiberRef-scoped context fields merged into every record while in scope. */
export interface LogContext {
  readonly issue_id?: string;
  readonly issue_identifier?: string;
  readonly session_id?: string;
}

/** Sink interface — receives a JSON-serialized line (no trailing newline). */
export interface LogSink {
  readonly write: (line: string) => void;
}

/** Default capacity of the ring buffer if none is specified. */
export const DEFAULT_CAPACITY = 500;

/**
 * Fixed-capacity FIFO buffer of log records. On overflow the oldest record is
 * dropped. Pure data structure: callers wrap mutations in a Ref for safety.
 */
class CircularBuffer {
  private readonly items: Array<LogRecord> = [];
  constructor(public readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(
        `Logger capacity must be a positive integer, got ${capacity}`,
      );
    }
  }
  push(record: LogRecord): void {
    this.items.push(record);
    if (this.items.length > this.capacity) {
      this.items.shift();
    }
  }
  snapshot(): ReadonlyArray<LogRecord> {
    return this.items.slice();
  }
}

/**
 * JSON.stringify replacer that drops `undefined` values and substitutes a
 * sentinel for circular references. JSON.stringify already drops `undefined`
 * in objects natively; the replacer is here primarily to handle cycles.
 */
const safeStringify = (value: unknown): string => {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, v: unknown) => {
      if (v === undefined) return undefined;
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "<circular>";
        seen.add(v);
      }
      return v;
    });
  } catch (err) {
    if (err instanceof TypeError) {
      return JSON.stringify({ error: "<unserializable>", message: err.message });
    }
    throw err;
  }
};

/**
 * Logger service interface. All methods return `Effect<void>` and never fail —
 * sink errors are swallowed per spec §13.2.
 *
 * Context merging is implemented by the module-level `withIssue` / `withSession`
 * / `withContext` helpers, which manipulate a FiberRef directly. Keeping that
 * concern off the service interface lets the helpers operate without first
 * requiring the Logger service in their environment.
 */
export interface LoggerService {
  readonly debug: (payload: Record<string, unknown>) => Effect.Effect<void>;
  readonly info: (payload: Record<string, unknown>) => Effect.Effect<void>;
  readonly warn: (payload: Record<string, unknown>) => Effect.Effect<void>;
  readonly error: (payload: Record<string, unknown>) => Effect.Effect<void>;
  readonly recentEvents: Effect.Effect<ReadonlyArray<LogRecord>>;
}

/** The Logger service tag. */
export class Logger extends Context.Tag("symphony/observability/Logger")<
  Logger,
  LoggerService
>() {}

/**
 * Default sink: write a single line to `process.stderr` with a trailing
 * newline. Wrapped in try/catch so a closed/broken stderr never throws.
 */
const stderrSink: LogSink = {
  write: (line: string): void => {
    try {
      process.stderr.write(`${line}\n`);
    } catch {
      // Per spec §13.2: logging sink failures must not crash the orchestrator.
      // Swallow and continue.
    }
  },
};

/** FiberRef holding the currently-merged log context for a fiber subtree. */
const contextRef: FiberRef.FiberRef<LogContext> =
  FiberRef.unsafeMake<LogContext>({});

/**
 * Build a Logger service that writes to `sink` and retains the most recent
 * `capacity` records (default {@link DEFAULT_CAPACITY}).
 */
const make = (
  sink: LogSink,
  capacity: number,
): Effect.Effect<LoggerService> =>
  Effect.gen(function* () {
    const bufferRef = yield* Ref.make(new CircularBuffer(capacity));

    const emit = (
      level: LogLevel,
      payload: Record<string, unknown>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const ctx = yield* FiberRef.get(contextRef);
        const record: LogRecord = {
          ...payload,
          ...ctx,
          timestamp: new Date().toISOString(),
          level,
        };
        // Push into ring buffer. The buffer is in-process state, so failures
        // here would only be programmer errors (e.g. a malformed CircularBuffer);
        // we let those surface as defects rather than typed failures.
        yield* Ref.update(bufferRef, (buf) => {
          buf.push(record);
          return buf;
        });
        // Sink write. Wrapped in Effect.sync because `sink.write` already
        // swallows its own errors (see stderrSink), but if a custom sink
        // throws synchronously we still must not abort the parent fiber.
        yield* Effect.sync(() => {
          try {
            sink.write(safeStringify(record));
          } catch {
            // Per spec §13.2, swallow and continue.
          }
        });
      });

    const service: LoggerService = {
      debug: (payload) => emit("debug", payload),
      info: (payload) => emit("info", payload),
      warn: (payload) => emit("warn", payload),
      error: (payload) => emit("error", payload),
      recentEvents: Effect.map(Ref.get(bufferRef), (buf) => buf.snapshot()),
    };
    return service;
  });

/**
 * Construct a Logger Layer with a custom sink and/or capacity. Useful for
 * tests that need to capture emitted lines.
 */
export const layer = (options?: {
  readonly sink?: LogSink;
  readonly capacity?: number;
}): Layer.Layer<Logger> =>
  Layer.effect(
    Logger,
    make(options?.sink ?? stderrSink, options?.capacity ?? DEFAULT_CAPACITY),
  );

/** Default Live Layer: writes to stderr with the default capacity. */
export const LoggerLive: Layer.Layer<Logger> = layer();

/**
 * Run `effect` with the supplied context fields merged into every emitted log
 * record while the effect is in scope. Merge is FiberRef-scoped: nested
 * `withContext` calls layer their fields on top of any outer fields, and the
 * outer state is restored automatically when the inner effect exits.
 */
export const withContext =
  (fields: LogContext) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(FiberRef.get(contextRef), (current) =>
      Effect.locally(effect, contextRef, { ...current, ...fields }),
    );

/**
 * Run `effect` with `issue_id` and `issue_identifier` merged into every
 * emitted log record while the effect is in scope.
 */
export const withIssue = (fields: {
  readonly issue_id: string;
  readonly issue_identifier: string;
}): (<A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>) =>
  withContext(fields);

/**
 * Run `effect` with `session_id` merged into every emitted log record while
 * the effect is in scope.
 */
export const withSession = (fields: {
  readonly session_id: string;
}): (<A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>) =>
  withContext(fields);

/** Read the current ring-buffer contents. Convenience for the HTTP dashboard. */
export const recentEvents: Effect.Effect<ReadonlyArray<LogRecord>, never, Logger> =
  Effect.flatMap(Logger, (log) => log.recentEvents);
