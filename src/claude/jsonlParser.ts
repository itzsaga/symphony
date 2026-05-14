// Line-delimited JSON parser with multi-line accumulation + buffer-size cap.
// Handles the SDK contract: every JSON value is a complete top-level object, but the CLI may pretty-print across lines.
import { Data } from "effect";

/**
 * Per-frame buffer cap. Mirrors the Python SDK's
 * `_DEFAULT_MAX_BUFFER_SIZE = 1024 * 1024` (`subprocess_cli.py:30-31`).
 * Surfacing this as an exported constant makes the cap testable and lets
 * callers override it via {@link makeJsonlParser}.
 */
export const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * Tagged error: a single in-flight JSON object exceeded the per-frame buffer
 * cap (research §9). The carried `bytes_buffered` is the size of the
 * unparsed accumulator at the moment we gave up; useful for operator-visible
 * logging without dumping potentially-sensitive partial JSON.
 */
export class StreamDecodeError extends Data.TaggedError("StreamDecodeError")<{
  readonly reason: string;
  readonly bytes_buffered: number;
  readonly cap_bytes: number;
}> {}

/**
 * Output of a single `feed` call. `frames` is the list of complete JSON values
 * parsed from the input chunk (zero, one, or many); `dropped_lines` is the
 * list of non-JSON lines we skipped (e.g. `[SandboxDebug]` decorations) so
 * the caller can surface them at debug level rather than swallowing silently.
 *
 * `error`, when set, is a fatal buffer-overflow condition. Once a parser
 * returns an error all subsequent `feed`s on the same parser also return
 * the error — the caller is expected to abort the surrounding stream.
 */
export interface ParseResult {
  readonly frames: ReadonlyArray<unknown>;
  readonly dropped_lines: ReadonlyArray<string>;
  readonly error: StreamDecodeError | null;
}

/**
 * Stateful line-delimited JSON parser. Construct once per subprocess; feed
 * decoded UTF-8 chunks through {@link JsonlParser.feed}; call
 * {@link JsonlParser.finish} after EOF to surface any stranded buffer
 * contents (which would only ever indicate a truncated stream).
 *
 * Multi-line semantics: the CLI is allowed to emit a single JSON value
 * pretty-printed across multiple lines (`research §1`). We therefore
 * accumulate complete LINES into an inner string buffer and try
 * `JSON.parse` on each cumulative bracket-balanced fragment. The first
 * successful parse pops that fragment off the front of the buffer; any
 * remaining tail (partial next object) stays in the buffer for the next
 * feed.
 *
 * Single-line is the dominant case and parses in O(n); multi-line incurs
 * a few extra `JSON.parse` attempts per object but is rare in practice.
 */
export interface JsonlParser {
  readonly feed: (chunk: string) => ParseResult;
  readonly finish: () => ParseResult;
}

/** Construct a parser bound to `cap_bytes` (default {@link DEFAULT_MAX_BUFFER_BYTES}). */
export const makeJsonlParser = (
  cap_bytes: number = DEFAULT_MAX_BUFFER_BYTES,
): JsonlParser => {
  // Single growing string buffer. We append the incoming chunk verbatim and
  // walk it line-by-line; any line that does not on its own JSON-parse stays
  // joined to subsequent lines until the cumulative slice does parse (the
  // multi-line case). Lines that aren't JSON at all (no leading `{` or `[`)
  // are treated as drop-lines and reported separately.
  let buffer = "";
  // When set, every subsequent feed returns the same error. Mirrors the
  // Python SDK's behavior where `CLIJSONDecodeError` is fatal to the stream.
  let stuckError: StreamDecodeError | null = null;

  /**
   * Try to peel one complete JSON value off the front of `buffer`. Returns
   * the parsed value + the byte length of the consumed prefix, or `null`
   * if no complete value is available yet.
   *
   * Strategy: walk the buffer character by character tracking string
   * literal state and bracket depth. When depth returns to zero on a
   * non-string boundary, the prefix `[0..i+1]` is a syntactically complete
   * top-level value; attempt `JSON.parse` on it. If the parse succeeds,
   * return the value and consumed length. If the parse fails (e.g. due to
   * a token issue) we treat it as malformed and return a fail signal so
   * the caller can drop just that fragment.
   *
   * This parser is intentionally simple and does not accept JSON values
   * other than objects / arrays / primitive root types — but per the
   * SDK contract the CLI only ever emits top-level objects.
   */
  const tryPeel = (): {
    readonly kind: "ok";
    readonly value: unknown;
    readonly consumed: number;
  } | {
    readonly kind: "incomplete";
  } | {
    readonly kind: "malformed";
    readonly consumed: number;
  } | null => {
    let i = 0;
    // Skip leading whitespace / blank lines / non-json decoration characters
    // up to the first `{` or `[`. Anything before the first opener is
    // surfaced via the line-walker as a dropped non-JSON line; the peel
    // path only runs on a buffer whose first non-whitespace char is `{`/`[`.
    while (i < buffer.length && (buffer.charCodeAt(i) === 0x20 || buffer.charCodeAt(i) === 0x09 || buffer.charCodeAt(i) === 0x0a || buffer.charCodeAt(i) === 0x0d)) {
      i += 1;
    }
    if (i >= buffer.length) return null;
    const head = buffer[i];
    if (head !== "{" && head !== "[") {
      // Not a JSON value — caller handles via line-walker.
      return null;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    let started = false;
    for (let j = i; j < buffer.length; j += 1) {
      const ch = buffer[j];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{" || ch === "[") {
        depth += 1;
        started = true;
        continue;
      }
      if (ch === "}" || ch === "]") {
        depth -= 1;
        if (started && depth === 0) {
          const slice = buffer.slice(i, j + 1);
          try {
            const parsed = JSON.parse(slice) as unknown;
            return { kind: "ok", value: parsed, consumed: j + 1 };
          } catch {
            // Slice was bracket-balanced but JSON.parse rejected it.
            // Drop the fragment and let the caller continue; the SDK
            // similarly logs and skips malformed JSON (`message_parser.py`).
            return { kind: "malformed", consumed: j + 1 };
          }
        }
      }
    }
    return { kind: "incomplete" };
  };

  /**
   * Walk the buffer and try to peel as many complete JSON values as possible.
   * Lines that begin (after whitespace) with anything other than `{` / `[`
   * are treated as drop-lines: we slice them out at the next `\n` and
   * report them via `dropped_lines` so the caller can debug-log them.
   */
  const drain = (): ParseResult => {
    const frames: Array<unknown> = [];
    const dropped: Array<string> = [];

    // Outer loop: each iteration either peels a JSON value, drops a non-JSON
    // line, or breaks because we need more bytes to make progress.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Skip leading whitespace WITHIN the buffer to find the next item.
      let cursor = 0;
      while (
        cursor < buffer.length &&
        (buffer.charCodeAt(cursor) === 0x20 ||
          buffer.charCodeAt(cursor) === 0x09 ||
          buffer.charCodeAt(cursor) === 0x0a ||
          buffer.charCodeAt(cursor) === 0x0d)
      ) {
        cursor += 1;
      }
      if (cursor === buffer.length) {
        // Buffer is whitespace-only; consume it and exit.
        buffer = "";
        break;
      }
      // Drop the whitespace prefix if any — keeps `tryPeel`'s consumed
      // index aligned to the start of the buffer.
      if (cursor > 0) buffer = buffer.slice(cursor);

      const head = buffer[0];
      if (head !== "{" && head !== "[") {
        // Non-JSON line — slice up to `\n` (or end of buffer if no newline
        // yet). If no newline exists we have to wait for more bytes; the
        // line might still be in flight.
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl);
        if (line.trim().length > 0) dropped.push(line);
        buffer = buffer.slice(nl + 1);
        continue;
      }

      const peeled = tryPeel();
      if (peeled === null || peeled.kind === "incomplete") {
        // Need more bytes to complete the current object. Check the cap
        // here to surface overflow before the buffer balloons further.
        if (buffer.length > cap_bytes) {
          stuckError = new StreamDecodeError({
            reason:
              "JSON object exceeded buffer cap before a complete top-level value parsed",
            bytes_buffered: buffer.length,
            cap_bytes,
          });
          return { frames, dropped_lines: dropped, error: stuckError };
        }
        break;
      }
      if (peeled.kind === "malformed") {
        // Treat as a dropped line: report what we tried to parse as a
        // single decorated line and advance past it. The downstream
        // schema-decode layer also catches malformed payloads, but a
        // bracket-balanced JSON.parse failure is rare enough to warrant
        // its own debug surface.
        const slice = buffer.slice(0, peeled.consumed);
        dropped.push(slice);
        buffer = buffer.slice(peeled.consumed);
        continue;
      }
      frames.push(peeled.value);
      buffer = buffer.slice(peeled.consumed);
    }

    return { frames, dropped_lines: dropped, error: null };
  };

  const feed = (chunk: string): ParseResult => {
    if (stuckError !== null) {
      return { frames: [], dropped_lines: [], error: stuckError };
    }
    if (chunk.length === 0) {
      return { frames: [], dropped_lines: [], error: null };
    }
    buffer = buffer + chunk;
    return drain();
  };

  const finish = (): ParseResult => {
    if (stuckError !== null) {
      return { frames: [], dropped_lines: [], error: stuckError };
    }
    if (buffer.length === 0) {
      return { frames: [], dropped_lines: [], error: null };
    }
    // EOF with bytes still in buffer: try one final drain. Any leftover
    // bytes after that are surfaced as a dropped tail so the operator can
    // see them, but do not raise — the stream just ended mid-frame.
    const result = drain();
    const trailing = buffer;
    buffer = "";
    if (trailing.trim().length === 0) return result;
    return {
      frames: result.frames,
      dropped_lines: [...result.dropped_lines, trailing],
      error: result.error,
    };
  };

  return { feed, finish };
};
