// Symphony v1 daemon entrypoint: parses argv, composes every Live Layer,
// runs §8.6 startup cleanup, and blocks on a Deferred shutdown signal until SIGINT/SIGTERM.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Deferred, Effect, Exit, Layer } from "effect";
import { FetchHttpClient } from "@effect/platform";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { parseCli, USAGE } from "./cli.ts";
import { layer as workflowLoaderLayer } from "./config/WorkflowLoader.ts";
import { LinearClient, LinearClientLive } from "./linear/LinearClient.ts";
import { Logger, LoggerLive } from "./observability/Logger.ts";
import { WorkflowLoader } from "./config/WorkflowLoader.ts";
import { WorkspaceManager, WorkspaceManagerLive } from "./workspace/WorkspaceManager.ts";
import { WorkspaceHooksLive } from "./workspace/Hooks.ts";
import { SandboxLive } from "./sandbox/Nono.ts";
import { McpServerLive } from "./claude/McpServer.ts";
import { OrchestratorLive } from "./orchestrator/Orchestrator.ts";
import {
  CliFlags,
  ServerLive,
} from "./http/Server.ts";
import { RoutesLive } from "./http/Api.ts";

const PROGRAM = "symphony";
const DEFAULT_WORKFLOW_FILENAME = "WORKFLOW.md";

/* -------------------------------------------------------------------------- */
/* Operator-visible error helpers                                             */
/* -------------------------------------------------------------------------- */

/**
 * Write one operator-visible line to stderr. Used before the Logger Layer
 * has been built (CLI parse errors, missing workflow file) so we can't go
 * through `Logger.error` yet. Trailing newline is included.
 */
const stderr = (message: string): void => {
  process.stderr.write(`${PROGRAM}: ${message}\n`);
};

/* -------------------------------------------------------------------------- */
/* Startup sequence (§16.1, §8.6)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Effect that runs the §8.6 startup terminal-workspace cleanup. Best-effort:
 * a fetch failure logs a warning and continues; per-issue cleanup failures
 * are already swallowed by `WorkspaceManager.startupTerminalCleanup`.
 */
const runStartupTerminalCleanup: Effect.Effect<
  void,
  never,
  Logger | LinearClient | WorkspaceManager | WorkflowLoader
> = Effect.gen(function* () {
  const loader = yield* WorkflowLoader;
  const linear = yield* LinearClient;
  const workspace = yield* WorkspaceManager;
  const log = yield* Logger;

  const workflow = yield* loader.current;
  const terminalStates = workflow.config.tracker.terminal_states;

  const fetched = yield* Effect.either(
    linear.fetchIssuesByStates(terminalStates),
  );
  if (fetched._tag === "Left") {
    yield* log.warn({
      msg: "startup terminal cleanup: fetch failed; skipping sweep",
      error_tag: fetched.left._tag,
    });
    return;
  }
  const identifiers = fetched.right.map((issue) => issue.identifier);
  yield* log.info({
    msg: "startup terminal cleanup: sweeping workspaces",
    count: identifiers.length,
  });
  yield* workspace.startupTerminalCleanup(identifiers);
});

/* -------------------------------------------------------------------------- */
/* Layer composition                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Build the full Symphony Live Layer. Composition follows the PRD's service
 * graph: lowest-level platform services first (Logger, BunContext for
 * Clock/FileSystem/CommandExecutor, FetchHttpClient), then WorkflowLoader,
 * then everything that reads the workflow, then Orchestrator + HTTP.
 *
 * Note: `ServerLive` and `RoutesLive` are peer-merged via `Layer.mergeAll`
 * (NOT `Layer.provideMerge`) so they share the same `SymphonyHttpRouter.Live`
 * instance through the outer memoMap. Under `provideMerge` the routes would
 * register against a different in-memory router than the one the server
 * reads from, and every request would 404.
 */
const buildAppLayer = (params: {
  readonly workflowPath: string;
  readonly cliPort: number | null;
}) => {
  // Bottom-of-stack platform services. CliFlags is treated as a platform-
  // layer concern (no upstream dependencies) so every consumer that wants
  // a port override (currently just ServerLive) can pull from the same
  // single shared Layer.
  const cliFlags = Layer.succeed(CliFlags, { port: params.cliPort });
  const platform = Layer.mergeAll(
    LoggerLive,
    BunContext.layer,
    FetchHttpClient.layer,
    cliFlags,
  );

  // Workflow layer requires Logger from platform.
  const workflow = Layer.provide(
    workflowLoaderLayer({ path: params.workflowPath }),
    platform,
  );
  // Linear needs HttpClient + WorkflowLoader; we expose Logger / platform
  // services upstream via mergeAll so subsequent layers can keep depending
  // on them without re-providing.
  const platformPlusWorkflow = Layer.merge(platform, workflow);

  const linear = Layer.provide(LinearClientLive, platformPlusWorkflow);
  const workspaceManager = Layer.provide(
    WorkspaceManagerLive,
    platformPlusWorkflow,
  );
  const sandbox = Layer.provide(SandboxLive, platformPlusWorkflow);
  // WorkspaceHooks needs WorkflowLoader + Sandbox + Logger.
  const sandboxAndPlatform = Layer.merge(platformPlusWorkflow, sandbox);
  const workspaceHooks = Layer.provide(WorkspaceHooksLive, sandboxAndPlatform);
  // McpServer needs LinearClient + Logger + WorkflowLoader.
  const mcpServer = Layer.provide(
    McpServerLive,
    Layer.merge(platformPlusWorkflow, linear),
  );

  // Orchestrator needs Workflow, Linear, Logger, Sandbox, McpServer,
  // WorkspaceHooks, WorkspaceManager. Provide each from the lower stack.
  const orchestratorDeps = Layer.mergeAll(
    platformPlusWorkflow,
    linear,
    workspaceManager,
    workspaceHooks,
    sandbox,
    mcpServer,
  );
  const orchestrator = Layer.provide(OrchestratorLive, orchestratorDeps);

  // HTTP: ServerLive + RoutesLive must be peer-merged via Layer.mergeAll
  // (NOT Layer.provideMerge) so they share the same SymphonyHttpRouter.Live
  // instance through the outer memoMap. Under provideMerge the routes
  // would end up in a different in-memory router than the one the server
  // reads from, and every request would 404.
  const httpDeps = Layer.mergeAll(orchestratorDeps, orchestrator);
  const http = Layer.provide(
    Layer.mergeAll(ServerLive, RoutesLive),
    httpDeps,
  );

  // Final composite: the program needs Logger, LinearClient,
  // WorkspaceManager, WorkflowLoader. Merging the leaf layers ensures the
  // HTTP listener and the orchestrator scope are both bound to the main
  // fiber's scope, so SIGINT/SIGTERM tear them both down.
  return Layer.mergeAll(
    platformPlusWorkflow,
    linear,
    workspaceManager,
    workspaceHooks,
    sandbox,
    mcpServer,
    orchestrator,
    http,
  );
};

/* -------------------------------------------------------------------------- */
/* Workflow-path resolution                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Compute the effective workflow path from the parsed CLI surface and verify
 * that the file exists. Returns the resolved absolute path on success; on
 * failure writes an operator-visible error line to stderr and returns `null`
 * so the caller can `process.exit(1)` without raising a thrown error.
 */
const resolveWorkflowPath = (
  parsedPath: string | null,
): string | null => {
  const explicit = parsedPath !== null;
  const rawPath = parsedPath ?? DEFAULT_WORKFLOW_FILENAME;
  const absolute = resolve(process.cwd(), rawPath);
  if (!existsSync(absolute)) {
    if (explicit) {
      stderr(`workflow file not found: ${absolute}`);
    } else {
      stderr(
        `no workflow path supplied and default ./${DEFAULT_WORKFLOW_FILENAME} not found at ${absolute}`,
      );
    }
    return null;
  }
  return absolute;
};

/* -------------------------------------------------------------------------- */
/* Main program                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The main Effect: runs startup cleanup, then blocks on a Deferred that is
 * never resolved by the program itself. `BunRuntime.runMain` converts
 * SIGINT/SIGTERM into a fiber interrupt, which closes the surrounding scope
 * and tears down every Layer-owned resource (HTTP listener, workflow
 * watcher, orchestrator fibers, retry timers, running workers).
 *
 * The Deferred-based block is the explicit form recommended by the PRD
 * §Architecture "Runtime shape" note. We hold the Deferred in the program
 * (rather than relying solely on `Layer.launch`) so future code paths (e.g.
 * an admin endpoint that requests a graceful stop) can resolve it without
 * touching process signals.
 */
const program: Effect.Effect<
  void,
  never,
  Logger | LinearClient | WorkspaceManager | WorkflowLoader
> = Effect.gen(function* () {
  const log = yield* Logger;
  yield* log.info({ msg: "symphony starting" });

  yield* runStartupTerminalCleanup;

  yield* log.info({ msg: "symphony ready" });

  // Block forever; signal handling in BunRuntime.runMain interrupts this
  // fiber, which closes the surrounding scope and triggers Layer teardown.
  const shutdownSignal = yield* Deferred.make<void>();
  yield* Deferred.await(shutdownSignal);
});

/**
 * Run the full daemon against the resolved workflow path. The Effect's
 * environment is satisfied by `buildAppLayer`, which wires every Live
 * Layer. We use `BunRuntime.runMain` so SIGINT/SIGTERM become a fiber
 * interrupt (default Effect runtime behavior); the runtime sets the
 * process exit code appropriately (0 on interrupted clean shutdown, 1 on
 * defect, etc.).
 */
const runDaemon = (workflowPath: string, cliPort: number | null): void => {
  const layer = buildAppLayer({ workflowPath, cliPort });
  // `Layer.launch` would block forever on its own; we instead provide the
  // layer and let the program's Deferred block, so the launched scope
  // covers both the platform services AND the daemon fiber. Either
  // approach is valid; we pick `Effect.provide` so the program Effect
  // remains a normal `Effect<void>` for testability.
  const main = program.pipe(
    Effect.provide(layer),
    // The workflow loader can fail to build (missing file / parse / preflight)
    // and the FetchHttpClient layer requires no environment. We surface any
    // Layer-build failure as a stderr line and exit non-zero via the
    // runMain teardown's defect handling.
    Effect.tapErrorCause((cause) =>
      Effect.sync(() => {
        stderr(`startup failure: ${String(cause)}`);
      }),
    ),
  );

  BunRuntime.runMain(main, {
    // Default teardown: 0 on Success/Interrupt, 1 on Failure/Die.
    teardown: (exit, onExit) => {
      if (Exit.isSuccess(exit)) {
        onExit(0);
        return;
      }
      // Interrupt-only failures are the normal SIGINT/SIGTERM path — treat
      // as a clean shutdown per §17.7 acceptance criteria.
      if (Exit.isInterrupted(exit)) {
        onExit(0);
        return;
      }
      onExit(1);
    },
  });
};

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

const argv = process.argv.slice(2);
const parsed = parseCli(argv);

if (parsed.errors.length > 0) {
  for (const e of parsed.errors) stderr(e);
  stderr(USAGE);
  process.exit(2);
}

const workflowPath = resolveWorkflowPath(parsed.workflowPath);
if (workflowPath === null) {
  process.exit(1);
}

runDaemon(workflowPath, parsed.port);
