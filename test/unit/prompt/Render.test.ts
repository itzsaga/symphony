// Unit tests for the strict Liquid prompt renderer (spec §5.4 / §12 / §5.5).
// Covers strict variables, strict filters, attempt semantics, and fallback.
import { describe, expect, it } from "bun:test";
import { Effect, Exit } from "effect";
import { type Issue } from "../../../src/linear/schemas.ts";
import {
  renderPrompt,
  TemplateParseError,
  TemplateRenderError,
} from "../../../src/prompt/Render.ts";

/** Build a normalized Issue with sensible defaults for each test. */
const sampleIssue = (overrides?: Partial<Issue>): Issue => ({
  id: "iss-1",
  identifier: "ABC-1",
  title: "Refactor renderer",
  description: "Body text",
  priority: 2,
  state: "Todo",
  branch_name: "feature/abc-1",
  url: "https://linear.app/x/issue/ABC-1",
  labels: ["bug", "frontend"],
  blocked_by: [],
  created_at: "2025-01-02T03:04:05.000Z",
  updated_at: "2025-01-03T04:05:06.000Z",
  ...overrides,
});

/** Run an Effect, expect success, and return the value. */
const runOk = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect as Effect.Effect<A, never>);

/** Run an Effect, expect failure, and return the typed failure value. */
const runErr = async <E>(
  effect: Effect.Effect<unknown, E>,
): Promise<E> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    throw new Error("expected failure, got success");
  }
  const either = await Effect.runPromise(
    Effect.either(effect).pipe(Effect.orDie),
  );
  if (either._tag === "Right") {
    throw new Error("expected failure, got success");
  }
  return either.left;
};

describe("renderPrompt", () => {
  it("renders identifier and title interpolation", async () => {
    const out = await runOk(
      renderPrompt("{{ issue.identifier }}: {{ issue.title }}", {
        issue: sampleIssue(),
        attempt: null,
      }),
    );
    expect(out).toBe("ABC-1: Refactor renderer");
  });

  it("iterates over labels which are already lowercased", async () => {
    const out = await runOk(
      renderPrompt(
        "{% for l in issue.labels %}{{ l }} {% endfor %}",
        { issue: sampleIssue({ labels: ["bug", "frontend"] }), attempt: null },
      ),
    );
    expect(out).toBe("bug frontend ");
  });

  it("raises TemplateRenderError on unknown variable (strictVariables)", async () => {
    const err = await runErr(
      renderPrompt("{{ issue.unknown }}", {
        issue: sampleIssue(),
        attempt: null,
      }),
    );
    expect(err).toBeInstanceOf(TemplateRenderError);
    expect((err as TemplateRenderError).message).toContain(
      "undefined variable",
    );
  });

  it("raises TemplateRenderError on unknown filter (strictFilters)", async () => {
    const err = await runErr(
      renderPrompt("{{ issue.title | unknown_filter }}", {
        issue: sampleIssue(),
        attempt: null,
      }),
    );
    expect(err).toBeInstanceOf(TemplateRenderError);
    expect((err as TemplateRenderError).message).toContain("undefined filter");
  });

  it("treats attempt=null as falsy and attempt=1 as truthy in {% if %}", async () => {
    const tpl = "{% if attempt %}retry{% else %}first{% endif %}";
    const first = await runOk(
      renderPrompt(tpl, { issue: sampleIssue(), attempt: null }),
    );
    expect(first).toBe("first");
    const retry = await runOk(
      renderPrompt(tpl, { issue: sampleIssue(), attempt: 1 }),
    );
    expect(retry).toBe("retry");
  });

  it("returns the §5.4 fallback for an empty template body", async () => {
    const out = await runOk(
      renderPrompt("", { issue: sampleIssue(), attempt: null }),
    );
    expect(out).toBe("You are working on an issue from Linear.");
    const ws = await runOk(
      renderPrompt("   \n\t  ", { issue: sampleIssue(), attempt: null }),
    );
    expect(ws).toBe("You are working on an issue from Linear.");
  });

  it("does NOT swap a non-empty template that renders to empty for the fallback", async () => {
    // `{% if false %}x{% endif %}` parses fine and renders to "" — must be
    // returned verbatim per the spec, not replaced with the fallback.
    const out = await runOk(
      renderPrompt("{% if false %}x{% endif %}", {
        issue: sampleIssue(),
        attempt: null,
      }),
    );
    expect(out).toBe("");
  });

  it("raises TemplateParseError on a malformed template", async () => {
    const err = await runErr(
      renderPrompt("{{ unclosed", { issue: sampleIssue(), attempt: null }),
    );
    expect(err).toBeInstanceOf(TemplateParseError);
  });

  it("exposes nested blocked_by entries to template iteration", async () => {
    const out = await runOk(
      renderPrompt(
        "{% for b in issue.blocked_by %}{{ b.identifier }}={{ b.state }};{% endfor %}",
        {
          issue: sampleIssue({
            blocked_by: [
              { id: "b1", identifier: "ABC-9", state: "In Progress" },
              { id: "b2", identifier: "ABC-10", state: "Todo" },
            ],
          }),
          attempt: null,
        },
      ),
    );
    expect(out).toBe("ABC-9=In Progress;ABC-10=Todo;");
  });
});
