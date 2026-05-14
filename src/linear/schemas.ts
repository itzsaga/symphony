// Effect Schemas for Linear GraphQL responses + the normalized Issue domain
// model (spec §4.1.1) and the LinearClientError tagged union (spec §11.4).
import { Data, Schema } from "effect";

/* -------------------------------------------------------------------------- */
/* Domain model — normalized output exposed to the orchestrator.              */
/* -------------------------------------------------------------------------- */

/**
 * Single blocker reference attached to an `Issue.blocked_by` list. Fields are
 * each independently nullable because the inverse relation may be missing some
 * of them depending on the related issue's visibility.
 */
export const BlockerRef = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  identifier: Schema.NullOr(Schema.String),
  state: Schema.NullOr(Schema.String),
});
export type BlockerRef = Schema.Schema.Type<typeof BlockerRef>;

/**
 * Normalized issue record per spec §4.1.1. `labels` are lowercased,
 * `blocked_by` is derived from inverse "blocks" relations, `priority` is an
 * integer or null, and timestamps are validated as ISO-8601 strings.
 */
export const Issue = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  priority: Schema.NullOr(Schema.Int),
  state: Schema.String,
  branch_name: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.String),
  blocked_by: Schema.Array(BlockerRef),
  created_at: Schema.NullOr(Schema.String),
  updated_at: Schema.NullOr(Schema.String),
});
export type Issue = Schema.Schema.Type<typeof Issue>;

/**
 * Minimal issue projection used by active-run reconciliation (§8.5). Only the
 * id, identifier, and current state are required to decide whether to keep,
 * stop, or clean up a running worker.
 */
export const MinimalIssue = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  state: Schema.String,
});
export type MinimalIssue = Schema.Schema.Type<typeof MinimalIssue>;

/* -------------------------------------------------------------------------- */
/* Raw GraphQL response payload schemas — mirror Linear's wire shape.         */
/* -------------------------------------------------------------------------- */

/** Pagination envelope returned alongside any Linear connection edge list. */
export const PageInfo = Schema.Struct({
  endCursor: Schema.NullOr(Schema.String),
  hasNextPage: Schema.Boolean,
});
export type PageInfo = Schema.Schema.Type<typeof PageInfo>;

/**
 * GraphQL `state` sub-object on an issue. Linear returns `{ name }` but the
 * field can be `null` for an issue that has been moved out of every workflow
 * state — we tolerate that and treat it as an empty string downstream.
 */
const RawStateRef = Schema.NullOr(
  Schema.Struct({
    name: Schema.NullOr(Schema.String),
  }),
);

/** GraphQL label edge node. Lowercasing happens during normalization. */
const RawLabelNode = Schema.Struct({
  name: Schema.String,
});

/** Edge wrapper shape for a paginated connection (Linear `xConnection`). */
const RawLabelsConnection = Schema.Struct({
  nodes: Schema.Array(RawLabelNode),
});

/**
 * Inverse-relation node for the `blocks` relation type. Linear returns a
 * connection of `IssueRelation`; we read `type` to filter on `blocks` and
 * `issue` to surface the blocker's id/identifier/state.
 */
const RawInverseRelationNode = Schema.Struct({
  type: Schema.String,
  issue: Schema.NullOr(
    Schema.Struct({
      id: Schema.NullOr(Schema.String),
      identifier: Schema.NullOr(Schema.String),
      state: RawStateRef,
    }),
  ),
});

const RawInverseRelationsConnection = Schema.Struct({
  nodes: Schema.Array(RawInverseRelationNode),
});

/**
 * Full issue node returned by `issues(...)`. `priority` is `Schema.Unknown`
 * because Linear returns numeric strings in some configurations and we
 * normalize to integer-or-null in `normalize.ts`. Optional/nullable fields
 * follow Linear's actual behavior.
 */
export const RawIssueNode = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  priority: Schema.Unknown,
  state: RawStateRef,
  branchName: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  labels: RawLabelsConnection,
  inverseRelations: RawInverseRelationsConnection,
  createdAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
});
export type RawIssueNode = Schema.Schema.Type<typeof RawIssueNode>;

/**
 * Minimal issue node used by the state-refresh query. Linear's `state.name`
 * may be null for the same reason described on `RawStateRef` — caller
 * substitutes the empty string when surfacing.
 */
export const RawMinimalIssueNode = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  state: RawStateRef,
});
export type RawMinimalIssueNode = Schema.Schema.Type<typeof RawMinimalIssueNode>;

/** GraphQL `errors[]` entry — only `message` is REQUIRED by spec. */
export const GraphqlError = Schema.Struct(
  {
    message: Schema.String,
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type GraphqlError = Schema.Schema.Type<typeof GraphqlError>;

/**
 * Top-level shape of a Linear GraphQL response: `{ data?, errors? }`. Either
 * field MAY be absent. The `data` payload itself is decoded with a per-query
 * schema rather than typed here.
 */
export const RawGraphqlEnvelope = Schema.Struct({
  data: Schema.optional(Schema.Unknown),
  errors: Schema.optional(Schema.Array(GraphqlError)),
});
export type RawGraphqlEnvelope = Schema.Schema.Type<typeof RawGraphqlEnvelope>;

/** `data` shape for the candidate-issue / by-states query. */
export const RawIssuesQueryData = Schema.Struct({
  issues: Schema.Struct({
    nodes: Schema.Array(RawIssueNode),
    pageInfo: PageInfo,
  }),
});
export type RawIssuesQueryData = Schema.Schema.Type<typeof RawIssuesQueryData>;

/** `data` shape for the state-refresh query. */
export const RawIssuesByIdsQueryData = Schema.Struct({
  issues: Schema.Struct({
    nodes: Schema.Array(RawMinimalIssueNode),
  }),
});
export type RawIssuesByIdsQueryData = Schema.Schema.Type<
  typeof RawIssuesByIdsQueryData
>;

/* -------------------------------------------------------------------------- */
/* Tagged error union — spec §11.4.                                            */
/* -------------------------------------------------------------------------- */

/** Transport-level failure (DNS, connection refused, TLS, abort, etc.). */
export class LinearRequestFail extends Data.TaggedError("LinearRequestFail")<{
  readonly endpoint: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Non-2xx HTTP response from the Linear endpoint. */
export class LinearStatusFail extends Data.TaggedError("LinearStatusFail")<{
  readonly endpoint: string;
  readonly status: number;
  readonly body: string | null;
}> {}

/**
 * GraphQL response carried an `errors` array. The errors are surfaced verbatim
 * for operator visibility; orchestrator behavior on this category is "log and
 * skip" per spec §11.4.
 */
export class LinearGraphqlErrors extends Data.TaggedError(
  "LinearGraphqlErrors",
)<{
  readonly endpoint: string;
  readonly errors: ReadonlyArray<GraphqlError>;
}> {}

/** Response decoded but does not match the expected schema for the query. */
export class LinearUnknownPayload extends Data.TaggedError(
  "LinearUnknownPayload",
)<{
  readonly endpoint: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Pagination integrity error: `hasNextPage=true` with no `endCursor`. */
export class LinearMissingEndCursor extends Data.TaggedError(
  "LinearMissingEndCursor",
)<{
  readonly endpoint: string;
}> {}

/** Discriminated union of every LinearClient typed failure. */
export type LinearClientError =
  | LinearRequestFail
  | LinearStatusFail
  | LinearGraphqlErrors
  | LinearUnknownPayload
  | LinearMissingEndCursor;
