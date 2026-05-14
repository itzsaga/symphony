// Hand-written GraphQL operation strings for the Linear tracker client.
// Kept isolated per spec §11.2 ("test the exact query fields/types REQUIRED").

/**
 * Inline fragment shared by all queries that return a full normalized issue.
 * Fields mirror `RawIssueNode` in `schemas.ts` and the §4.1.1 normalization
 * rules (labels lowercased, blockers from inverse `blocks` relations).
 *
 * Hard-coded `first: 50` on inner connections is deliberate: in practice issues
 * have well under 50 labels or relations, and adding pagination on those
 * inner connections would balloon the query without observable benefit.
 */
const FULL_ISSUE_FRAGMENT = `
  id
  identifier
  title
  description
  priority
  state { name }
  branchName
  url
  labels(first: 50) { nodes { name } }
  inverseRelations(first: 50) {
    nodes {
      type
      issue {
        id
        identifier
        state { name }
      }
    }
  }
  createdAt
  updatedAt
`;

/**
 * Page size for candidate-issue and by-states pagination. Spec §11.2 pins this
 * at 50 and forbids exposing it as config in v1.
 */
export const CANDIDATE_PAGE_SIZE = 50;

/**
 * Candidate-issue query. Filters by project `slugId` (spec §11.2) and by the
 * configured `active_states` set; pagination follows the standard `pageInfo`
 * contract via `$after`.
 *
 * Variable types:
 *   - `$projectSlug: String!` — the slugId of the configured project
 *   - `$states: [String!]!` — active state name list
 *   - `$first: Int!` — page size (always {@link CANDIDATE_PAGE_SIZE})
 *   - `$after: String` — pagination cursor (null on the first page)
 */
export const CANDIDATE_ISSUES_QUERY = `
query SymphonyCandidateIssues(
  $projectSlug: String!
  $states: [String!]!
  $first: Int!
  $after: String
) {
  issues(
    first: $first
    after: $after
    filter: {
      project: { slugId: { eq: $projectSlug } }
      state: { name: { in: $states } }
    }
  ) {
    nodes {${FULL_ISSUE_FRAGMENT}}
    pageInfo { endCursor hasNextPage }
  }
}
`.trim();

/**
 * Startup terminal-state cleanup query (§8.6). Same shape as the candidate
 * query (paginated) but the state filter is supplied by the caller — typically
 * `tracker.terminal_states`. Project filter still applies.
 */
export const ISSUES_BY_STATES_QUERY = `
query SymphonyIssuesByStates(
  $projectSlug: String!
  $states: [String!]!
  $first: Int!
  $after: String
) {
  issues(
    first: $first
    after: $after
    filter: {
      project: { slugId: { eq: $projectSlug } }
      state: { name: { in: $states } }
    }
  ) {
    nodes {${FULL_ISSUE_FRAGMENT}}
    pageInfo { endCursor hasNextPage }
  }
}
`.trim();

/**
 * State-refresh query for active-run reconciliation (§8.5). Uses GraphQL
 * `[ID!]` variable typing per spec §11.2 — there is a regression test that
 * asserts this exact substring, since Linear also accepts `[String!]` and we
 * want to guard against a silent drift.
 */
export const ISSUE_STATES_BY_IDS_QUERY = `
query SymphonyIssueStatesByIds($ids: [ID!]!) {
  issues(filter: { id: { in: $ids } }) {
    nodes {
      id
      identifier
      state { name }
    }
  }
}
`.trim();
