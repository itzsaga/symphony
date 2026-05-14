// Unit tests for the pure Linear -> domain normalizers in src/linear/normalize.ts.
// Covers spec §11.3 rules: lowercased labels, derived blocked_by, integer-only
// priority, ISO-8601 timestamps.
import { describe, expect, it } from "bun:test";
import {
  normalizeIssue,
  normalizeMinimalIssue,
} from "../../../src/linear/normalize.ts";
import type {
  RawIssueNode,
  RawMinimalIssueNode,
} from "../../../src/linear/schemas.ts";

/** Build a fully-populated raw issue node with sensible defaults for tests. */
const rawIssue = (overrides?: Partial<RawIssueNode>): RawIssueNode => ({
  id: "iss-1",
  identifier: "ABC-1",
  title: "Title",
  description: "desc",
  priority: 2,
  state: { name: "Todo" },
  branchName: "feature/abc-1",
  url: "https://linear.app/x/issue/ABC-1",
  labels: { nodes: [{ name: "Bug" }, { name: "FRONTEND" }] },
  inverseRelations: { nodes: [] },
  createdAt: "2025-01-02T03:04:05.000Z",
  updatedAt: "2025-01-03T04:05:06.000Z",
  ...overrides,
});

describe("normalizeIssue", () => {
  it("lowercases all label names and dedupes case-insensitive duplicates", () => {
    const issue = normalizeIssue(
      rawIssue({
        labels: {
          nodes: [{ name: "Bug" }, { name: "BUG" }, { name: "Backend" }],
        },
      }),
    );
    expect(issue.labels).toEqual(["bug", "backend"]);
  });

  it("derives blocked_by from inverse relations of type 'blocks' only", () => {
    const issue = normalizeIssue(
      rawIssue({
        inverseRelations: {
          nodes: [
            {
              type: "blocks",
              issue: {
                id: "blk-1",
                identifier: "ABC-9",
                state: { name: "In Progress" },
              },
            },
            {
              type: "duplicate",
              issue: {
                id: "dup-1",
                identifier: "ABC-2",
                state: { name: "Done" },
              },
            },
            {
              type: "blocks",
              issue: {
                id: "blk-2",
                identifier: "ABC-10",
                state: { name: "Todo" },
              },
            },
          ],
        },
      }),
    );
    expect(issue.blocked_by).toEqual([
      { id: "blk-1", identifier: "ABC-9", state: "In Progress" },
      { id: "blk-2", identifier: "ABC-10", state: "Todo" },
    ]);
  });

  it("surfaces a fully-null BlockerRef when the related issue is inaccessible", () => {
    const issue = normalizeIssue(
      rawIssue({
        inverseRelations: {
          nodes: [{ type: "blocks", issue: null }],
        },
      }),
    );
    expect(issue.blocked_by).toEqual([
      { id: null, identifier: null, state: null },
    ]);
  });

  it("produces null priority when raw priority is not an integer", () => {
    expect(normalizeIssue(rawIssue({ priority: 1.5 })).priority).toBeNull();
    expect(normalizeIssue(rawIssue({ priority: "2" })).priority).toBeNull();
    expect(normalizeIssue(rawIssue({ priority: null })).priority).toBeNull();
    expect(normalizeIssue(rawIssue({ priority: NaN })).priority).toBeNull();
  });

  it("preserves integer priorities (including zero)", () => {
    expect(normalizeIssue(rawIssue({ priority: 0 })).priority).toBe(0);
    expect(normalizeIssue(rawIssue({ priority: 4 })).priority).toBe(4);
  });

  it("keeps ISO-8601 timestamp strings that parse and nulls out unparseable ones", () => {
    const ok = normalizeIssue(
      rawIssue({
        createdAt: "2024-12-31T23:59:59Z",
        updatedAt: "2025-01-01T00:00:00.123Z",
      }),
    );
    expect(ok.created_at).toBe("2024-12-31T23:59:59Z");
    expect(ok.updated_at).toBe("2025-01-01T00:00:00.123Z");
    const bad = normalizeIssue(
      rawIssue({ createdAt: "not-a-date", updatedAt: null }),
    );
    expect(bad.created_at).toBeNull();
    expect(bad.updated_at).toBeNull();
  });

  it("falls back to '' when state.name is null or state is null", () => {
    expect(normalizeIssue(rawIssue({ state: null })).state).toBe("");
    expect(
      normalizeIssue(rawIssue({ state: { name: null } })).state,
    ).toBe("");
  });

  it("passes through identifier, title, branch_name, url, description verbatim", () => {
    const issue = normalizeIssue(
      rawIssue({
        identifier: "MT-42",
        title: "ship the feature",
        branchName: "mt/42",
        url: "https://example.com",
        description: null,
      }),
    );
    expect(issue.identifier).toBe("MT-42");
    expect(issue.title).toBe("ship the feature");
    expect(issue.branch_name).toBe("mt/42");
    expect(issue.url).toBe("https://example.com");
    expect(issue.description).toBeNull();
  });
});

describe("normalizeMinimalIssue", () => {
  const raw = (overrides?: Partial<RawMinimalIssueNode>): RawMinimalIssueNode => ({
    id: "iss-1",
    identifier: "ABC-1",
    state: { name: "Todo" },
    ...overrides,
  });

  it("projects { id, identifier, state.name }", () => {
    expect(normalizeMinimalIssue(raw())).toEqual({
      id: "iss-1",
      identifier: "ABC-1",
      state: "Todo",
    });
  });

  it("falls back to '' when state.name or state is null", () => {
    expect(normalizeMinimalIssue(raw({ state: null })).state).toBe("");
    expect(
      normalizeMinimalIssue(raw({ state: { name: null } })).state,
    ).toBe("");
  });
});
