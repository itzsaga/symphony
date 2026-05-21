// Pure parser for WORKFLOW.md: front-matter split, YAML decode, $VAR + path
// resolution, schema validation, and dispatch preflight per spec §5/§6.
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { resolveEnvIndirectionSync } from "./envResolution.ts";
import {
  REJECTED_TOP_LEVEL_KEYS,
  TopLevelSchema,
  type TypedConfig,
  ValidationError,
  type WorkflowDefinition,
  WorkflowFrontMatterNotAMap,
  WorkflowParseError,
} from "./WorkflowSchema.ts";

/* -------------------------------------------------------------------------- */
/* Front-matter splitter                                                      */
/* -------------------------------------------------------------------------- */

interface SplitResult {
  readonly frontMatter: string | null;
  readonly body: string;
}

/**
 * Split a WORKFLOW.md document into YAML front matter and Markdown body per
 * spec §5.2: a leading `---` line opens, the next `---` line closes, and the
 * remainder is body. If the file does not start with `---` the entire
 * document is body.
 *
 * Linebreak handling is permissive (CRLF or LF). Whitespace before the
 * opening `---` disqualifies it (spec says "starts with `---`").
 */
const splitFrontMatter = (content: string): SplitResult => {
  // Normalize CRLF only for marker detection — original line content is
  // preserved through array-based splitting.
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || lines[0] !== "---") {
    return { frontMatter: null, body: content };
  }
  // Find the closing `---`; must be a full line of exactly three dashes.
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    // Opener with no closer: treat as malformed front matter rather than
    // silently shoving the whole file into the body. The schema layer would
    // not catch this since YAML would parse fine. Spec §5.5 calls out
    // workflow_parse_error for malformed front matter.
    return { frontMatter: null, body: content };
  }
  const fmLines = lines.slice(1, closeIdx);
  const bodyLines = lines.slice(closeIdx + 1);
  return {
    frontMatter: fmLines.join("\n"),
    body: bodyLines.join("\n"),
  };
};

/* -------------------------------------------------------------------------- */
/* Pre-schema raw map sanitization (path expansion + $VAR resolution)         */
/* -------------------------------------------------------------------------- */

/**
 * Type guard for "is this an own-property record we can index by string".
 * Excludes arrays so callers don't accidentally walk array indices as keys.
 */
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Substitute `$VAR` references in a string field. Returns `null` if the
 * field was a `$VAR` reference but the variable was missing/empty (spec
 * §6.4 — empty resolution is "missing"). Returns the original string
 * otherwise.
 */
const resolveStringIndirection = (value: string): string | null =>
  resolveEnvIndirectionSync(value);

/**
 * Apply spec §6.1 path expansion to a single filesystem-path string:
 * `~` to `$HOME`, then resolve relatives against `workflowDir`. Absolute
 * paths (including those resulting from `~` expansion) are returned as-is.
 *
 * Returns `null` when the input is null (caller may then fall back to a
 * default like `tmpdir()/symphony_workspaces`).
 */
const expandFsPath = (value: string, workflowDir: string): string => {
  let v = value;
  if (v === "~") {
    v = homedir();
  } else if (v.startsWith("~/")) {
    v = `${homedir()}/${v.slice(2)}`;
  }
  if (isAbsolute(v)) return v;
  return resolve(workflowDir, v);
};

/**
 * Resolve `$VAR` indirection on the string fields the schema expects, then
 * apply `~` + relative-path normalization to filesystem-path fields.
 *
 * Done in plain TS (not via `Schema.transform`) to keep the schema layer
 * focused on shape/coercion and to give clearer error messages when an
 * env var is missing — surfaced as `WorkflowParseError` here rather than as
 * a generic schema decode failure.
 *
 * Returns either the sanitized map ready for schema decode, or a tagged
 * parse error describing exactly which field is unresolved.
 */
const sanitizeRawConfig = (
  raw: Record<string, unknown>,
  workflowPath: string,
): Effect.Effect<Record<string, unknown>, WorkflowParseError> =>
  Effect.gen(function* () {
    const workflowDir = dirname(workflowPath);
    // Shallow clone so we don't mutate the caller's object.
    const out: Record<string, unknown> = { ...raw };

    // tracker.api_key + tracker.endpoint: $VAR resolution only. (The schema
    // tolerates `null` for api_key — see TrackerSchema — so we collapse a
    // failed resolution to absence rather than to error here. The dispatch
    // preflight is the authority on "must be present".)
    if (isPlainObject(out["tracker"])) {
      const tracker = { ...out["tracker"] };
      if (typeof tracker["api_key"] === "string") {
        const resolved = resolveStringIndirection(tracker["api_key"]);
        // resolveStringIndirection returns `null` on unresolved $VAR —
        // strip the field entirely so the schema treats it as absent and
        // validateForDispatch raises the operator-facing error.
        if (resolved === null) {
          delete tracker["api_key"];
        } else {
          tracker["api_key"] = resolved;
        }
      }
      if (typeof tracker["endpoint"] === "string") {
        const resolved = resolveStringIndirection(tracker["endpoint"]);
        if (resolved === null) {
          // Endpoint resolution failure is a hard parse error — without an
          // endpoint we can't even fall back sensibly (the default applies
          // only when the field is absent, not when it failed to resolve).
          return yield* Effect.fail(
            new WorkflowParseError({
              path: workflowPath,
              message:
                "tracker.endpoint references an environment variable that is unset or empty",
            }),
          );
        }
        tracker["endpoint"] = resolved;
      }
      out["tracker"] = tracker;
    }

    // workspace.root: $VAR resolution, then ~/relative-path expansion.
    if (isPlainObject(out["workspace"])) {
      const workspace = { ...out["workspace"] };
      if (typeof workspace["root"] === "string") {
        const resolved = resolveStringIndirection(workspace["root"]);
        if (resolved === null) {
          return yield* Effect.fail(
            new WorkflowParseError({
              path: workflowPath,
              message:
                "workspace.root references an environment variable that is unset or empty",
            }),
          );
        }
        workspace["root"] = expandFsPath(resolved, workflowDir);
      }
      out["workspace"] = workspace;
    }

    // agent_runner.command and friends are NOT path-expanded per spec §6.1
    // ("do not rewrite URIs or arbitrary shell command strings").

    return out;
  });

/* -------------------------------------------------------------------------- */
/* Top-level entry point                                                      */
/* -------------------------------------------------------------------------- */

const MIN_DEFAULT_PROMPT = "You are working on an issue from Linear.";

/**
 * Parse a WORKFLOW.md document into a fully-typed `WorkflowDefinition`.
 *
 * Pipeline:
 *   1. Split front matter from body (§5.2).
 *   2. YAML-decode the front matter (or default to `{}`).
 *   3. Reject the legacy `codex.*` namespace explicitly (TRUST.md divergence).
 *   4. Sanitize raw map: `$VAR` resolution + `~`/relative-path expansion.
 *   5. Decode through `TopLevelSchema` to fill in defaults and coerce types.
 *   6. Substitute the platform default for `workspace.root` if absent.
 *   7. Trim the prompt body, falling back to the §5.4 minimal default.
 *
 * The parser is pure: it reads `process.env`, `os.tmpdir()`, and `os.homedir()`
 * but never the filesystem. File I/O lives in the WorkflowLoader service that
 * wraps this function.
 */
export const parseWorkflow = (
  content: string,
  workflowFilePath: string,
): Effect.Effect<
  WorkflowDefinition,
  WorkflowParseError | WorkflowFrontMatterNotAMap
> =>
  Effect.gen(function* () {
    const sourcePath = resolve(workflowFilePath);
    const { frontMatter, body } = splitFrontMatter(content);

    // 2. Decode YAML front matter (or default to empty object).
    let rawConfig: unknown = {};
    if (frontMatter !== null && frontMatter.trim().length > 0) {
      try {
        rawConfig = Bun.YAML.parse(frontMatter);
      } catch (err) {
        return yield* Effect.fail(
          new WorkflowParseError({
            path: sourcePath,
            message: `YAML parse failed: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          }),
        );
      }
    }

    // §5.2: front matter MUST decode to a map/object. `null` (empty document)
    // is treated as an empty map for ergonomic "front matter present but
    // blank" cases.
    if (rawConfig === null || rawConfig === undefined) {
      rawConfig = {};
    }
    if (!isPlainObject(rawConfig)) {
      return yield* Effect.fail(
        new WorkflowFrontMatterNotAMap({
          path: sourcePath,
          actualKind: Array.isArray(rawConfig) ? "array" : typeof rawConfig,
        }),
      );
    }

    // 3. Reject the legacy `codex.*` namespace explicitly. Per the TRUST.md
    // rename, presence of `codex.*` is an actionable error, not a silent
    // forward-compat ignore — we want the operator to know they're pointed
    // at a Codex-shaped workflow that won't run on Claude Code.
    const presentRejected = Object.keys(rawConfig).filter((k) =>
      REJECTED_TOP_LEVEL_KEYS.has(k),
    );
    if (presentRejected.length > 0) {
      return yield* Effect.fail(
        new WorkflowParseError({
          path: sourcePath,
          message: `WORKFLOW.md uses unsupported front-matter namespace(s): ${presentRejected.join(", ")}. Symphony v1 renames codex.* to agent_runner.* — see TRUST.md.`,
        }),
      );
    }

    // 4. $VAR resolution + path expansion on the raw map.
    const sanitized = yield* sanitizeRawConfig(rawConfig, sourcePath);

    // 5. Decode through the schema. Use Effect-returning decoder so we can
    // surface the precise schema diagnostic in the WorkflowParseError.
    const decoded = yield* Schema.decodeUnknown(TopLevelSchema)(sanitized).pipe(
      Effect.mapError(
        (err) =>
          new WorkflowParseError({
            path: sourcePath,
            message: `front matter failed schema validation: ${err.message}`,
            cause: err,
          }),
      ),
    );

    // 6. Substitute platform-default workspace.root if absent. We do this
    // post-schema rather than as a schema default because it depends on
    // `os.tmpdir()`, which is technically impure and shouldn't live inside
    // a Schema constructor.
    const workspaceRoot =
      decoded.workspace.root ?? resolve(tmpdir(), "symphony_workspaces");

    // Build the final TypedConfig. Most of this is just `decoded` repackaged,
    // but we explicitly carry `null` rather than `undefined` for fields the
    // downstream code reads as nullable — keeps `exactOptionalPropertyTypes`
    // happy and makes the dispatch preflight checks unambiguous.
    const config: TypedConfig = {
      tracker: {
        kind: decoded.tracker.kind,
        endpoint: decoded.tracker.endpoint,
        api_key: decoded.tracker.api_key ?? null,
        project_slug: decoded.tracker.project_slug ?? null,
        active_states: decoded.tracker.active_states,
        terminal_states: decoded.tracker.terminal_states,
      },
      polling: {
        interval_ms: decoded.polling.interval_ms,
      },
      workspace: { root: workspaceRoot },
      hooks: {
        after_create: decoded.hooks.after_create,
        before_run: decoded.hooks.before_run,
        after_run: decoded.hooks.after_run,
        before_remove: decoded.hooks.before_remove,
        timeout_ms: decoded.hooks.timeout_ms,
      },
      agent_runner: {
        kind: decoded.agent_runner.kind,
        command: decoded.agent_runner.command,
        permission_mode: decoded.agent_runner.permission_mode,
        max_turns: decoded.agent_runner.max_turns,
        turn_timeout_ms: decoded.agent_runner.turn_timeout_ms,
        read_timeout_ms: decoded.agent_runner.read_timeout_ms,
        stall_timeout_ms: decoded.agent_runner.stall_timeout_ms,
        network_profile: decoded.agent_runner.network_profile,
        bare: decoded.agent_runner.bare,
        extra_args: decoded.agent_runner.extra_args,
        max_concurrent_agents: decoded.agent_runner.max_concurrent_agents,
        max_concurrent_agents_by_state:
          decoded.agent_runner.max_concurrent_agents_by_state,
        max_retry_backoff_ms: decoded.agent_runner.max_retry_backoff_ms,
      },
      server: decoded.server,
    };

    // 7. Trim body and apply the §5.4 minimal default if empty.
    const trimmedBody = body.trim();
    const promptTemplate =
      trimmedBody.length === 0 ? MIN_DEFAULT_PROMPT : trimmedBody;

    return {
      config,
      prompt_template: promptTemplate,
      source_path: sourcePath,
    };
  });

/* -------------------------------------------------------------------------- */
/* Dispatch preflight (spec §6.3)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Run the §6.3 dispatch preflight on a parsed `WorkflowDefinition`. Fails
 * with `ValidationError` listing every check that failed; succeeds when the
 * workflow is dispatchable.
 *
 * The "workflow loads, parses" check is implicit — if you're calling this
 * function you have a `WorkflowDefinition` in hand, which means parse
 * succeeded.
 */
export const validateForDispatch = (
  workflow: WorkflowDefinition,
): Effect.Effect<void, ValidationError> =>
  Effect.gen(function* () {
    const failures: Array<string> = [];
    const { tracker, agent_runner } = workflow.config;

    // tracker.kind is set by the schema default ("linear"), so this check is
    // really about whether the operator has selected a *supported* kind.
    // `TrackerKind` only allows "linear" today, so this is mostly belt-and-
    // suspenders against a future expansion.
    if (tracker.kind !== "linear") {
      failures.push(
        `tracker.kind must be "linear" (got "${String(tracker.kind)}")`,
      );
    }
    if (tracker.api_key === null || tracker.api_key.length === 0) {
      failures.push("tracker.api_key is required (after $VAR resolution)");
    }
    if (tracker.project_slug === null || tracker.project_slug.length === 0) {
      failures.push("tracker.project_slug is required when tracker.kind=linear");
    }
    if (agent_runner.command.length === 0) {
      failures.push("agent_runner.command must be a non-empty string");
    }

    if (failures.length > 0) {
      return yield* Effect.fail(new ValidationError({ checks: failures }));
    }
  });
