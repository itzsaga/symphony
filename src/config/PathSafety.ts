// Path safety invariants for Symphony v1 (per SPEC.md §9.5).
// Pure helpers + Effect-typed boundary checks for workspace key sanitization,
// absolute-path branding, root containment, and cwd validation.
import * as path from "node:path";
import * as fs from "node:fs";
import { Data, Effect } from "effect";

/**
 * Branded absolute filesystem path. Construct via {@link toAbsolutePath} so the
 * rest of the codebase cannot accidentally pass a raw / relative string to a
 * function expecting an already-validated absolute path.
 */
declare const __absolutePathBrand: unique symbol;
export type AbsolutePath = string & {
  readonly [__absolutePathBrand]: "AbsolutePath";
};

/** Tagged error: caller passed a relative path where an absolute one is required. */
export class RelativePathNotAllowed extends Data.TaggedError(
  "RelativePathNotAllowed",
)<{
  readonly path: string;
}> {}

/** Tagged error: subprocess cwd does not match the expected workspace path. */
export class InvalidWorkspaceCwd extends Data.TaggedError("InvalidWorkspaceCwd")<{
  readonly expected: string;
  readonly actual: string;
}> {}

/** Tagged error: a candidate path resolves outside the workspace root. */
export class PathEscape extends Data.TaggedError("PathEscape")<{
  readonly root: string;
  readonly candidate: string;
  readonly resolved: string;
}> {}

/**
 * Construct an {@link AbsolutePath} from a string. Throws-style: returns a
 * tagged error in an Effect rather than throwing, so callers at runtime
 * boundaries can handle relative inputs explicitly. Pure synchronous use cases
 * should use {@link toAbsolutePathSync}.
 */
export const toAbsolutePath = (
  candidate: string,
): Effect.Effect<AbsolutePath, RelativePathNotAllowed> =>
  path.isAbsolute(candidate)
    ? Effect.succeed(path.normalize(candidate) as AbsolutePath)
    : Effect.fail(new RelativePathNotAllowed({ path: candidate }));

/**
 * Synchronous variant of {@link toAbsolutePath} for places that already know
 * (and assert) the path is absolute — e.g. test fixtures or values derived from
 * `process.cwd()`. Throws a `RelativePathNotAllowed` if the input is relative.
 */
export const toAbsolutePathSync = (candidate: string): AbsolutePath => {
  if (!path.isAbsolute(candidate)) {
    throw new RelativePathNotAllowed({ path: candidate });
  }
  return path.normalize(candidate) as AbsolutePath;
};

/**
 * Sanitize a tracker identifier into a workspace directory name.
 *
 * Per SPEC.md §4.2 / §9.5 invariant 3: every character outside `[A-Za-z0-9._-]`
 * is replaced with `_`. Pure and synchronous.
 */
export const sanitizeWorkspaceKey = (identifier: string): string =>
  identifier.replace(/[^A-Za-z0-9._-]/g, "_");

/**
 * Resolve the workspace path for a given identifier under `root`.
 *
 * Sanitization should make escape impossible, but we still assert containment
 * defensively — a regression in `sanitizeWorkspaceKey` must not silently
 * produce an out-of-root path.
 */
export const resolveWorkspacePath = (
  root: AbsolutePath,
  identifier: string,
): AbsolutePath => {
  const key = sanitizeWorkspaceKey(identifier);
  const resolved = path.resolve(root, key) as AbsolutePath;
  if (!isUnderRoot(root, resolved)) {
    // Sanitization invariant has been violated. Surface as a defect rather
    // than a typed error: this branch indicates a programmer bug, not a
    // user-recoverable condition.
    throw new PathEscape({ root, candidate: key, resolved });
  }
  return resolved;
};

/**
 * Directory-aware prefix check: `candidate` must equal `root` or sit strictly
 * beneath it. Both inputs are expected to already be absolute and normalized.
 *
 * The trailing-separator guard prevents `/foo` from matching `/foobar` — the
 * single most common accidental escape in naive prefix checks.
 */
const isUnderRoot = (root: AbsolutePath, candidate: AbsolutePath): boolean => {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  if (normalizedCandidate === normalizedRoot) return true;
  const rootWithSep = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : normalizedRoot + path.sep;
  return normalizedCandidate.startsWith(rootWithSep);
};

/**
 * Invariant 1 (SPEC.md §9.5): the agent subprocess cwd must equal the
 * pre-validated workspace path. Comparison is performed after normalization so
 * trailing separators and `.` segments do not mask a real mismatch.
 */
export const assertCwdMatches = (
  expected: AbsolutePath,
  actual: AbsolutePath,
): Effect.Effect<void, InvalidWorkspaceCwd> => {
  const normalizedExpected = path.resolve(expected);
  const normalizedActual = path.resolve(actual);
  if (normalizedExpected === normalizedActual) {
    return Effect.void;
  }
  return Effect.fail(
    new InvalidWorkspaceCwd({
      expected: normalizedExpected,
      actual: normalizedActual,
    }),
  );
};

/**
 * Invariant 2 (SPEC.md §9.5): `candidate` must remain inside `root` after
 * normalization. Best-effort symlink check: if the candidate's parent exists,
 * follow it via `fs.realpath` and re-verify containment so a symlinked
 * subdirectory cannot smuggle the path outside the root. Missing parents are
 * treated as fine — the textual check already passed and the path simply does
 * not exist on disk yet (e.g. workspace creation).
 */
export const assertUnderRoot = (
  root: AbsolutePath,
  candidate: AbsolutePath,
): Effect.Effect<void, PathEscape> =>
  Effect.sync(() => {
    const resolvedRoot = path.resolve(root) as AbsolutePath;
    const resolvedCandidate = path.resolve(candidate) as AbsolutePath;

    if (!isUnderRoot(resolvedRoot, resolvedCandidate)) {
      return new PathEscape({
        root: resolvedRoot,
        candidate,
        resolved: resolvedCandidate,
      });
    }

    // Best-effort symlink escape check. We resolve the *parent* directory
    // (not the candidate itself, which may not exist yet) and re-check the
    // containment invariant against the realpath of the root.
    const parent = path.dirname(resolvedCandidate);
    let realParent: string;
    let realRoot: string;
    try {
      realParent = fs.realpathSync(parent);
    } catch {
      // Parent doesn't exist (or is otherwise unreadable). Nothing to check —
      // there can be no symlink escape via a parent that doesn't exist.
      return null;
    }
    try {
      realRoot = fs.realpathSync(resolvedRoot);
    } catch {
      // Root doesn't exist on disk yet; skip the symlink re-check rather than
      // failing — root existence is the WorkspaceManager's responsibility.
      return null;
    }
    const basename = path.basename(resolvedCandidate);
    const realCandidate =
      basename === "" ? realParent : path.join(realParent, basename);
    if (!isUnderRoot(realRoot as AbsolutePath, realCandidate as AbsolutePath)) {
      return new PathEscape({
        root: resolvedRoot,
        candidate,
        resolved: realCandidate,
      });
    }
    return null;
  }).pipe(
    Effect.flatMap((err) => (err === null ? Effect.void : Effect.fail(err))),
  );
