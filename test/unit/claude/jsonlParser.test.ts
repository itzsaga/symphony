// Unit tests for the line-delimited JSON parser used to drive ClaudeSubprocess.incoming.
// Covers single-line, multi-line pretty-printed, dropped non-JSON, and overflow.
import { describe, expect, it } from "bun:test";
import { makeJsonlParser } from "../../../src/claude/jsonlParser.ts";

describe("jsonlParser — single-line", () => {
  it("parses one complete object per line", () => {
    const parser = makeJsonlParser();
    const result = parser.feed(
      `${JSON.stringify({ type: "system", subtype: "init" })}\n${JSON.stringify({
        type: "result",
        subtype: "success",
      })}\n`,
    );
    expect(result.error).toBeNull();
    expect(result.dropped_lines).toEqual([]);
    expect(result.frames.length).toBe(2);
    expect(result.frames[0]).toEqual({ type: "system", subtype: "init" });
    expect(result.frames[1]).toEqual({ type: "result", subtype: "success" });
  });

  it("buffers a partial object and completes it on the next feed", () => {
    const parser = makeJsonlParser();
    const r1 = parser.feed('{"type":"as');
    expect(r1.frames.length).toBe(0);
    expect(r1.error).toBeNull();
    const r2 = parser.feed('sistant","ok":true}\n');
    expect(r2.error).toBeNull();
    expect(r2.frames).toEqual([{ type: "assistant", ok: true }]);
  });
});

describe("jsonlParser — multi-line pretty-printed", () => {
  it("accumulates a pretty-printed object across newlines", () => {
    const parser = makeJsonlParser();
    const pretty = `{\n  "type": "result",\n  "subtype": "success",\n  "n": 1\n}\n`;
    const result = parser.feed(pretty);
    expect(result.error).toBeNull();
    expect(result.dropped_lines).toEqual([]);
    expect(result.frames).toEqual([{ type: "result", subtype: "success", n: 1 }]);
  });

  it("handles multi-line objects that contain string-embedded braces", () => {
    const parser = makeJsonlParser();
    const pretty = `{\n  "type": "user",\n  "msg": "she said {hi}"\n}\n`;
    const result = parser.feed(pretty);
    expect(result.frames).toEqual([{ type: "user", msg: "she said {hi}" }]);
  });

  it("handles escaped quotes inside string literals", () => {
    const parser = makeJsonlParser();
    const tricky = `{"type":"x","s":"a \\"quoted\\" b"}\n`;
    const result = parser.feed(tricky);
    expect(result.frames).toEqual([{ type: "x", s: 'a "quoted" b' }]);
  });
});

describe("jsonlParser — dropped non-JSON", () => {
  it("reports a [SandboxDebug] line as dropped without aborting the stream", () => {
    const parser = makeJsonlParser();
    const input =
      `[SandboxDebug] something happened\n${JSON.stringify({ type: "system", subtype: "init" })}\n`;
    const result = parser.feed(input);
    expect(result.error).toBeNull();
    // The parser is bracket-balanced so `[SandboxDebug]` looks superficially
    // like an array start; we report it as a malformed fragment plus the
    // trailing text as a non-JSON line. Either way the operator sees the
    // raw bytes via dropped_lines and the real frame still parses.
    expect(result.dropped_lines.length).toBeGreaterThanOrEqual(1);
    expect(result.dropped_lines.join(" ")).toContain("SandboxDebug");
    expect(result.frames).toEqual([{ type: "system", subtype: "init" }]);
  });

  it("drops a plain non-JSON line that doesn't look like an array", () => {
    const parser = makeJsonlParser();
    const input = `garbage data here\n${JSON.stringify({ type: "user" })}\n`;
    const result = parser.feed(input);
    expect(result.dropped_lines).toEqual(["garbage data here"]);
    expect(result.frames).toEqual([{ type: "user" }]);
  });

  it("blank lines do not appear as dropped lines", () => {
    const parser = makeJsonlParser();
    const input = `\n\n${JSON.stringify({ type: "user" })}\n\n`;
    const result = parser.feed(input);
    expect(result.dropped_lines).toEqual([]);
    expect(result.frames).toEqual([{ type: "user" }]);
  });
});

describe("jsonlParser — buffer overflow", () => {
  it("surfaces StreamDecodeError when a single object exceeds the cap", () => {
    const parser = makeJsonlParser(64);
    // Open an object then keep feeding bytes without ever closing it.
    const partial = `{"type":"assistant","blob":"`;
    let result = parser.feed(partial);
    expect(result.error).toBeNull();
    // One large unterminated string keeps the bracket depth at 1.
    result = parser.feed("X".repeat(200));
    expect(result.error).not.toBeNull();
    if (result.error === null) throw new Error("unreachable");
    expect(result.error._tag).toBe("StreamDecodeError");
    expect(result.error.cap_bytes).toBe(64);
    expect(result.error.bytes_buffered).toBeGreaterThan(64);
  });

  it("returns the same error on subsequent feeds (sticky)", () => {
    const parser = makeJsonlParser(32);
    parser.feed("{");
    const overflow = parser.feed("x".repeat(64));
    expect(overflow.error).not.toBeNull();
    const next = parser.feed("more bytes");
    expect(next.error).not.toBeNull();
    expect(next.frames).toEqual([]);
  });
});

describe("jsonlParser — finish()", () => {
  it("flushes a still-incomplete tail as a dropped fragment", () => {
    const parser = makeJsonlParser();
    parser.feed('{"type":"x"');
    const tail = parser.finish();
    expect(tail.frames).toEqual([]);
    expect(tail.dropped_lines.length).toBe(1);
    expect(tail.dropped_lines[0]).toContain('"type":"x"');
  });

  it("returns no dropped lines when the buffer is clean", () => {
    const parser = makeJsonlParser();
    parser.feed(`${JSON.stringify({ type: "user" })}\n`);
    const tail = parser.finish();
    expect(tail.frames).toEqual([]);
    expect(tail.dropped_lines).toEqual([]);
  });
});
