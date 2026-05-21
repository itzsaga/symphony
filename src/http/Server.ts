// HTTP server scaffolding for the §13.7 dashboard/API extension.
// Defines CliFlags, the pluggable SymphonyHttpRouter, and the conditional Bun HTTP server Layer.
import {
  Context,
  Effect,
  Layer,
  Stream,
} from "effect";
import {
  HttpApp,
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { BunHttpServer } from "@effect/platform-bun";
import { WorkflowLoader } from "../config/WorkflowLoader.ts";
import { Logger } from "../observability/Logger.ts";

/* -------------------------------------------------------------------------- */
/* CliFlags service                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Subset of the CLI flag surface relevant to HTTP server bring-up. The
 * `application-wiring.md` task will own end-to-end argv parsing and may
 * replace `CliFlagsLive` with a richer implementation that also surfaces
 * the workflow path, log-level, etc. For now this Layer provides exactly
 * what the HTTP scaffolding needs.
 */
export interface CliFlagsService {
  /**
   * Value passed via `--port <N>` (or `--port=<N>`) on the command line, or
   * `null` if the flag was not present. Spec §13.7 says CLI `--port` wins
   * over `server.port` in WORKFLOW.md, so this is the override channel.
   */
  readonly port: number | null;
}

/** The CliFlags service tag. */
export class CliFlags extends Context.Tag("symphony/http/CliFlags")<
  CliFlags,
  CliFlagsService
>() {}

/**
 * Parse `--port` from an arbitrary argv array. Exported for tests; the
 * default Live Layer reads `Bun.argv` directly.
 *
 * Accepts both `--port 8080` and `--port=8080`. Returns `null` if the flag
 * is absent, the value is missing, or the value is not a finite non-negative
 * integer — surfacing a "not set" rather than a parse error keeps the rest
 * of the daemon bringing up even when an operator typo's a port flag.
 */
export const parsePortFlag = (argv: ReadonlyArray<string>): number | null => {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--port") {
      const next = argv[i + 1];
      if (next === undefined) return null;
      return parsePortValue(next);
    }
    if (arg.startsWith("--port=")) {
      return parsePortValue(arg.slice("--port=".length));
    }
  }
  return null;
};

/** Parse a single port-value string, returning null on any malformed input. */
const parsePortValue = (raw: string): number | null => {
  if (raw.length === 0) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 65_535) {
    return null;
  }
  return n;
};

/**
 * Default CliFlags Layer: reads `Bun.argv` once at construction. The
 * `application-wiring.md` task can override this with a Layer that also
 * surfaces workflow path, log-level, etc.; tests provide their own Layer
 * (see `CliFlagsTest`) so they don't depend on the harness argv.
 */
export const CliFlagsLive: Layer.Layer<CliFlags> = Layer.sync(CliFlags, () => ({
  port: parsePortFlag(Bun.argv.slice(2)),
}));

/** Build a CliFlags Layer with an explicit port value. Convenience for tests. */
export const CliFlagsTest = (port: number | null): Layer.Layer<CliFlags> =>
  Layer.succeed(CliFlags, { port });

/* -------------------------------------------------------------------------- */
/* SymphonyHttpRouter — the pluggable surface for sibling tasks               */
/* -------------------------------------------------------------------------- */

/**
 * The Symphony HTTP router. Sibling tasks (notably http-api-and-dashboard.md)
 * register their routes through this service via `SymphonyHttpRouter.use`
 * so that route registration order is decoupled from server bring-up.
 *
 * Built on top of `@effect/platform`'s `HttpRouter.Tag`, which produces a
 * `TagClass` with `.Live`, `.use`, `.unwrap`, and `.serve` helpers. We pin
 * the type parameters to `<unknown, never>` here so contributors can return
 * errors as untyped responses without leaking their concrete error union
 * into this Tag's signature — the runtime catches them via Effect's
 * default Cause handling.
 */
export class SymphonyHttpRouter extends HttpRouter.Tag("symphony/http/Router")<
  SymphonyHttpRouter
>() {}

/* -------------------------------------------------------------------------- */
/* Request logging middleware                                                 */
/* -------------------------------------------------------------------------- */

/**
 * HTTP middleware that emits one JSONL info record per request via the
 * Symphony Logger, with `method`, `path`, `status`, and `duration_ms`.
 *
 * Built via `HttpMiddleware.make` so the type matches what
 * `HttpRouter.serve(middleware)` expects (which constrains middlewares to
 * return `App.Default<any, any>` without an extra `Logger` requirement
 * leaking into the type). We pull the `Logger` and `HttpServerRequest`
 * services out of the live fiber context via `Effect.withFiberRuntime`,
 * mirroring how `@effect/platform`'s built-in `HttpMiddleware.logger` does
 * it. The Logger must be present at runtime — `ServerLive` provides it.
 */
const requestLogger = HttpMiddleware.make(<E, R>(app: HttpApp.Default<E, R>): HttpApp.Default<E, R> =>
  Effect.withFiberRuntime<
    HttpServerResponse.HttpServerResponse,
    E,
    R | HttpServerRequest.HttpServerRequest
  >(
    (fiber) => {
      const log = Context.unsafeGet(fiber.currentContext, Logger);
      const request = Context.unsafeGet(
        fiber.currentContext,
        HttpServerRequest.HttpServerRequest,
      );
      const started = performance.now();
      return Effect.flatMap(Effect.exit(app), (result) => {
        const duration_ms = Math.round(performance.now() - started);
        // Strip query string from the path; the full URL stays in
        // `originalUrl` if a future structured access log wants it.
        const path = request.url.split("?", 1)[0] ?? request.url;
        const status =
          result._tag === "Success" ? result.value.status : 500;
        return Effect.zipRight(
          log.info({
            msg: "http request",
            method: request.method,
            path,
            status,
            duration_ms,
          }),
          result,
        );
      });
    },
  ),
);

/* -------------------------------------------------------------------------- */
/* Port-change watcher                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Subscribe to workflow reloads and emit a warn record whenever the
 * effective `server.port` changes. Per spec §13.7 we do NOT hot-rebind the
 * listener; the warn alerts the operator that a restart is required for the
 * change to take effect.
 */
const watchPortChanges = (
  initialPort: number | null,
): Effect.Effect<void, never, WorkflowLoader | Logger> =>
  Effect.gen(function* () {
    const loader = yield* WorkflowLoader;
    const log = yield* Logger;
    let last = initialPort;
    yield* loader.changes.pipe(
      Stream.runForEach((wf) =>
        Effect.gen(function* () {
          const next = wf.config.server?.port ?? null;
          if (next !== last) {
            yield* log.warn({
              msg: "server.port change ignored; restart required to apply",
              previous_port: last,
              new_port: next,
            });
            last = next;
          }
        }),
      ),
    );
  });

/* -------------------------------------------------------------------------- */
/* Server Layer                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the effective port per spec §13.7: CLI `--port` overrides
 * `server.port`. Returns `null` when neither source provides a value, in
 * which case the HTTP server stays disabled and the rest of the daemon
 * continues to bring up.
 */
const resolvePort = (
  cli: CliFlagsService,
  workflowPort: number | null,
): number | null => {
  if (cli.port !== null) return cli.port;
  return workflowPort;
};

/**
 * Idle-connection timeout in seconds for the Bun HTTP server. Spec §13.7
 * recommends a small value to bound slowloris-style hangs; 5s matches the
 * spec note. Bun.serve measures `idleTimeout` in seconds (not ms).
 */
const IDLE_TIMEOUT_SECONDS = 5;

/** Loopback bind address per §13.7 ("Implementations SHOULD bind loopback"). */
const LOOPBACK_HOSTNAME = "127.0.0.1";

/**
 * Live Layer for the Symphony HTTP server.
 *
 * Behavior:
 * - Resolves the effective port from `CliFlags` (override) then
 *   `WorkflowLoader.current.config.server.port` (fallback).
 * - If neither source sets a port, the Layer is a graceful no-op: it logs
 *   "http server disabled" at info level, registers a port-change watcher
 *   so a later workflow edit still produces a warn (so the operator learns
 *   they need `--port` or a restart), and provides the SymphonyHttpRouter
 *   tag so dependent layers still typecheck.
 * - Otherwise binds `127.0.0.1:<port>` via `BunHttpServer.layer`, attaches
 *   the request-logger middleware, mounts the router built by sibling
 *   tasks, and logs the actual bound address (which differs from the
 *   requested port when port=0 is used to request an ephemeral port).
 *
 * Listener teardown is automatic: `BunHttpServer.layer` is scoped, so when
 * the outer scope closes (Layer.launch interrupt, SIGTERM, test scope
 * close) the listener fd is released.
 */
export const ServerLive: Layer.Layer<
  SymphonyHttpRouter,
  never,
  CliFlags | WorkflowLoader | Logger
> = Layer.unwrapEffect(
  Effect.gen(function* () {
    const cli = yield* CliFlags;
    const loader = yield* WorkflowLoader;
    const workflow = yield* loader.current;
    const workflowPort = workflow.config.server?.port ?? null;
    const port = resolvePort(cli, workflowPort);

    if (port === null) {
      // No port configured anywhere — emit a disabled-info log and return
      // a Layer that satisfies the SymphonyHttpRouter requirement without
      // starting a listener. The router's .Live still runs so sibling
      // tasks that register routes won't fail their requires; the routes
      // simply never receive traffic.
      const disabledNotice: Layer.Layer<never, never, Logger> = Layer.effectDiscard(
        Effect.flatMap(Logger, (log) =>
          log.info({
            msg: "http server disabled (no --port or server.port set)",
          }),
        ),
      );
      const watcher: Layer.Layer<never, never, WorkflowLoader | Logger> =
        Layer.scopedDiscard(Effect.forkScoped(watchPortChanges(null)));
      return Layer.mergeAll(
        SymphonyHttpRouter.Live,
        disabledNotice,
        watcher,
      );
    }

    // Build the Bun listener Layer with our resolved options. We pin the
    // hostname to loopback per §13.7; `port: 0` asks the OS for an ephemeral
    // port and we log the bound port back to the operator from the running
    // server's address.
    const listener = BunHttpServer.layer({
      port,
      hostname: LOOPBACK_HOSTNAME,
      idleTimeout: IDLE_TIMEOUT_SECONDS,
    });

    // Compose the router's `.serve(middleware)` Layer with the request
    // logger and an info-level startup record that prints the actual bound
    // address (resolves the ephemeral port for port=0).
    const startupLog: Layer.Layer<never, never, HttpServer.HttpServer | Logger> =
      Layer.effectDiscard(
        Effect.flatMap(HttpServer.HttpServer, (server) =>
          Effect.flatMap(Logger, (log) => {
            const address = server.address;
            const boundPort =
              address._tag === "TcpAddress" ? address.port : null;
            return log.info({
              msg: "http server listening",
              hostname:
                address._tag === "TcpAddress" ? address.hostname : null,
              port: boundPort,
              requested_port: port,
            });
          }),
        ),
      );

    const watcher: Layer.Layer<never, never, WorkflowLoader | Logger> =
      Layer.scopedDiscard(Effect.forkScoped(watchPortChanges(workflowPort)));

    // SymphonyHttpRouter.serve(middleware) takes the HttpServer + Logger
    // (via the middleware) and produces a Layer.Layer<never, never,
    // HttpServer.HttpServer | Logger>. We bundle the listener, the startup
    // log, the watcher, and the router's own Live in one merged Layer so
    // the public type stays clean.
    // The middleware reads Logger from the live fiber context (provided
    // by the outer Layer composition), so the serve layer doesn't surface
    // a Logger requirement here. Logger is wired in via `Layer.provide`
    // at composition time alongside the listener.
    const served = SymphonyHttpRouter.serve(requestLogger);

    return Layer.mergeAll(
      SymphonyHttpRouter.Live,
      Layer.provideMerge(
        Layer.mergeAll(served, startupLog),
        listener,
      ),
      watcher,
    );
  }),
);
