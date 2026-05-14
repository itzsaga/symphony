// LinearClient Effect service: GraphQL transport, pagination, normalization,
// and tagged errors per spec §11. Three required tracker ops + executeRaw.
import {
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpIncomingMessage,
} from "@effect/platform";
import {
  Context,
  Duration,
  Effect,
  Layer,
  Schedule,
  Schema,
  type ParseResult,
} from "effect";
import { WorkflowLoader } from "../config/WorkflowLoader.ts";
import { normalizeIssue, normalizeMinimalIssue } from "./normalize.ts";
import {
  CANDIDATE_ISSUES_QUERY,
  CANDIDATE_PAGE_SIZE,
  ISSUES_BY_STATES_QUERY,
  ISSUE_STATES_BY_IDS_QUERY,
} from "./queries.ts";
import {
  type Issue,
  LinearGraphqlErrors,
  LinearMissingEndCursor,
  LinearRequestFail,
  LinearStatusFail,
  LinearUnknownPayload,
  type LinearClientError,
  type MinimalIssue,
  RawGraphqlEnvelope,
  RawIssuesByIdsQueryData,
  RawIssuesQueryData,
} from "./schemas.ts";

/* -------------------------------------------------------------------------- */
/* Service interface + Tag                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Public LinearClient API. All four methods return `Effect<…, LinearClientError>`
 * so callers can pattern-match on the §11.4 error categories without inspecting
 * cause chains.
 */
export interface LinearClientService {
  /**
   * Fetch every issue whose state name is in `tracker.active_states` for the
   * configured `tracker.project_slug`. Pages of {@link CANDIDATE_PAGE_SIZE}
   * are walked until `hasNextPage=false`.
   */
  readonly fetchCandidateIssues: Effect.Effect<
    ReadonlyArray<Issue>,
    LinearClientError
  >;
  /**
   * Fetch every issue whose state name is in `stateNames` for the configured
   * `tracker.project_slug`. Used at startup to clean up workspaces for issues
   * that have moved to terminal states (§8.6). Empty input short-circuits to
   * `[]` without making an HTTP call (§17.3).
   */
  readonly fetchIssuesByStates: (
    stateNames: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<Issue>, LinearClientError>;
  /**
   * Fetch a minimal `{ id, identifier, state }` projection for the supplied
   * Linear issue IDs. Used by reconciliation (§8.5) to detect issues that
   * have moved out of an active state while a worker was running. Variable
   * type is GraphQL `[ID!]` (regression-tested).
   */
  readonly fetchIssueStatesByIds: (
    issueIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<MinimalIssue>, LinearClientError>;
  /**
   * Issue an arbitrary GraphQL query against the Linear endpoint and return
   * the raw response body unchanged (no schema decode, no normalization).
   * Backs the `linear_graphql` MCP tool — debuggability over typing.
   */
  readonly executeRaw: (
    query: string,
    variables?: Record<string, unknown>,
  ) => Effect.Effect<unknown, LinearClientError>;
}

/** The LinearClient service tag. */
export class LinearClient extends Context.Tag("symphony/linear/LinearClient")<
  LinearClient,
  LinearClientService
>() {}

/* -------------------------------------------------------------------------- */
/* Internal constants                                                         */
/* -------------------------------------------------------------------------- */

/** Per-request HTTP timeout (spec §11.2). */
const REQUEST_TIMEOUT = Duration.millis(30_000);

/**
 * Default retry schedule for transport + 5xx failures. Exponential starting at
 * 250ms, capped at 5 attempts (initial + 4 retries). The spec leaves the cap
 * to the implementation — 5 is a reasonable balance between resilience and
 * avoiding long blocking polls when Linear is hard down.
 *
 * `Schedule<unknown, unknown>` is the most permissive retry policy type; the
 * concrete schedule outputs irrelevant values consumed by `Effect.retry`.
 */
export const DEFAULT_RETRY_SCHEDULE: Schedule.Schedule<unknown, unknown> =
  Schedule.exponential(Duration.millis(250)).pipe(
    Schedule.compose(Schedule.recurs(4)),
  );

/* -------------------------------------------------------------------------- */
/* HTTP plumbing — single POST helper used by every operation.                */
/* -------------------------------------------------------------------------- */

/**
 * Build and execute a single GraphQL POST against `endpoint`. Decodes the
 * `{ data?, errors? }` envelope, applies the spec §11.4 error mapping, and
 * returns the raw envelope so caller-specific code can drill into `data`.
 *
 * Retry/timeout policies are layered here so every operation gets identical
 * resilience semantics. We retry on `RequestError` (transport) and on 5xx
 * responses; 4xx errors are deterministic and not retried.
 */
const postGraphql = (
  endpoint: string,
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
  client: HttpClient.HttpClient,
  retrySchedule: Schedule.Schedule<unknown, unknown>,
): Effect.Effect<RawGraphqlEnvelope, LinearClientError> =>
  Effect.gen(function* () {
    // bodyJson serializes safely and sets Content-Type. It can fail with
    // HttpBodyError (e.g. circular variable graph); we map that to
    // LinearRequestFail since it's effectively a "we couldn't form the
    // request" condition from the operator's point of view.
    const requestBase = HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.setHeader("Authorization", apiKey),
      HttpClientRequest.acceptJson,
    );
    const request = yield* HttpClientRequest.bodyJson({ query, variables })(
      requestBase,
    ).pipe(
      Effect.mapError(
        (err: HttpBody.HttpBodyError) =>
          new LinearRequestFail({
            endpoint,
            message: `failed to encode GraphQL body: ${err.reason._tag}`,
            cause: err,
          }),
      ),
    );

    // Execute, retry on transient failures, time out per spec §11.2.
    const response = yield* client.execute(request).pipe(
      Effect.timeoutFail({
        duration: REQUEST_TIMEOUT,
        onTimeout: () =>
          new LinearRequestFail({
            endpoint,
            message: `request timed out after ${Duration.toMillis(REQUEST_TIMEOUT)}ms`,
          }),
      }),
      Effect.mapError(
        (err): LinearClientError =>
          new LinearRequestFail({
            endpoint,
            message: err.message,
            cause: err,
          }),
      ),
      // Retry on transport failures only; status-based retries are handled
      // below where we have the response in hand.
      Effect.retry({
        schedule: retrySchedule,
        while: (e) => e._tag === "LinearRequestFail",
      }),
    );

    // Non-200: capture status + body and surface as LinearStatusFail. Retry
    // 5xx via the same exponential schedule by failing into a tagged error
    // that the outer retry can match on.
    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      const failure = new LinearStatusFail({
        endpoint,
        status: response.status,
        body: body.length === 0 ? null : body,
      });
      // Inline retry for 5xx: re-issue the entire postGraphql call. Caller
      // experience is identical (one Effect, retried internally).
      if (response.status >= 500) {
        return yield* Effect.fail(failure);
      }
      return yield* Effect.fail(failure);
    }

    // 2xx: decode the envelope and map any failure to LinearUnknownPayload.
    const envelope = yield* HttpIncomingMessage.schemaBodyJson(
      RawGraphqlEnvelope,
    )(response).pipe(
      Effect.mapError(
        (err): LinearClientError =>
          new LinearUnknownPayload({
            endpoint,
            message: `failed to decode GraphQL envelope: ${describeDecodeError(err)}`,
            cause: err,
          }),
      ),
    );

    // GraphQL-level errors take precedence over `data`: if the server set
    // `errors[]` we treat the whole call as a hard failure even when `data`
    // is partially populated. Spec §11.4 lists `linear_graphql_errors` as a
    // distinct category; orchestrator logs and skips dispatch for the tick.
    if (envelope.errors !== undefined && envelope.errors.length > 0) {
      return yield* Effect.fail(
        new LinearGraphqlErrors({
          endpoint,
          errors: envelope.errors,
        }),
      );
    }

    return envelope;
  }).pipe(
    // Outer retry handles the 5xx case above by treating LinearStatusFail
    // with status >= 500 as transient. 4xx remain non-retryable.
    Effect.retry({
      schedule: retrySchedule,
      while: (e) =>
        e._tag === "LinearStatusFail" && e.status >= 500,
    }),
  );

/**
 * Render an Effect Schema decode error into a short string. We only need the
 * top-level message — full ParseError formatting is verbose and noisy in
 * operator logs.
 */
const describeDecodeError = (err: unknown): string => {
  if (err === null || err === undefined) return "unknown decode error";
  if (typeof err === "object" && "message" in err) {
    const msg = (err as { message: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  return String(err);
};

/* -------------------------------------------------------------------------- */
/* Per-data-shape decode helpers.                                             */
/* -------------------------------------------------------------------------- */

/**
 * Decode the `data` field of an issue list query into `RawIssuesQueryData`.
 * Mapped to LinearUnknownPayload on failure so callers see a consistent
 * tagged error category.
 */
const decodeIssuesQueryData = (
  endpoint: string,
  data: unknown,
): Effect.Effect<RawIssuesQueryData, LinearClientError> =>
  Schema.decodeUnknown(RawIssuesQueryData)(data).pipe(
    Effect.mapError(
      (err: ParseResult.ParseError): LinearClientError =>
        new LinearUnknownPayload({
          endpoint,
          message: `unexpected issues payload shape: ${err.message}`,
          cause: err,
        }),
    ),
  );

const decodeIssuesByIdsQueryData = (
  endpoint: string,
  data: unknown,
): Effect.Effect<RawIssuesByIdsQueryData, LinearClientError> =>
  Schema.decodeUnknown(RawIssuesByIdsQueryData)(data).pipe(
    Effect.mapError(
      (err: ParseResult.ParseError): LinearClientError =>
        new LinearUnknownPayload({
          endpoint,
          message: `unexpected issue-states payload shape: ${err.message}`,
          cause: err,
        }),
    ),
  );

/* -------------------------------------------------------------------------- */
/* Pagination helper used by both fetchCandidateIssues and fetchIssuesByStates */
/* -------------------------------------------------------------------------- */

/**
 * Walk a paginated `issues(...)` connection until `hasNextPage=false`.
 *
 * Implemented as an explicit recursive Effect rather than a Stream because
 * the operations only need to produce a flat in-memory array — there is no
 * downstream backpressure to model. Each page is concatenated in order, so
 * the combined output preserves Linear's sort order across pages.
 *
 * Errors:
 *   - Transport / status / GraphQL / decode failures bubble up unchanged
 *     from `postGraphql`.
 *   - `hasNextPage=true` with a `null`/missing `endCursor` raises
 *     `LinearMissingEndCursor` per spec §11.4.
 */
const fetchPaginatedIssues = (
  endpoint: string,
  apiKey: string,
  query: string,
  baseVariables: Record<string, unknown>,
  client: HttpClient.HttpClient,
  retrySchedule: Schedule.Schedule<unknown, unknown>,
): Effect.Effect<ReadonlyArray<Issue>, LinearClientError> => {
  const loop = (
    cursor: string | null,
    accum: ReadonlyArray<Issue>,
  ): Effect.Effect<ReadonlyArray<Issue>, LinearClientError> =>
    Effect.gen(function* () {
      const variables: Record<string, unknown> = {
        ...baseVariables,
        first: CANDIDATE_PAGE_SIZE,
        after: cursor,
      };
      const envelope = yield* postGraphql(
        endpoint,
        apiKey,
        query,
        variables,
        client,
        retrySchedule,
      );
      const data = yield* decodeIssuesQueryData(endpoint, envelope.data);
      const page = data.issues.nodes.map(normalizeIssue);
      const next: ReadonlyArray<Issue> = [...accum, ...page];
      const { hasNextPage, endCursor } = data.issues.pageInfo;
      if (!hasNextPage) return next;
      if (endCursor === null) {
        return yield* Effect.fail(new LinearMissingEndCursor({ endpoint }));
      }
      return yield* loop(endCursor, next);
    });
  return loop(null, []);
};

/* -------------------------------------------------------------------------- */
/* Service constructor (pure factory, takes resolved endpoint+key+client)     */
/* -------------------------------------------------------------------------- */

/**
 * Build a `LinearClientService` bound to a fixed endpoint, api key, and
 * HttpClient. Exposed for tests that want to wire a fake HttpClient + a
 * static config without going through `WorkflowLoader`.
 *
 * The Live Layer below uses this and resolves endpoint/api_key from the
 * current `WorkflowLoader` snapshot at the time the service is read out of
 * the context — config reloads at runtime are picked up because every method
 * re-reads `WorkflowLoader.current` on invocation (see `LinearClientLive`).
 *
 * `retrySchedule` is overridable so tests can use a near-zero policy without
 * blocking for the production exponential-backoff cap.
 */
export const make = (
  endpoint: string,
  apiKey: string,
  client: HttpClient.HttpClient,
  projectSlug: string | null,
  activeStates: ReadonlyArray<string>,
  retrySchedule: Schedule.Schedule<unknown, unknown> = DEFAULT_RETRY_SCHEDULE,
): LinearClientService => ({
  fetchCandidateIssues: Effect.suspend(() => {
    if (projectSlug === null || projectSlug.length === 0) {
      return Effect.fail(
        new LinearRequestFail({
          endpoint,
          message:
            "tracker.project_slug is unset; cannot build candidate-issue query",
        }),
      );
    }
    return fetchPaginatedIssues(
      endpoint,
      apiKey,
      CANDIDATE_ISSUES_QUERY,
      { projectSlug, states: activeStates },
      client,
      retrySchedule,
    );
  }),
  fetchIssuesByStates: (stateNames) =>
    Effect.suspend(() => {
      // Spec §17.3: empty input must return [] without making an API call.
      // The check lives here (not in fetchPaginatedIssues) so it's directly
      // observable in the test transport's request count.
      if (stateNames.length === 0) {
        return Effect.succeed([] as ReadonlyArray<Issue>);
      }
      if (projectSlug === null || projectSlug.length === 0) {
        return Effect.fail(
          new LinearRequestFail({
            endpoint,
            message:
              "tracker.project_slug is unset; cannot build by-states query",
          }),
        );
      }
      return fetchPaginatedIssues(
        endpoint,
        apiKey,
        ISSUES_BY_STATES_QUERY,
        { projectSlug, states: stateNames },
        client,
        retrySchedule,
      );
    }),
  fetchIssueStatesByIds: (issueIds) =>
    Effect.suspend(() => {
      if (issueIds.length === 0) {
        return Effect.succeed([] as ReadonlyArray<MinimalIssue>);
      }
      return Effect.gen(function* () {
        const envelope = yield* postGraphql(
          endpoint,
          apiKey,
          ISSUE_STATES_BY_IDS_QUERY,
          { ids: issueIds },
          client,
          retrySchedule,
        );
        const data = yield* decodeIssuesByIdsQueryData(endpoint, envelope.data);
        return data.issues.nodes.map(normalizeMinimalIssue);
      });
    }),
  executeRaw: (query, variables) =>
    Effect.suspend(() =>
      // executeRaw returns the raw envelope (data + errors) unchanged. We do
      // NOT raise LinearGraphqlErrors here — the MCP tool wants to surface
      // GraphQL errors verbatim per §10.5 ("preserve the GraphQL response
      // body for debugging"). To bypass postGraphql's GraphQL-error
      // promotion we re-implement the minimal decode path inline.
      executeRawRequest(
        endpoint,
        apiKey,
        query,
        variables ?? {},
        client,
        retrySchedule,
      ),
    ),
});

/**
 * Execute a single raw GraphQL POST without the §11.4 GraphQL-errors
 * promotion. Transport / status / decode errors still map to the tagged
 * union — only the `errors[]` array is preserved as-is on the way out.
 */
const executeRawRequest = (
  endpoint: string,
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
  client: HttpClient.HttpClient,
  retrySchedule: Schedule.Schedule<unknown, unknown>,
): Effect.Effect<unknown, LinearClientError> =>
  Effect.gen(function* () {
    const requestBase = HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.setHeader("Authorization", apiKey),
      HttpClientRequest.acceptJson,
    );
    const request = yield* HttpClientRequest.bodyJson({ query, variables })(
      requestBase,
    ).pipe(
      Effect.mapError(
        (err: HttpBody.HttpBodyError) =>
          new LinearRequestFail({
            endpoint,
            message: `failed to encode GraphQL body: ${err.reason._tag}`,
            cause: err,
          }),
      ),
    );
    const response = yield* client.execute(request).pipe(
      Effect.timeoutFail({
        duration: REQUEST_TIMEOUT,
        onTimeout: () =>
          new LinearRequestFail({
            endpoint,
            message: `request timed out after ${Duration.toMillis(REQUEST_TIMEOUT)}ms`,
          }),
      }),
      Effect.mapError(
        (err): LinearClientError =>
          new LinearRequestFail({
            endpoint,
            message: err.message,
            cause: err,
          }),
      ),
      Effect.retry({
        schedule: retrySchedule,
        while: (e) => e._tag === "LinearRequestFail",
      }),
    );
    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* Effect.fail(
        new LinearStatusFail({
          endpoint,
          status: response.status,
          body: body.length === 0 ? null : body,
        }),
      );
    }
    // Decode as the same envelope shape but pass the raw value through. The
    // schema enforces the `{ data?, errors? }` outer shape; anything that
    // decodes is an acceptable raw return for the MCP tool.
    const envelope = yield* HttpIncomingMessage.schemaBodyJson(
      RawGraphqlEnvelope,
    )(response).pipe(
      Effect.mapError(
        (err): LinearClientError =>
          new LinearUnknownPayload({
            endpoint,
            message: `failed to decode GraphQL envelope: ${describeDecodeError(err)}`,
            cause: err,
          }),
      ),
    );
    return envelope;
  }).pipe(
    Effect.retry({
      schedule: retrySchedule,
      while: (e) => e._tag === "LinearStatusFail" && e.status >= 500,
    }),
  );

/* -------------------------------------------------------------------------- */
/* Live Layer                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Wire the LinearClient against the current `WorkflowLoader` snapshot and an
 * `HttpClient` already provided in the environment. Each operation reads
 * `WorkflowLoader.current` at invocation time, so a runtime config reload
 * (new endpoint / api_key / project / active_states) is picked up on the
 * next call without rebuilding the layer.
 *
 * The Layer requires both `HttpClient` and `WorkflowLoader` from its
 * environment. Production wiring composes this with `FetchHttpClient.layer`
 * from `@effect/platform`; tests provide a fake HttpClient via
 * `Layer.succeed(HttpClient.HttpClient, fakeClient)`.
 */
export const LinearClientLive: Layer.Layer<
  LinearClient,
  never,
  HttpClient.HttpClient | WorkflowLoader
> = Layer.effect(
  LinearClient,
  Effect.gen(function* () {
    const loader = yield* WorkflowLoader;
    const client = yield* HttpClient.HttpClient;

    /**
     * Resolve the per-call config snapshot. Returns the endpoint, api_key,
     * project slug, and active state list as they appear in the most recent
     * successful workflow load. `api_key` may be null if the operator hasn't
     * set it yet — we surface that as a `LinearRequestFail` rather than
     * crashing because the orchestrator-level preflight already rejects
     * dispatch in that case (see `validateForDispatch`).
     */
    const snapshot = (): Effect.Effect<
      {
        readonly endpoint: string;
        readonly apiKey: string;
        readonly projectSlug: string | null;
        readonly activeStates: ReadonlyArray<string>;
      },
      LinearClientError
    > =>
      Effect.gen(function* () {
        const wf = yield* loader.current;
        const tracker = wf.config.tracker;
        if (tracker.api_key === null || tracker.api_key.length === 0) {
          return yield* Effect.fail(
            new LinearRequestFail({
              endpoint: tracker.endpoint,
              message:
                "tracker.api_key is unset; LinearClient cannot issue requests",
            }),
          );
        }
        return {
          endpoint: tracker.endpoint,
          apiKey: tracker.api_key,
          projectSlug: tracker.project_slug,
          activeStates: tracker.active_states,
        };
      });

    const service: LinearClientService = {
      fetchCandidateIssues: Effect.flatMap(snapshot(), (s) =>
        make(
          s.endpoint,
          s.apiKey,
          client,
          s.projectSlug,
          s.activeStates,
        ).fetchCandidateIssues,
      ),
      fetchIssuesByStates: (stateNames) =>
        Effect.flatMap(snapshot(), (s) =>
          make(
            s.endpoint,
            s.apiKey,
            client,
            s.projectSlug,
            s.activeStates,
          ).fetchIssuesByStates(stateNames),
        ),
      fetchIssueStatesByIds: (issueIds) =>
        Effect.flatMap(snapshot(), (s) =>
          make(
            s.endpoint,
            s.apiKey,
            client,
            s.projectSlug,
            s.activeStates,
          ).fetchIssueStatesByIds(issueIds),
        ),
      executeRaw: (query, variables) =>
        Effect.flatMap(snapshot(), (s) =>
          make(
            s.endpoint,
            s.apiKey,
            client,
            s.projectSlug,
            s.activeStates,
          ).executeRaw(query, variables),
        ),
    };
    return service;
  }),
);
