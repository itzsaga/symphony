// Schema definitions and tagged error types for WORKFLOW.md parsing.
// Models spec §5.3 / §6.4 with the agent_runner.* rename declared in TRUST.md.
import { Data, Schema } from "effect";

/* -------------------------------------------------------------------------- */
/* Error types — match spec §5.5 + parser-internal categories.                */
/* -------------------------------------------------------------------------- */

/** File could not be read at all (or callers want to surface the same shape). */
export class MissingWorkflowFile extends Data.TaggedError(
  "MissingWorkflowFile",
)<{
  readonly path: string;
  readonly cause?: unknown;
}> {}

/**
 * Raised when YAML parsing fails outright (`Bun.YAML.parse` throws, or the
 * Schema decode rejects the resulting structure). The `message` carries the
 * underlying parser/schema diagnostic; `path` identifies the source file.
 */
export class WorkflowParseError extends Data.TaggedError(
  "WorkflowParseError",
)<{
  readonly path: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Raised when YAML successfully decodes but the front matter root is not a
 * map/object (per spec §5.2: "YAML front matter MUST decode to a map/object;
 * non-map YAML is an error.").
 */
export class WorkflowFrontMatterNotAMap extends Data.TaggedError(
  "WorkflowFrontMatterNotAMap",
)<{
  readonly path: string;
  readonly actualKind: string;
}> {}

/** Discriminated union of every parser-stage failure. */
export type ParseFailure =
  | MissingWorkflowFile
  | WorkflowParseError
  | WorkflowFrontMatterNotAMap;

/**
 * Raised by `validateForDispatch` when the loaded workflow fails one of the
 * spec §6.3 dispatch preflight checks. Distinct from parse-time failures so
 * callers can react differently (parse failures block all dispatch; preflight
 * failures skip the current tick but keep reconciliation alive).
 */
export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly checks: ReadonlyArray<string>;
}> {}

/* -------------------------------------------------------------------------- */
/* Field schemas — input shape (raw YAML map after $VAR/path resolution).     */
/*                                                                            */
/* These describe the *resolved* config shape (post `$VAR` and `~` expansion).*/
/* Defaults from spec §6.4 are baked in via `Schema.optionalWith`.            */
/* -------------------------------------------------------------------------- */

/** Allowed values for `agent_runner.kind`. v1 ships Claude Code only. */
export const AgentRunnerKind = Schema.Literal("claude_code");
export type AgentRunnerKind = Schema.Schema.Type<typeof AgentRunnerKind>;

/** Allowed values for `agent_runner.permission_mode` (Claude CLI literals). */
export const PermissionMode = Schema.Literal(
  "default",
  "bypassPermissions",
  "acceptEdits",
);
export type PermissionMode = Schema.Schema.Type<typeof PermissionMode>;

/** Allowed values for `tracker.kind`. v1 ships Linear only. */
export const TrackerKind = Schema.Literal("linear");
export type TrackerKind = Schema.Schema.Type<typeof TrackerKind>;

/** A non-negative integer (used for ms durations). */
const NonNegInt = Schema.Int.pipe(
  Schema.filter((n) => n >= 0, {
    message: () => "must be a non-negative integer",
  }),
);

/** A positive integer (used for `max_turns`). */
const PositiveInt = Schema.Int.pipe(
  Schema.filter((n) => n >= 1, {
    message: () => "must be a positive integer",
  }),
);

/* ------------------------------- tracker -------------------------------- */

export const TrackerSchema = Schema.Struct({
  kind: Schema.optionalWith(TrackerKind, { default: () => "linear" as const }),
  endpoint: Schema.optionalWith(Schema.String, {
    default: () => "https://api.linear.app/graphql",
  }),
  // api_key is optional at parse time (so a workflow without it still loads,
  // matching spec §5.5 — "Workflow file read/YAML errors block new dispatches
  // until fixed", but missing api_key is a *dispatch preflight* failure, not
  // a parse failure). validateForDispatch enforces presence.
  api_key: Schema.optional(Schema.String),
  project_slug: Schema.optional(Schema.String),
  active_states: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => ["Todo", "In Progress"] as ReadonlyArray<string>,
  }),
  terminal_states: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () =>
      ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"] as ReadonlyArray<string>,
  }),
});

/* ------------------------------- polling -------------------------------- */

export const PollingSchema = Schema.Struct({
  interval_ms: Schema.optionalWith(NonNegInt, { default: () => 30_000 }),
});

/* ------------------------------ workspace ------------------------------- */

/**
 * `workspace.root` after path expansion is a plain absolute string. The
 * parser handles `~` and `$VAR` expansion + relative resolution before this
 * schema sees the value; the schema itself just records the typed shape.
 */
export const WorkspaceSchema = Schema.Struct({
  // Default left as a sentinel — the parser substitutes the platform temp
  // dir when the field is absent (cannot bake `os.tmpdir()` into a static
  // schema default without making the schema impure).
  root: Schema.optional(Schema.String),
});

/* -------------------------------- hooks --------------------------------- */

const NullableShellScript = Schema.NullOr(Schema.String);

export const HooksSchema = Schema.Struct({
  after_create: Schema.optionalWith(NullableShellScript, {
    default: () => null,
  }),
  before_run: Schema.optionalWith(NullableShellScript, {
    default: () => null,
  }),
  after_run: Schema.optionalWith(NullableShellScript, {
    default: () => null,
  }),
  before_remove: Schema.optionalWith(NullableShellScript, {
    default: () => null,
  }),
  timeout_ms: Schema.optionalWith(NonNegInt, { default: () => 60_000 }),
});

/* ----------------------------- agent_runner ----------------------------- */

/**
 * Map of state-name to per-state concurrency cap. Keys are matched
 * case-insensitively by the dispatcher (§4.2 / §8.3); the schema preserves
 * the operator's casing as written so error messages stay recognizable.
 * Values are non-negative integers.
 */
const MaxConcurrentByState = Schema.Record({
  key: Schema.String,
  value: NonNegInt,
});

export const AgentRunnerSchema = Schema.Struct({
  kind: Schema.optionalWith(AgentRunnerKind, {
    default: () => "claude_code" as const,
  }),
  command: Schema.optionalWith(Schema.String, { default: () => "claude" }),
  permission_mode: Schema.optionalWith(PermissionMode, {
    default: () => "bypassPermissions" as const,
  }),
  max_turns: Schema.optionalWith(PositiveInt, { default: () => 20 }),
  turn_timeout_ms: Schema.optionalWith(NonNegInt, {
    default: () => 3_600_000,
  }),
  read_timeout_ms: Schema.optionalWith(NonNegInt, { default: () => 5_000 }),
  stall_timeout_ms: Schema.optionalWith(NonNegInt, {
    default: () => 300_000,
  }),
  network_profile: Schema.optionalWith(Schema.String, {
    default: () => "claude-code",
  }),
  bare: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  extra_args: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [] as ReadonlyArray<string>,
  }),
  // Spec §5.3.5 / §8.3: global concurrency cap. Default 10 matches §5.3.5
  // and `DEFAULT_MAX_CONCURRENT_AGENTS` in src/orchestrator/State.ts.
  max_concurrent_agents: Schema.optionalWith(NonNegInt, {
    default: () => 10,
  }),
  // Spec §5.3.5 / §8.3: optional per-state caps. Absent = no per-state gate
  // (only the global cap applies). Empty object is also accepted.
  max_concurrent_agents_by_state: Schema.optionalWith(MaxConcurrentByState, {
    default: () => ({}) as Record<string, number>,
  }),
  // Spec §5.3.5 / §8.4: cap on the exponential-backoff power, in ms.
  // Default 300_000 = 5 minutes.
  max_retry_backoff_ms: Schema.optionalWith(NonNegInt, {
    default: () => 300_000,
  }),
});

/* -------------------------------- server -------------------------------- */

/** HTTP server extension (§13.7); absent block means HTTP server is disabled. */
export const ServerSchema = Schema.Struct({
  port: NonNegInt,
});

/* ---------------------------- top-level config -------------------------- */

/**
 * Decode an empty object through a sub-schema to materialize its defaulted
 * shape. Used as the `default` thunk for top-level optional sub-schemas so
 * the resulting `Schema.Type` is fully populated rather than `{}`.
 *
 * Calling `decodeUnknownSync` once at module load is fine: every sub-schema
 * is constructible from `{}` because every field has a default.
 */
const defaultedFor = <A, I>(schema: Schema.Schema<A, I>): A =>
  Schema.decodeUnknownSync(schema)({});

/**
 * The top-level front-matter schema. Every section is optional; defaults are
 * applied per the cheat-sheet. Unknown top-level keys are stripped (Effect's
 * `Schema.Struct` ignores fields not in the literal shape unless onExcess is
 * set), giving forward-compat per spec §5.3. The parser separately rejects
 * the explicit `codex.*` namespace before this schema runs.
 */
export const TopLevelSchema = Schema.Struct({
  tracker: Schema.optionalWith(TrackerSchema, {
    default: () => defaultedFor(TrackerSchema),
  }),
  polling: Schema.optionalWith(PollingSchema, {
    default: () => defaultedFor(PollingSchema),
  }),
  workspace: Schema.optionalWith(WorkspaceSchema, {
    default: () => defaultedFor(WorkspaceSchema),
  }),
  hooks: Schema.optionalWith(HooksSchema, {
    default: () => defaultedFor(HooksSchema),
  }),
  agent_runner: Schema.optionalWith(AgentRunnerSchema, {
    default: () => defaultedFor(AgentRunnerSchema),
  }),
  server: Schema.optionalWith(Schema.NullOr(ServerSchema), {
    default: () => null,
  }),
});

/* -------------------------------------------------------------------------- */
/* Public types — the ones the rest of the codebase imports.                  */
/* -------------------------------------------------------------------------- */

/**
 * Concrete typed config consumed by the orchestrator/runtime. Every field
 * is filled in (defaults applied), `workspace.root` is an absolute path,
 * `tracker.api_key` (if present) has had `$VAR` resolved.
 */
export interface TypedConfig {
  readonly tracker: {
    readonly kind: TrackerKind;
    readonly endpoint: string;
    readonly api_key: string | null;
    readonly project_slug: string | null;
    readonly active_states: ReadonlyArray<string>;
    readonly terminal_states: ReadonlyArray<string>;
  };
  readonly polling: {
    readonly interval_ms: number;
  };
  readonly workspace: {
    readonly root: string;
  };
  readonly hooks: {
    readonly after_create: string | null;
    readonly before_run: string | null;
    readonly after_run: string | null;
    readonly before_remove: string | null;
    readonly timeout_ms: number;
  };
  readonly agent_runner: {
    readonly kind: AgentRunnerKind;
    readonly command: string;
    readonly permission_mode: PermissionMode;
    readonly max_turns: number;
    readonly turn_timeout_ms: number;
    readonly read_timeout_ms: number;
    readonly stall_timeout_ms: number;
    readonly network_profile: string;
    readonly bare: boolean;
    readonly extra_args: ReadonlyArray<string>;
    readonly max_concurrent_agents: number;
    readonly max_concurrent_agents_by_state: Readonly<Record<string, number>>;
    readonly max_retry_backoff_ms: number;
  };
  readonly server: { readonly port: number } | null;
}

/** Parsed `WORKFLOW.md` payload returned by `parseWorkflow`. */
export interface WorkflowDefinition {
  readonly config: TypedConfig;
  readonly prompt_template: string;
  readonly source_path: string;
}

/**
 * The exact set of top-level keys the parser explicitly rejects (rather than
 * silently ignoring). Keeping the list small + explicit makes it easy to
 * surface "you have Codex-shaped config" rather than confusing the operator
 * with a generic schema error after silent key-stripping.
 */
export const REJECTED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "codex",
  // `agent` (the spec §5.3.5 block) is intentionally not rejected: its keys
  // (max_concurrent_agents, max_retry_backoff_ms, etc.) live elsewhere in
  // the v1 design and should be allowed to coexist as forward-compat. Only
  // the `codex.*` namespace gets a hard rejection per the rename decision.
]);
