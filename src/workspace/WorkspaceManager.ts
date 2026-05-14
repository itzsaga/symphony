// WorkspaceManager Effect service: per-issue workspace creation/reuse + cleanup.
// Implements SPEC.md §9.1/§9.2/§9.5 directory layout, idempotency, and §8.6 sweep.
import { mkdir, rm, stat } from "node:fs/promises";
import { Context, Data, Effect, Layer } from "effect";
import {
  type AbsolutePath,
  PathEscape,
  assertUnderRoot,
  resolveWorkspacePath,
  toAbsolutePathSync,
} from "../config/PathSafety.ts";
import { WorkflowLoader } from "../config/WorkflowLoader.ts";
import { Logger } from "../observability/Logger.ts";
import type { Issue } from "../linear/schemas.ts";

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The workspace directory could not be created (a non-recoverable filesystem
 * failure: permission denied, ENOSPC, etc.). Carries the underlying cause for
 * operator-visible logging.
 */
export class WorkspaceCreationFailed extends Data.TaggedError(
  "WorkspaceCreationFailed",
)<{
  readonly path: string;
  readonly cause?: unknown;
}> {}

/**
 * The path that would be the workspace already exists but is not a directory
 * (e.g. a regular file or symlink to a non-directory). Per §17.2 this is
 * surfaced for caller-defined policy rather than auto-replaced.
 */
export class NonDirectoryAtWorkspacePath extends Data.TaggedError(
  "NonDirectoryAtWorkspacePath",
)<{
  readonly path: string;
}> {}

/**
 * `rm -rf` on the workspace tree failed. Distinct from creation failure so
 * the orchestrator can react differently (cleanup is best-effort during the
 * §8.6 sweep but a hard failure during dispatch reconciliation).
 */
export class CleanupFailed extends Data.TaggedError("CleanupFailed")<{
  readonly path: string;
  readonly cause?: unknown;
}> {}

// `PathEscape` is re-exported so callers can pattern-match on the full
// `WorkspaceError` union without also importing from `PathSafety`.
export { PathEscape };

/** Discriminated union of every error this service raises. */
export type WorkspaceError =
  | WorkspaceCreationFailed
  | NonDirectoryAtWorkspacePath
  | CleanupFailed
  | PathEscape;

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Result of a successful `prepareForIssue` call. `created_now=true` exactly
 * when this call is the one that materialized the directory; subsequent calls
 * for the same issue (during the same run or any later run) yield `false` so
 * the caller can decide whether to invoke the `after_create` hook.
 */
export interface Workspace {
  readonly path: AbsolutePath;
  readonly workspace_key: string;
  readonly created_now: boolean;
}

/* -------------------------------------------------------------------------- */
/* Service Tag                                                                */
/* -------------------------------------------------------------------------- */

/**
 * WorkspaceManager service interface. Methods are stateless w.r.t. the run
 * lifecycle — the orchestrator owns hook execution and only calls into this
 * service for filesystem-level concerns.
 */
export interface WorkspaceManagerService {
  readonly prepareForIssue: (
    issue: Issue,
  ) => Effect.Effect<Workspace, WorkspaceError>;
  readonly cleanWorkspaceFor: (
    identifier: string,
  ) => Effect.Effect<void, WorkspaceError>;
  readonly startupTerminalCleanup: (
    identifiers: ReadonlyArray<string>,
  ) => Effect.Effect<void>;
}

/** The WorkspaceManager service tag. */
export class WorkspaceManager extends Context.Tag(
  "symphony/workspace/WorkspaceManager",
)<WorkspaceManager, WorkspaceManagerService>() {}

/* -------------------------------------------------------------------------- */
/* Live Layer                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build a WorkspaceManager wired against the current `WorkflowLoader` snapshot
 * and the structured `Logger`. `workspace.root` is read from
 * `WorkflowLoader.current` on every call so a runtime config reload that
 * changes the root is honored on the next dispatch (per spec §6.2).
 */
export const WorkspaceManagerLive: Layer.Layer<
  WorkspaceManager,
  never,
  WorkflowLoader | Logger
> = Layer.effect(
  WorkspaceManager,
  Effect.gen(function* () {
    const loader = yield* WorkflowLoader;
    const log = yield* Logger;

    /**
     * Read the current workspace root from the loader and brand it as an
     * `AbsolutePath`. The parser enforces absoluteness, so `toAbsolutePathSync`
     * acts as a runtime invariant guard — any non-absolute root would be a
     * bug in the parser, not a recoverable user error.
     */
     const currentRoot = (): Effect.Effect<AbsolutePath> =>
      Effect.map(loader.current, (wf) =>
        toAbsolutePathSync(wf.config.workspace.root),
      );

    /**
     * Stat helper that distinguishes "missing", "directory", and "non-directory".
     * Returns `null` for ENOENT (idiomatic stat-or-null) and rethrows other
     * errors as `WorkspaceCreationFailed` because they all manifest at the same
     * boundary as the subsequent `mkdir`.
     */
    const statKind = (
      path: AbsolutePath,
    ): Effect.Effect<"missing" | "dir" | "non-dir", WorkspaceCreationFailed> =>
      Effect.tryPromise({
        try: async () => {
          try {
            const s = await stat(path);
            return s.isDirectory() ? "dir" : "non-dir";
          } catch (err) {
            if (
              err !== null &&
              typeof err === "object" &&
              "code" in err &&
              (err as { code: unknown }).code === "ENOENT"
            ) {
              return "missing" as const;
            }
            throw err;
          }
        },
        catch: (cause) => new WorkspaceCreationFailed({ path, cause }),
      });

    const prepareForIssue = (
      issue: Issue,
    ): Effect.Effect<Workspace, WorkspaceError> =>
      Effect.gen(function* () {
        const root = yield* currentRoot();
        // `resolveWorkspacePath` sanitizes + resolves and itself throws
        // `PathEscape` defensively if sanitization is somehow bypassed; the
        // textual `assertUnderRoot` below covers the symlink-escape case.
        const workspacePath = resolveWorkspacePath(root, issue.identifier);
        // Pre-mutation safety check: REQUIRED before every filesystem write.
        yield* assertUnderRoot(root, workspacePath);

        const kind = yield* statKind(workspacePath);
        if (kind === "non-dir") {
          return yield* Effect.fail(
            new NonDirectoryAtWorkspacePath({ path: workspacePath }),
          );
        }
        if (kind === "dir") {
          return {
            path: workspacePath,
            workspace_key: workspacePath.slice(root.length + 1),
            created_now: false,
          };
        }
        // kind === "missing": create with parents. `recursive: true` is
        // safe even if a concurrent call wins the race — it won't error on
        // EEXIST — but the per-issue claim in the orchestrator means we
        // shouldn't hit that branch in practice.
        yield* Effect.tryPromise({
          try: () => mkdir(workspacePath, { recursive: true }),
          catch: (cause) =>
            new WorkspaceCreationFailed({ path: workspacePath, cause }),
        });
        return {
          path: workspacePath,
          workspace_key: workspacePath.slice(root.length + 1),
          created_now: true,
        };
      });

    const cleanWorkspaceFor = (
      identifier: string,
    ): Effect.Effect<void, WorkspaceError> =>
      Effect.gen(function* () {
        const root = yield* currentRoot();
        const workspacePath = resolveWorkspacePath(root, identifier);
        // Path-safety check before EVERY filesystem mutation. If sanitization
        // ever regresses and produces an out-of-root path, this is the last
        // line of defense before `rm -rf` runs.
        yield* assertUnderRoot(root, workspacePath);
        yield* Effect.tryPromise({
          try: () => rm(workspacePath, { recursive: true, force: true }),
          catch: (cause) =>
            new CleanupFailed({ path: workspacePath, cause }),
        });
      });

    const startupTerminalCleanup = (
      identifiers: ReadonlyArray<string>,
    ): Effect.Effect<void> =>
      Effect.forEach(
        identifiers,
        (identifier) =>
          // Best-effort per spec §8.6: log + continue on individual failure
          // so a single bad identifier doesn't block the rest of the sweep.
          Effect.catchAll(cleanWorkspaceFor(identifier), (err) =>
            log.warn({
              msg: "startup terminal cleanup failed for issue; continuing",
              identifier,
              error_tag: err._tag,
              error: formatWorkspaceError(err),
            }),
          ),
        { discard: true },
      );

    const service: WorkspaceManagerService = {
      prepareForIssue,
      cleanWorkspaceFor,
      startupTerminalCleanup,
    };
    return service;
  }),
);

/**
 * Compact one-line rendering of a `WorkspaceError` for log payloads. Keeps
 * the structured `_tag` field separate so log consumers can filter by tag.
 */
const formatWorkspaceError = (err: WorkspaceError): string => {
  switch (err._tag) {
    case "WorkspaceCreationFailed":
      return `${err.path}: ${describeCause(err.cause)}`;
    case "NonDirectoryAtWorkspacePath":
      return `${err.path}: not a directory`;
    case "CleanupFailed":
      return `${err.path}: ${describeCause(err.cause)}`;
    case "PathEscape":
      return `path escape: ${err.candidate} -> ${err.resolved} (root ${err.root})`;
  }
};

/** Render an unknown thrown value as a short string for inclusion in logs. */
const describeCause = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return "<unserializable cause>";
  }
};
