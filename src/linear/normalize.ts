// Pure transforms from Linear's raw GraphQL response shape into the normalized
// Issue / MinimalIssue domain models defined in spec §4.1.1 and §11.3.
import type {
  BlockerRef,
  Issue,
  MinimalIssue,
  RawIssueNode,
  RawMinimalIssueNode,
} from "./schemas.ts";

/**
 * Coerce a raw priority value to integer-or-null per spec §11.3:
 * "priority -> integer only (non-integers become null)". Linear typically
 * returns a numeric `0`-`4`, but historical/edge configurations have surfaced
 * floats and stringified numbers — we only honor proper integers.
 */
const normalizePriority = (raw: unknown): number | null => {
  if (typeof raw !== "number") return null;
  if (!Number.isFinite(raw)) return null;
  if (!Number.isInteger(raw)) return null;
  return raw;
};

/**
 * Validate an ISO-8601 string per spec §11.3 ("`created_at` and `updated_at`
 * -> parse ISO-8601 timestamps"). We keep the original string when it parses
 * successfully (round-tripping a `Date` would lose precision), and return
 * `null` for non-strings or unparseable inputs.
 */
const normalizeIso8601 = (raw: string | null): string | null => {
  if (raw === null) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  return raw;
};

/**
 * Lowercase + dedupe label names. Linear can technically return the same
 * label twice if the inner connection paginates oddly; we normalize the
 * surface to keep template iteration deterministic.
 */
const normalizeLabels = (
  raw: ReadonlyArray<{ readonly name: string }>,
): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const out: Array<string> = [];
  for (const node of raw) {
    const lower = node.name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out;
};

/**
 * Filter inverse relations down to type `blocks` and project each into a
 * `BlockerRef`. Per spec §11.3 / §4.1.1 only the `blocks` relation type
 * counts as a blocker; other inverse types (e.g. `duplicate`, `related`) are
 * dropped.
 *
 * The `issue` field of a relation can be null (deleted/permission-restricted
 * counterpart). We surface those as a fully-null BlockerRef rather than
 * dropping them so the operator can still see "this issue is blocked by an
 * inaccessible ticket" rather than silently missing the constraint.
 */
const normalizeBlockedBy = (
  rawRelations: ReadonlyArray<{
    readonly type: string;
    readonly issue: {
      readonly id: string | null;
      readonly identifier: string | null;
      readonly state: { readonly name: string | null } | null;
    } | null;
  }>,
): ReadonlyArray<BlockerRef> => {
  const out: Array<BlockerRef> = [];
  for (const rel of rawRelations) {
    if (rel.type !== "blocks") continue;
    const issue = rel.issue;
    if (issue === null) {
      out.push({ id: null, identifier: null, state: null });
      continue;
    }
    out.push({
      id: issue.id,
      identifier: issue.identifier,
      state: issue.state?.name ?? null,
    });
  }
  return out;
};

/**
 * Normalize one raw issue node into the public {@link Issue} domain model.
 * Pure: no I/O, no mutable global state. Used by both `fetchCandidateIssues`
 * and `fetchIssuesByStates`.
 */
export const normalizeIssue = (raw: RawIssueNode): Issue => ({
  id: raw.id,
  identifier: raw.identifier,
  title: raw.title,
  description: raw.description,
  priority: normalizePriority(raw.priority),
  state: raw.state?.name ?? "",
  branch_name: raw.branchName,
  url: raw.url,
  labels: normalizeLabels(raw.labels.nodes),
  blocked_by: normalizeBlockedBy(raw.inverseRelations.nodes),
  created_at: normalizeIso8601(raw.createdAt),
  updated_at: normalizeIso8601(raw.updatedAt),
});

/**
 * Normalize one raw minimal-issue node (state-refresh path) into the public
 * {@link MinimalIssue} model. State name falls back to the empty string for
 * the same reason as in `normalizeIssue` — orchestrator state comparison is
 * lowercase-equality so an empty string just won't match any active state.
 */
export const normalizeMinimalIssue = (
  raw: RawMinimalIssueNode,
): MinimalIssue => ({
  id: raw.id,
  identifier: raw.identifier,
  state: raw.state?.name ?? "",
});
