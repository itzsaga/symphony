// Unit tests for the path-safety invariants module.
// Verifies SPEC.md §9.5 invariants: cwd match, root containment, key sanitization.
import { describe, expect, it } from "bun:test";
import { Effect, Exit } from "effect";
import {
  type AbsolutePath,
  InvalidWorkspaceCwd,
  PathEscape,
  RelativePathNotAllowed,
  assertCwdMatches,
  assertUnderRoot,
  resolveWorkspacePath,
  sanitizeWorkspaceKey,
  toAbsolutePath,
  toAbsolutePathSync,
} from "../../../src/config/PathSafety.ts";

/** Cast helper for tests: trusts the caller that the literal is absolute. */
const abs = (p: string): AbsolutePath => toAbsolutePathSync(p);

describe("sanitizeWorkspaceKey", () => {
  it("leaves identifiers composed only of [A-Za-z0-9._-] untouched", () => {
    expect(sanitizeWorkspaceKey("MT-649")).toBe("MT-649");
    expect(sanitizeWorkspaceKey("a.b_c-1.2.3")).toBe("a.b_c-1.2.3");
  });

  it("replaces traversal characters so '../escape' cannot become a path segment", () => {
    expect(sanitizeWorkspaceKey("../escape")).toBe(".._escape");
  });

  it("replaces spaces and slashes with underscores", () => {
    expect(sanitizeWorkspaceKey("foo bar/baz")).toBe("foo_bar_baz");
  });

  it("replaces every disallowed character including unicode and control chars", () => {
    expect(sanitizeWorkspaceKey("helloéworld")).toBe("hello_world");
    expect(sanitizeWorkspaceKey("a\tb\nc")).toBe("a_b_c");
    expect(sanitizeWorkspaceKey("a:b;c?d*e")).toBe("a_b_c_d_e");
  });

  it("is pure: same input -> same output, no side effects", () => {
    expect(sanitizeWorkspaceKey("x")).toBe("x");
    expect(sanitizeWorkspaceKey("x")).toBe("x");
  });
});

describe("toAbsolutePath", () => {
  it("succeeds on absolute paths", async () => {
    const result = await Effect.runPromise(toAbsolutePath("/tmp/ws"));
    expect(result).toBe("/tmp/ws" as AbsolutePath);
  });

  it("fails with RelativePathNotAllowed on relative paths", async () => {
    const exit = await Effect.runPromiseExit(toAbsolutePath("foo/bar"));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = exit.cause;
      // The cause should carry our tagged error.
      const err = Effect.runSync(
        Effect.catchAll(toAbsolutePath("foo/bar"), (e) => Effect.succeed(e)),
      );
      expect(err).toBeInstanceOf(RelativePathNotAllowed);
      expect(failure._tag).toBe("Fail");
    }
  });

  it("toAbsolutePathSync throws RelativePathNotAllowed on relative input", () => {
    expect(() => toAbsolutePathSync("foo/bar")).toThrow(RelativePathNotAllowed);
  });

  it("toAbsolutePathSync returns the path on absolute input", () => {
    expect(toAbsolutePathSync("/tmp/ws")).toBe("/tmp/ws" as AbsolutePath);
  });
});

describe("assertCwdMatches", () => {
  it("accepts paths that are byte-identical after normalization", async () => {
    const result = await Effect.runPromiseExit(
      assertCwdMatches(abs("/tmp/ws"), abs("/tmp/ws")),
    );
    expect(Exit.isSuccess(result)).toBe(true);
  });

  it("accepts paths that differ only by an internal '.' segment", async () => {
    const result = await Effect.runPromiseExit(
      assertCwdMatches(abs("/tmp/ws"), abs("/tmp/./ws")),
    );
    expect(Exit.isSuccess(result)).toBe(true);
  });

  it("rejects when paths differ by trailing separator after normalization", async () => {
    // path.resolve("/tmp/ws/") === "/tmp/ws", so equal — this should accept.
    // But two genuinely different paths with one trailing slash on the
    // *different* path must still reject.
    const result = await Effect.runPromiseExit(
      assertCwdMatches(abs("/tmp/ws"), abs("/tmp/ws-other/")),
    );
    expect(Exit.isFailure(result)).toBe(true);
    const err = Effect.runSync(
      Effect.catchAll(
        assertCwdMatches(abs("/tmp/ws"), abs("/tmp/ws-other/")),
        (e) => Effect.succeed(e),
      ),
    );
    expect(err).toBeInstanceOf(InvalidWorkspaceCwd);
  });

  it("rejects when expected and actual point to different directories", async () => {
    const exit = await Effect.runPromiseExit(
      assertCwdMatches(abs("/tmp/a"), abs("/tmp/b")),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("assertUnderRoot", () => {
  it("accepts a candidate equal to the root", async () => {
    const exit = await Effect.runPromiseExit(
      assertUnderRoot(abs("/tmp/ws"), abs("/tmp/ws")),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("accepts a candidate strictly inside the root", async () => {
    const exit = await Effect.runPromiseExit(
      assertUnderRoot(abs("/tmp/ws"), abs("/tmp/ws/abc")),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("rejects a sibling whose path shares the root's prefix string", async () => {
    // The directory-aware check must treat /tmp/ws-other as NOT under /tmp/ws.
    const exit = await Effect.runPromiseExit(
      assertUnderRoot(abs("/tmp/ws"), abs("/tmp/ws-other")),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const err = Effect.runSync(
      Effect.catchAll(
        assertUnderRoot(abs("/tmp/ws"), abs("/tmp/ws-other")),
        (e) => Effect.succeed(e),
      ),
    );
    expect(err).toBeInstanceOf(PathEscape);
  });

  it("rejects a candidate that escapes via '..'", async () => {
    const exit = await Effect.runPromiseExit(
      assertUnderRoot(abs("/tmp/ws"), abs("/tmp/ws/../etc")),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("rejects a candidate in a completely unrelated directory", async () => {
    const exit = await Effect.runPromiseExit(
      assertUnderRoot(abs("/tmp/ws"), abs("/var/log")),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("resolveWorkspacePath", () => {
  it("joins the sanitized key under root", () => {
    const resolved = resolveWorkspacePath(abs("/tmp/ws"), "MT-649");
    expect(resolved).toBe("/tmp/ws/MT-649" as AbsolutePath);
  });

  it("sanitizes traversal sequences so '..' in the identifier never escapes the root", async () => {
    const root = abs("/tmp/ws");
    const resolved = resolveWorkspacePath(root, "../escape");
    // After sanitization the key is ".._escape", a single legal directory name.
    expect(resolved).toBe("/tmp/ws/.._escape" as AbsolutePath);
    // And the composition of sanitize + resolve + assertUnderRoot accepts it.
    const exit = await Effect.runPromiseExit(assertUnderRoot(root, resolved));
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("sanitizes embedded slashes so 'a/b' becomes a single directory", () => {
    const resolved = resolveWorkspacePath(abs("/tmp/ws"), "a/b");
    expect(resolved).toBe("/tmp/ws/a_b" as AbsolutePath);
  });
});
