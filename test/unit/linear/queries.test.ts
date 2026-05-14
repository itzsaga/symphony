// Regression tests pinning the exact query-text contract documented in
// spec §11.2 (project filter via slugId, [ID!] variable typing for state refresh).
import { describe, expect, it } from "bun:test";
import {
  CANDIDATE_ISSUES_QUERY,
  CANDIDATE_PAGE_SIZE,
  ISSUES_BY_STATES_QUERY,
  ISSUE_STATES_BY_IDS_QUERY,
} from "../../../src/linear/queries.ts";

describe("CANDIDATE_ISSUES_QUERY", () => {
  it("filters projects via slugId.eq per spec §11.2", () => {
    expect(CANDIDATE_ISSUES_QUERY).toContain(
      "project: { slugId: { eq: $projectSlug } }",
    );
  });
  it("requests pageInfo with endCursor + hasNextPage", () => {
    expect(CANDIDATE_ISSUES_QUERY).toContain("endCursor");
    expect(CANDIDATE_ISSUES_QUERY).toContain("hasNextPage");
  });
  it("declares the standard issue fields used by normalization", () => {
    for (const field of [
      "identifier",
      "priority",
      "branchName",
      "labels",
      "inverseRelations",
      "createdAt",
      "updatedAt",
    ]) {
      expect(CANDIDATE_ISSUES_QUERY).toContain(field);
    }
  });
});

describe("ISSUES_BY_STATES_QUERY", () => {
  it("uses the same project + state filter shape as the candidate query", () => {
    expect(ISSUES_BY_STATES_QUERY).toContain(
      "project: { slugId: { eq: $projectSlug } }",
    );
    expect(ISSUES_BY_STATES_QUERY).toContain("state: { name: { in: $states } }");
  });
});

describe("ISSUE_STATES_BY_IDS_QUERY", () => {
  it("uses GraphQL [ID!] variable typing per spec §11.2 (regression)", () => {
    // Spec §17.3: "Issue state refresh query uses GraphQL ID typing ([ID!])"
    // Linear also accepts [String!] but the spec requires [ID!] specifically.
    expect(ISSUE_STATES_BY_IDS_QUERY).toContain("[ID!]");
    expect(ISSUE_STATES_BY_IDS_QUERY).not.toContain("[String!]");
  });
  it("requests only id, identifier, and state.name (minimal projection)", () => {
    expect(ISSUE_STATES_BY_IDS_QUERY).toContain("id");
    expect(ISSUE_STATES_BY_IDS_QUERY).toContain("identifier");
    expect(ISSUE_STATES_BY_IDS_QUERY).toContain("state { name }");
    // No description / labels / blockers expected.
    expect(ISSUE_STATES_BY_IDS_QUERY).not.toContain("description");
    expect(ISSUE_STATES_BY_IDS_QUERY).not.toContain("labels");
    expect(ISSUE_STATES_BY_IDS_QUERY).not.toContain("inverseRelations");
  });
});

describe("constants", () => {
  it("pins the candidate page size to 50 per spec §11.2", () => {
    expect(CANDIDATE_PAGE_SIZE).toBe(50);
  });
});
