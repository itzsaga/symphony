// Unit tests for the Symphony CLI argv parser.
// Pure-function coverage of positional + --port flag handling; signal/startup wiring is exercised by the integration suite.
import { describe, expect, it } from "bun:test";
import { parseCli, USAGE } from "../../src/cli.ts";

describe("parseCli", () => {
  it("returns null path and null port for empty argv", () => {
    const r = parseCli([]);
    expect(r.workflowPath).toBeNull();
    expect(r.port).toBeNull();
    expect(r.errors).toEqual([]);
  });

  it("captures a single positional as the workflow path", () => {
    const r = parseCli(["./WORKFLOW.md"]);
    expect(r.workflowPath).toBe("./WORKFLOW.md");
    expect(r.port).toBeNull();
    expect(r.errors).toEqual([]);
  });

  it("parses --port <N> as a space-separated value", () => {
    const r = parseCli(["--port", "8080"]);
    expect(r.workflowPath).toBeNull();
    expect(r.port).toBe(8080);
    expect(r.errors).toEqual([]);
  });

  it("parses --port=<N> as a combined value", () => {
    const r = parseCli(["--port=9090"]);
    expect(r.port).toBe(9090);
    expect(r.errors).toEqual([]);
  });

  it("accepts port 0 (ephemeral)", () => {
    const r = parseCli(["--port", "0"]);
    expect(r.port).toBe(0);
    expect(r.errors).toEqual([]);
  });

  it("accepts max valid port", () => {
    const r = parseCli(["--port", "65535"]);
    expect(r.port).toBe(65535);
    expect(r.errors).toEqual([]);
  });

  it("combines positional and --port in either order", () => {
    const a = parseCli(["./WORKFLOW.md", "--port", "8080"]);
    expect(a.workflowPath).toBe("./WORKFLOW.md");
    expect(a.port).toBe(8080);
    expect(a.errors).toEqual([]);
    const b = parseCli(["--port", "8080", "./WORKFLOW.md"]);
    expect(b.workflowPath).toBe("./WORKFLOW.md");
    expect(b.port).toBe(8080);
    expect(b.errors).toEqual([]);
  });

  it("reports an error for an unknown long flag", () => {
    const r = parseCli(["--foo"]);
    expect(r.errors).toEqual(["unknown argument: --foo"]);
  });

  it("reports an error for an unknown short flag", () => {
    const r = parseCli(["-x"]);
    expect(r.errors).toEqual(["unknown argument: -x"]);
  });

  it("reports an error for a missing --port value", () => {
    const r = parseCli(["--port"]);
    expect(r.errors).toEqual(["--port requires a value"]);
    expect(r.port).toBeNull();
  });

  it("reports an error for a non-numeric --port value", () => {
    const r = parseCli(["--port", "abc"]);
    expect(r.errors).toContain("--port: invalid port value 'abc'");
  });

  it("reports an error for an out-of-range --port value", () => {
    const r = parseCli(["--port", "100000"]);
    expect(r.errors).toContain("--port: invalid port value '100000'");
  });

  it("reports an error for a negative --port value", () => {
    const r = parseCli(["--port", "-1"]);
    expect(r.errors).toContain("--port: invalid port value '-1'");
  });

  it("reports an error for a non-integer --port value", () => {
    const r = parseCli(["--port", "3.14"]);
    expect(r.errors).toContain("--port: invalid port value '3.14'");
  });

  it("reports an error for --port= with empty value", () => {
    const r = parseCli(["--port="]);
    expect(r.errors).toContain("--port: invalid port value ''");
  });

  it("reports an error for a second positional argument", () => {
    const r = parseCli(["a.md", "b.md"]);
    expect(r.workflowPath).toBe("a.md");
    expect(r.errors).toEqual(["unexpected positional argument: b.md"]);
  });

  it("collects multiple errors in one pass", () => {
    const r = parseCli(["--foo", "--port", "bad", "extra1", "extra2"]);
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
    // The positional 'extra1' becomes the workflow path; 'extra2' is the
    // unexpected-positional error.
    expect(r.workflowPath).toBe("extra1");
  });

  it("exposes a non-empty USAGE string", () => {
    expect(USAGE.length).toBeGreaterThan(0);
    expect(USAGE.startsWith("usage:")).toBe(true);
  });
});
