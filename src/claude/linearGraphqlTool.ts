// `linear_graphql` MCP tool implementation: input validation, exactly-one-operation check, execution via LinearClient.
// Maps tracker results into MCP tool-call response shapes per spec §10.5 (success / GraphQL errors / failures).
import { Effect } from "effect";
import { LinearClient } from "../linear/LinearClient.ts";
import type { LinearClientError } from "../linear/schemas.ts";
import { WorkflowLoader } from "../config/WorkflowLoader.ts";
import {
  type ToolCallResult,
  type ToolDescriptor,
} from "./mcpSchemas.ts";

/* -------------------------------------------------------------------------- */
/* Public tool metadata                                                       */
/* -------------------------------------------------------------------------- */

/** The wire-level tool name advertised to Claude. */
export const LINEAR_GRAPHQL_TOOL_NAME = "linear_graphql";

/**
 * `inputSchema` for the tool, advertised verbatim via `tools/list`. JSON-Schema
 * draft-2020 shape; the model uses it to construct valid invocations. We do
 * NOT enforce this schema at the host side — the host's own validation in
 * {@link executeLinearGraphql} is the authoritative gate (the shorthand
 * "raw string" form deliberately falls outside this object schema and is
 * accepted at the host as an §10.5 implementation extension).
 */
export const LINEAR_GRAPHQL_INPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1 },
    variables: { type: "object" },
  },
  required: ["query"],
};

/**
 * Spec §10.5 verbatim description. The wording is load-bearing — the model
 * reads this to decide when to call the tool — so keep it terse and exact.
 */
export const LINEAR_GRAPHQL_DESCRIPTION =
  "Execute a raw GraphQL query or mutation against Linear using Symphony's configured tracker auth.";

/** Tool descriptor returned by `tools/list`. */
export const linearGraphqlToolDescriptor: ToolDescriptor = {
  name: LINEAR_GRAPHQL_TOOL_NAME,
  description: LINEAR_GRAPHQL_DESCRIPTION,
  inputSchema: LINEAR_GRAPHQL_INPUT_SCHEMA,
};

/* -------------------------------------------------------------------------- */
/* Operation-count helper                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Count top-level GraphQL operations in `doc`. We need exactly one per spec
 * §10.5; multi-operation documents would require an `operationName` selector
 * that the extension intentionally does not support.
 *
 * Implementation note (trade-off): we deliberately avoid pulling in the
 * `graphql-js` reference parser because:
 *   1. It's ~150KB of bundled code for a single-method use,
 *   2. The scanner only needs to disambiguate top-level operation keywords
 *      from those that appear inside strings/comments, which is tractable
 *      with a small state machine.
 *
 * The scanner:
 *   - Strips block (`""" … """`) and single-line strings,
 *   - Strips line comments (`#…`),
 *   - Counts top-level `query` / `mutation` / `subscription` keywords AND
 *     anonymous `{ … }` shorthand operations,
 *   - Tracks brace depth so the keywords inside selection sets don't count
 *     (e.g. a field literally named `query`).
 *
 * GraphQL's lexical rules treat `_A-Za-z0-9` as the name character class, so
 * a keyword match requires non-name characters (or BOF/EOF) on both sides.
 *
 * Edge cases:
 *   - An anonymous shorthand operation `{ foo }` counts as one operation —
 *     a sole top-level `{` with no preceding operation keyword.
 *   - An empty / whitespace-only document yields 0.
 *   - Comments and strings inside otherwise-valid docs are stripped before
 *     counting.
 */
export const countOperations = (doc: string): number => {
  // Strip block strings, line strings, and comments via a single forward
  // scan. We don't try to preserve positions because the count is the only
  // output and we only need keyword visibility.
  let scrubbed = "";
  let i = 0;
  while (i < doc.length) {
    const c = doc[i];
    // Block string `""" … """`.
    if (c === '"' && doc[i + 1] === '"' && doc[i + 2] === '"') {
      const end = doc.indexOf('"""', i + 3);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    // Single-line string `" … "` (no escapes traversed — we just need to
    // know where it ends so keywords inside don't count).
    if (c === '"') {
      let j = i + 1;
      while (j < doc.length && doc[j] !== '"') {
        if (doc[j] === "\\" && j + 1 < doc.length) {
          j += 2;
          continue;
        }
        j += 1;
      }
      i = j + 1;
      continue;
    }
    // Line comment `# … \n`.
    if (c === "#") {
      const nl = doc.indexOf("\n", i + 1);
      if (nl < 0) break;
      i = nl + 1;
      continue;
    }
    scrubbed += c;
    i += 1;
  }

  // Walk the scrubbed source counting top-level operations.
  const isNameChar = (ch: string | undefined): boolean =>
    ch !== undefined && /[A-Za-z0-9_]/.test(ch);

  let depth = 0;
  let count = 0;
  let pendingShorthand = true; // start of doc — a `{` here is anon shorthand
  let j = 0;
  while (j < scrubbed.length) {
    const c = scrubbed[j];
    if (c === "{") {
      if (depth === 0 && pendingShorthand) {
        count += 1;
        pendingShorthand = false;
      }
      depth += 1;
      j += 1;
      continue;
    }
    if (c === "}") {
      if (depth > 0) depth -= 1;
      if (depth === 0) {
        // After the closing brace of an operation, a subsequent `{` is
        // again a candidate for shorthand.
        pendingShorthand = true;
      }
      j += 1;
      continue;
    }
    // Only consider keywords at depth 0. Inside selection sets, `query`
    // could be a field name.
    if (depth === 0) {
      const remainder = scrubbed.slice(j);
      const m = remainder.match(/^(query|mutation|subscription)\b/);
      if (m && !isNameChar(scrubbed[j - 1])) {
        count += 1;
        pendingShorthand = false;
        const keyword = m[1];
        if (keyword === undefined) {
          j += 1;
          continue;
        }
        j += keyword.length;
        continue;
      }
    }
    j += 1;
  }
  return count;
};

/* -------------------------------------------------------------------------- */
/* Result builders                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Build a `success=true` tool result. `data` is the GraphQL `data` field as
 * returned by the server; we render it as both a text block (so the model
 * sees it in its tool-result stream) and as `structuredContent.data` (so a
 * future structured consumer can read it without re-parsing).
 */
const buildSuccessResult = (data: unknown): ToolCallResult => ({
  content: [{ type: "text", text: safeJson(data) }],
  isError: false,
  structuredContent: { success: true, data },
});

/**
 * Build a `success=false` tool result for a GraphQL-level failure. `isError`
 * stays `false` because the tool itself ran — only the underlying GraphQL
 * operation reported errors. Per §10.5 we preserve the full response body
 * (both `data` and `errors`) verbatim for debugging.
 */
const buildGraphqlErrorResult = (
  data: unknown,
  errors: unknown,
): ToolCallResult => ({
  content: [
    {
      type: "text",
      text: safeJson({ data, errors }),
    },
  ],
  isError: false,
  structuredContent: { success: false, data, errors },
});

/**
 * Build an `isError=true` tool result. Used for invalid input, missing auth,
 * and transport / decode failures. The structured payload carries a stable
 * `error.code` the model (or an operator script) can pattern-match on.
 */
const buildErrorResult = (
  code: string,
  message: string,
): ToolCallResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
  structuredContent: { success: false, error: { code, message } },
});

/**
 * `JSON.stringify` that never throws. The tool result must always be a valid
 * MCP frame; if the GraphQL payload contains something exotic (which it
 * shouldn't — Linear returns JSON) we degrade to `String(value)`.
 */
const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

/* -------------------------------------------------------------------------- */
/* Input narrowing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Internal narrowed input. `query` is always a non-empty string; `variables`
 * is either an object or `null` (when omitted on the wire). The shorthand
 * "raw string" input is normalized into this shape before validation.
 */
interface NarrowedInput {
  readonly query: string;
  readonly variables: Record<string, unknown> | null;
}

/**
 * Narrow the raw `arguments` body (which can be a string, an object, or
 * `undefined`) into the {@link NarrowedInput} shape. Returns either a
 * `Right<NarrowedInput>` or a `Left<{ code, message }>` we can fold into a
 * tool-error result. We avoid Effect's `Either` here because the surrounding
 * effect already uses tagged returns; a plain union is simpler.
 */
const narrowArguments = (
  args: unknown,
):
  | { readonly _tag: "ok"; readonly input: NarrowedInput }
  | { readonly _tag: "err"; readonly code: string; readonly message: string } => {
  // §10.5 shorthand: a bare string is accepted as the query.
  if (typeof args === "string") {
    if (args.trim().length === 0) {
      return {
        _tag: "err",
        code: "missing_query",
        message: "linear_graphql: query must be a non-empty string",
      };
    }
    return {
      _tag: "ok",
      input: { query: args, variables: null },
    };
  }
  // Anything else must be an object.
  if (typeof args !== "object" || args === null) {
    return {
      _tag: "err",
      code: "invalid_arguments",
      message:
        "linear_graphql: arguments must be either a raw query string or an object with a `query` field",
    };
  }
  const obj = args as Record<string, unknown>;
  const query = obj["query"];
  if (typeof query !== "string" || query.trim().length === 0) {
    return {
      _tag: "err",
      code: "missing_query",
      message: "linear_graphql: query must be a non-empty string",
    };
  }
  // `variables` is optional; if present it must be a plain object (not an
  // array, not a primitive, not null-as-explicit). Absent → null.
  const variables = obj["variables"];
  if (variables === undefined) {
    return { _tag: "ok", input: { query, variables: null } };
  }
  if (
    typeof variables !== "object" ||
    variables === null ||
    Array.isArray(variables)
  ) {
    return {
      _tag: "err",
      code: "invalid_variables",
      message: "linear_graphql: variables must be a JSON object when provided",
    };
  }
  return {
    _tag: "ok",
    input: { query, variables: variables as Record<string, unknown> },
  };
};

/* -------------------------------------------------------------------------- */
/* Auth precondition                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Reject early when no Linear auth is configured. We read the WorkflowLoader
 * snapshot rather than letting the LinearClient surface the same condition —
 * doing it here gives us a stable `missing_auth` error code in the tool
 * output before the request is even attempted.
 *
 * Returns `null` on success, or an error descriptor on failure.
 */
const checkAuthAvailable = (): Effect.Effect<
  { readonly code: string; readonly message: string } | null,
  never,
  WorkflowLoader
> =>
  Effect.gen(function* () {
    const loader = yield* WorkflowLoader;
    const snapshot = yield* loader.current;
    const tracker = snapshot.config.tracker;
    if (tracker.api_key === null || tracker.api_key.length === 0) {
      return {
        code: "missing_auth",
        message:
          "linear_graphql: tracker.api_key is unset; configure it in WORKFLOW.md or via $VAR",
      };
    }
    return null;
  });

/* -------------------------------------------------------------------------- */
/* LinearClientError → tool-error message                                     */
/* -------------------------------------------------------------------------- */

/**
 * Map a typed `LinearClientError` into the `{ code, message }` pair we surface
 * in the tool result. `executeRaw` deliberately does NOT raise
 * `LinearGraphqlErrors` — those are returned in-band via the envelope — but
 * we cover the case anyway for forward-compat.
 */
const formatLinearError = (
  err: LinearClientError,
): { readonly code: string; readonly message: string } => {
  switch (err._tag) {
    case "LinearRequestFail":
      return {
        code: "transport_error",
        message: `linear_graphql: transport error against ${err.endpoint}: ${err.message}`,
      };
    case "LinearStatusFail":
      return {
        code: "status_error",
        message: `linear_graphql: Linear returned HTTP ${err.status} against ${err.endpoint}`,
      };
    case "LinearGraphqlErrors":
      return {
        code: "graphql_errors",
        message: `linear_graphql: GraphQL errors against ${err.endpoint}`,
      };
    case "LinearUnknownPayload":
      return {
        code: "decode_error",
        message: `linear_graphql: failed to decode Linear response: ${err.message}`,
      };
    case "LinearMissingEndCursor":
      // executeRaw doesn't paginate, but the tagged union forces us to handle it.
      return {
        code: "decode_error",
        message: `linear_graphql: malformed pagination payload from ${err.endpoint}`,
      };
  }
};

/* -------------------------------------------------------------------------- */
/* The tool itself                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Execute the `linear_graphql` tool against the supplied raw `arguments`
 * value (whatever the model passed in `tools/call.params.arguments`). Returns
 * a fully-formed MCP `tools/call` result body in every case — success,
 * GraphQL-level errors, and host-level rejections all become a valid
 * {@link ToolCallResult}.
 *
 * The effect never fails: `LinearClientError`s are pattern-matched into
 * `isError: true` results so the JSON-RPC layer always has something to
 * write back, satisfying the §10.5 "unsupported tool names SHOULD still
 * return a failure result … and continue the session" requirement.
 */
export const executeLinearGraphql = (
  args: unknown,
): Effect.Effect<ToolCallResult, never, LinearClient | WorkflowLoader> =>
  Effect.gen(function* () {
    // 1. Narrow the input. Rejects empty / missing / wrong-shape queries.
    const narrowed = narrowArguments(args);
    if (narrowed._tag === "err") {
      return buildErrorResult(narrowed.code, narrowed.message);
    }
    const { query, variables } = narrowed.input;

    // 2. Exactly-one-operation check. Spec §10.5: "If the provided document
    //    contains multiple operations, reject the tool call as invalid input."
    const operations = countOperations(query);
    if (operations !== 1) {
      return buildErrorResult(
        operations === 0 ? "missing_operation" : "multiple_operations",
        operations === 0
          ? "linear_graphql: query must contain exactly one GraphQL operation (got 0)"
          : `linear_graphql: query must contain exactly one GraphQL operation (got ${operations})`,
      );
    }

    // 3. Auth precondition. The LinearClient itself would surface a similar
    //    condition as `LinearRequestFail`, but we want a stable
    //    `missing_auth` code in the tool output.
    const authErr = yield* checkAuthAvailable();
    if (authErr !== null) {
      return buildErrorResult(authErr.code, authErr.message);
    }

    // 4. Execute. `executeRaw` returns the raw envelope with `errors[]`
    //    preserved (it does NOT raise `LinearGraphqlErrors`).
    const linear = yield* LinearClient;
    const result = yield* linear
      .executeRaw(query, variables ?? {})
      .pipe(Effect.either);

    if (result._tag === "Left") {
      const { code, message } = formatLinearError(result.left);
      return buildErrorResult(code, message);
    }

    // 5. Map the envelope. We expect `{ data?, errors? }` per
    //    RawGraphqlEnvelope; if the server returned `errors[]`, surface them
    //    verbatim with `success=false`. Otherwise `data` is the success
    //    payload.
    const envelope = result.right as {
      readonly data?: unknown;
      readonly errors?: ReadonlyArray<unknown>;
    };
    if (
      envelope.errors !== undefined &&
      Array.isArray(envelope.errors) &&
      envelope.errors.length > 0
    ) {
      return buildGraphqlErrorResult(envelope.data ?? null, envelope.errors);
    }
    return buildSuccessResult(envelope.data ?? null);
  });
