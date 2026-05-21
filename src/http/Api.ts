// Route handlers for the §13.7 HTTP API extension + dashboard.
// Defines GET /, GET /api/v1/state, GET /api/v1/:identifier, POST /api/v1/refresh.
import { Effect, Layer, Ref } from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { Logger } from "../observability/Logger.ts";
import { Orchestrator } from "../orchestrator/Orchestrator.ts";
import { ImmediateTickRequested } from "../orchestrator/events.ts";
import type { LogRecord } from "../observability/Logger.ts";
import { renderDashboard } from "./Dashboard.ts";
import { SymphonyHttpRouter } from "./Server.ts";
import {
  findByIdentifier,
  toApiIssue,
  toApiState,
  type ApiRecentEvent,
} from "./snapshot.ts";

/* -------------------------------------------------------------------------- */
/* JSON error envelope per §13.7 ("API errors SHOULD use a JSON envelope").    */
/* -------------------------------------------------------------------------- */

/** Shape of an API error envelope. */
interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

const errorBody = (code: string, message: string): ApiErrorBody => ({
  error: { code, message },
});

const jsonError = (
  status: number,
  code: string,
  message: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  HttpServerResponse.json(errorBody(code, message)).pipe(
    Effect.map((r) => HttpServerResponse.setStatus(r, status)),
    Effect.map((r) => HttpServerResponse.setHeaders(r, extraHeaders)),
    // `HttpServerResponse.json` can fail with HttpBodyError if the body is
    // unserializable; since we control the input here, it cannot, so we
    // collapse the error channel with `Effect.orDie`.
    Effect.orDie,
  );

/** Convenience: render an arbitrary JSON value with the given status. */
const jsonOk = (
  status: number,
  body: unknown,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  HttpServerResponse.json(body).pipe(
    Effect.map((r) => HttpServerResponse.setStatus(r, status)),
    Effect.orDie,
  );

/** Convenience: render an HTML body at the given status with Content-Type. */
const htmlOk = (
  status: number,
  body: string,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.setStatus(HttpServerResponse.html(body), status);

/* -------------------------------------------------------------------------- */
/* 405 Method Not Allowed responses.                                          */
/*                                                                            */
/* `@effect/platform`'s HttpRouter dispatches strictly by method; a non-       */
/* matching method falls through to a 404. To return a proper 405 with the    */
/* `Allow` header, every defined route is registered with `router.all` and    */
/* the handler inspects `request.method` itself. This keeps the spec-required */
/* 405 behavior local to each handler instead of leaking into the router.    */
/* -------------------------------------------------------------------------- */

const methodNotAllowed = (
  allow: ReadonlyArray<string>,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  jsonError(405, "method_not_allowed", "Method Not Allowed", {
    Allow: allow.join(", "),
  });

/* -------------------------------------------------------------------------- */
/* Identifier parsing.                                                         */
/*                                                                            */
/* Path is registered as `/api/v1/:identifier`. Symphony reserves the         */
/* literal segment `/api/v1/state` for the state endpoint, but the catch-all */
/* route registration would also match `state` — handlers check for the      */
/* literal `state` and short-circuit to /api/v1/state behavior. /refresh     */
/* is handled by a separate route registration since it accepts POST and we  */
/* don't want a GET to /api/v1/refresh to be interpreted as an issue lookup. */
/* -------------------------------------------------------------------------- */

/**
 * Refresh coalescing state. Holds the timestamp of the last
 * ImmediateTickRequested enqueue; within {@link COALESCE_WINDOW_MS} ms of
 * that timestamp, repeat POSTs return `coalesced: true` and skip the
 * enqueue. Persisted across requests via {@link makeRefreshState}.
 */
interface RefreshState {
  readonly lastQueuedAt: Date | null;
}

/** §13.7.2: coalesce repeat refreshes within 1 second of the last queue. */
export const COALESCE_WINDOW_MS = 1_000;

/** Build the shared refresh-coalescing ref. Exported for tests. */
export const makeRefreshState = (
  initial: RefreshState = { lastQueuedAt: null },
): Effect.Effect<Ref.Ref<RefreshState>> => Ref.make(initial);

/* -------------------------------------------------------------------------- */
/* Recent-events filter.                                                       */
/* -------------------------------------------------------------------------- */

/** Max number of recent events returned per /api/v1/<identifier> response. */
export const RECENT_EVENTS_CAP = 50;

const recentEventsForIssue = (
  records: ReadonlyArray<LogRecord>,
  identifier: string,
  issueId: string,
): ReadonlyArray<ApiRecentEvent> => {
  const filtered: Array<ApiRecentEvent> = [];
  for (const record of records) {
    const matchesId =
      typeof record["issue_id"] === "string" && record["issue_id"] === issueId;
    const matchesIdentifier =
      typeof record["issue_identifier"] === "string" &&
      record["issue_identifier"] === identifier;
    if (!matchesId && !matchesIdentifier) continue;
    const at =
      typeof record["timestamp"] === "string" ? record["timestamp"] : "";
    const event =
      typeof record["last_event"] === "string"
        ? record["last_event"]
        : typeof record["msg"] === "string"
          ? record["msg"]
          : "";
    const message =
      typeof record["last_message"] === "string"
        ? record["last_message"]
        : null;
    filtered.push({ at, event, message });
  }
  // Cap at the most recent entries (the ring buffer is already chronological).
  if (filtered.length <= RECENT_EVENTS_CAP) return filtered;
  return filtered.slice(filtered.length - RECENT_EVENTS_CAP);
};

/* -------------------------------------------------------------------------- */
/* Handlers.                                                                  */
/*                                                                            */
/* The SymphonyHttpRouter is pinned to `<unknown, never>` so per-route        */
/* handlers cannot leave Logger/Orchestrator as a service dependency. We      */
/* close over the live service handles at Layer-build time (see RoutesLive    */
/* below) and the per-route Effects only depend on the runtime-provided      */
/* HttpServerRequest / RouteContext.                                          */
/* -------------------------------------------------------------------------- */

/**
 * Dependency bag captured at Layer-build time. Holds the live Orchestrator
 * and Logger handles plus the cross-request coalescing ref. Threaded into
 * each handler closure so the router-handler Effects don't surface external
 * service dependencies.
 */
interface HandlerDeps {
  readonly orch: Orchestrator["Type"];
  readonly log: Logger["Type"];
  readonly refreshRef: Ref.Ref<RefreshState>;
}

/**
 * `GET /` — server-rendered dashboard. Other methods return 405 with the
 * `Allow: GET` header per §13.7.
 */
const dashboardHandler = (deps: HandlerDeps) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== "GET") {
      return yield* methodNotAllowed(["GET"]);
    }
    const state = yield* deps.orch.state;
    const records = yield* deps.log.recentEvents;
    const apiState = toApiState(state, new Date());
    return htmlOk(
      200,
      renderDashboard({ state: apiState, recent_events: records }),
    );
  });

/**
 * `GET /api/v1/state` — full §13.7.1 state shape. Method-not-GET returns
 * 405.
 */
const stateHandler = (deps: HandlerDeps) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== "GET") {
      return yield* methodNotAllowed(["GET"]);
    }
    const state = yield* deps.orch.state;
    return yield* jsonOk(200, toApiState(state, new Date()));
  });

/**
 * `GET /api/v1/<identifier>` — per-issue §13.7.2 shape. 404s with the
 * `issue_not_found` envelope when the identifier isn't in either in-memory
 * map.
 */
const issueHandler = (deps: HandlerDeps, identifier: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== "GET") {
      return yield* methodNotAllowed(["GET"]);
    }
    if (identifier === "") {
      return yield* jsonError(
        404,
        "issue_not_found",
        "Issue identifier not provided",
      );
    }
    const state = yield* deps.orch.state;
    const found = findByIdentifier(state, identifier);
    if (found.running === null && found.retry === null) {
      return yield* jsonError(
        404,
        "issue_not_found",
        `No running or retrying issue matches '${identifier}'`,
      );
    }
    const issueId =
      found.running?.issue.id ?? found.retry?.issue_id ?? identifier;
    const records = yield* deps.log.recentEvents;
    const recent = recentEventsForIssue(records, identifier, issueId);
    return yield* jsonOk(
      200,
      toApiIssue({
        issue_identifier: identifier,
        running: found.running,
        retry: found.retry,
        recent_events: recent,
      }),
    );
  });

/**
 * `POST /api/v1/refresh` — enqueue an ImmediateTickRequested. Coalesces
 * repeated POSTs within {@link COALESCE_WINDOW_MS} of the most-recent
 * enqueue; the coalesced response carries `coalesced: true` and the
 * `requested_at` timestamp of the current call.
 */
const refreshHandler = (deps: HandlerDeps) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== "POST") {
      return yield* methodNotAllowed(["POST"]);
    }
    const now = new Date();
    const prev = yield* Ref.get(deps.refreshRef);
    const coalesced =
      prev.lastQueuedAt !== null &&
      now.getTime() - prev.lastQueuedAt.getTime() < COALESCE_WINDOW_MS;
    if (!coalesced) {
      yield* deps.orch.enqueue(new ImmediateTickRequested({ at: now }));
      yield* Ref.set(deps.refreshRef, { lastQueuedAt: now });
    }
    return yield* jsonOk(202, {
      queued: !coalesced,
      coalesced,
      requested_at: now.toISOString(),
      operations: ["poll", "reconcile"],
    });
  });

/**
 * Catch-all handler for `/api/v1/:identifier` that special-cases the
 * literal `state` and `refresh` segments so we don't accidentally treat
 * them as issue identifiers. `refresh` for non-POST methods returns 405
 * (instead of falling into `issueHandler`'s GET-only path).
 */
const issueRouteHandler = (deps: HandlerDeps) =>
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const identifier = params["identifier"] ?? "";
    if (identifier === "state") {
      return yield* stateHandler(deps);
    }
    if (identifier === "refresh") {
      return yield* refreshHandler(deps);
    }
    return yield* issueHandler(deps, identifier);
  });

/* -------------------------------------------------------------------------- */
/* Route registration Layer.                                                  */
/*                                                                            */
/* The Layer contributes the four routes to the SymphonyHttpRouter at         */
/* construction time via the router's `.use` helper. Composed alongside       */
/* `ServerLive` in `application-wiring.md` via `Layer.mergeAll` so the two    */
/* share the same router instance through the outer memoMap.                  */
/* -------------------------------------------------------------------------- */

/**
 * Layer that contributes the four §13.7 routes to the SymphonyHttpRouter.
 * The Orchestrator + Logger handles are captured at Layer-build time and
 * shared across requests via the closure. The coalescing ref is
 * constructed once per Layer instance.
 *
 * Composition note: this Layer MUST be peer-merged with `ServerLive` via
 * `Layer.merge` / `Layer.mergeAll` — NOT `Layer.provideMerge` — so the
 * outer memoMap shares the same `SymphonyHttpRouter.Live` instance with
 * the server's `serve` Layer. Under `provideMerge`, the route
 * registrations end up in a different in-memory router than the one the
 * server reads from, and every request 404s.
 */
export const RoutesLive: Layer.Layer<never, never, Orchestrator | Logger> =
  SymphonyHttpRouter.use((router) =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator;
      const log = yield* Logger;
      const refreshRef = yield* makeRefreshState();
      const deps: HandlerDeps = { orch, log, refreshRef };
      // Dashboard at /. `router.all` captures every HTTP method; the
      // handler itself returns 405 for anything except GET.
      yield* router.all("/", dashboardHandler(deps));
      // The /api/v1 surface. Registering a single `:identifier` catch-all
      // gives us full control over method dispatch (and 405) per path
      // without registering two routes for the same path (which
      // find-my-way forbids).
      yield* router.all("/api/v1/:identifier", issueRouteHandler(deps));
    }),
  );
