# Linear tracker client

## Objective

Implement `LinearClient` as an Effect service exposing the three required tracker operations (§11.1) — `fetchCandidateIssues`, `fetchIssuesByStates`, `fetchIssueStatesByIds` — backed by Linear's GraphQL API. Returns normalized `Issue` records per §4.1.1. Handles pagination, the §11.2 query semantics (project filter via `slugId`, ID typing `[ID!]`), and the §11.4 error categories.

## Context

### Parent PRD

- **PRD**: Symphony v1 (Effect.ts + Claude Code)
- **PRD Path**: `.claude/prds/symphony-v1/PRD.md`

### Related Tasks

- **Depends on**: Bun + TypeScript + Effect setup, logger-service.md, workflow-loader-and-watch.md (for config).
- **Blocks**: orchestrator-dispatch.md, orchestrator-reconcile.md, mcp-server-and-linear-graphql.md.

## Acceptance Criteria

- [ ] `Context.Tag<LinearClient>` with three methods (all return `Effect<…, LinearClientError>`):
  - `fetchCandidateIssues(): Effect<ReadonlyArray<Issue>>` — issues in `tracker.active_states` for `tracker.project_slug`. Paginated.
  - `fetchIssuesByStates(stateNames: ReadonlyArray<string>): Effect<ReadonlyArray<Issue>>` — used for startup terminal cleanup (§8.6). Empty input → empty output without an API call (§17.3 bullet).
  - `fetchIssueStatesByIds(issueIds: ReadonlyArray<string>): Effect<ReadonlyArray<MinimalIssue>>` — for active-run reconciliation (§8.5).
  - `executeRaw(query: string, variables?: Record<string, unknown>): Effect<unknown, LinearClientError>` — used by the `linear_graphql` MCP tool. Returns the raw GraphQL response body.
- [ ] Uses `@effect/platform`'s `HttpClient` with retry/timeout policies. Per-request timeout: 30,000 ms (§11.2). On retry-eligible failures (transport, 5xx) uses `Schedule.exponential(…)` capped at the workflow's `agent_runner` retry cap or a sensible default.
- [ ] Auth: `Authorization: <api_key>` header (Linear takes a raw API key, no `Bearer` prefix).
- [ ] Endpoint: `tracker.endpoint` (defaults to `https://api.linear.app/graphql`).
- [ ] GraphQL queries are isolated in `src/linear/queries.ts` as named exported strings. Each is paired with an `@effect/schema` for its response shape.
- [ ] Candidate-issue query uses `project: { slugId: { eq: $projectSlug } }` (§11.2). Each candidate page returns up to 50 issues (§11.2). Pagination follows `pageInfo.endCursor` / `pageInfo.hasNextPage`; missing `endCursor` while `hasNextPage=true` raises `LinearMissingEndCursor`.
- [ ] State-refresh query uses `[ID!]` variable typing (§11.2 bullet, §17.3 bullet).
- [ ] Normalization (§4.1.1, §11.3):
  - `labels` lowercased.
  - `blocked_by` derived from inverse relations of type `blocks`.
  - `priority` integer or null (non-integer → null).
  - `created_at`, `updated_at` parsed as ISO-8601.
- [ ] Error mapping (§11.4):
  - Transport errors → `LinearRequestFail`.
  - Non-200 → `LinearStatusFail` (carry status code).
  - `errors` array in GraphQL response → `LinearGraphqlErrors` (carry the errors).
  - Schema decode failure → `LinearUnknownPayload`.
  - Missing `endCursor` with `hasNextPage=true` → `LinearMissingEndCursor`.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `src/linear/LinearClient.ts` | Create | Service Tag + Live Layer. |
| `src/linear/queries.ts` | Create | GraphQL operation strings + named exports. |
| `src/linear/schemas.ts` | Create | `@effect/schema` for response payloads + Issue domain model. |
| `src/linear/normalize.ts` | Create | Pure transforms from raw GraphQL response → `Issue` / `MinimalIssue`. |

### Technical Constraints

- Do NOT use a heavy GraphQL client library. The spec is explicit (§11.2): *"Linear GraphQL schema details can drift. Keep query construction isolated and test the exact query fields/types REQUIRED by this specification."* Hand-written query strings are correct here.
- All Linear API I/O routes through the service. No direct `fetch` calls elsewhere.
- Page size 50 is a constant; do not expose as config in v1.
- For `executeRaw`, do not normalize the response. The MCP tool wants the raw GraphQL body per §10.5 ("preserve the GraphQL response body for debugging").

### Relevant Code References

- Spec §4.1.1 (Issue fields), §4.2 (normalization), §11 (entire section), §17.3 (test list).
- `research/claude-stream-json.md` — informs the contract of the eventual MCP tool (different task).

## Testing Requirements

- [ ] Each error category produced for a synthesized HTTP scenario (transport, 5xx, GraphQL errors, malformed payload, missing endCursor).
- [ ] Pagination preserves order across two pages.
- [ ] `fetchIssuesByStates([])` returns `[]` without making an HTTP call.
- [ ] Normalization tests: lowercased labels, derived `blocked_by`, null priority for non-integer, ISO-8601 timestamps.
- [ ] State-refresh query body literally contains `[ID!]` (regression: don't accidentally use `[String!]` which Linear accepts but spec rejects).
- [ ] `executeRaw` returns the raw `data` + `errors` shape unchanged.
- [ ] The Real Integration Profile test (linear-integration-profile.md) exercises against a real key when set.

## Out of Scope

- Tracker-agnostic abstraction layer (deferred to §18.2 / a future PRD).
- First-class tracker write APIs (the agent does writes via `linear_graphql`, per §11.5).
- OAuth flow. API key auth only.
- Caching of issue data between ticks. Always fetch fresh.
