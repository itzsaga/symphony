// Unit tests for src/http/Server.ts: CLI port parsing, port resolution,
// server bring-up vs no-op, listener teardown, and port-change warn behavior.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer, Scope } from "effect";
import {
  CliFlagsTest,
  ServerLive,
  parsePortFlag,
} from "../../../src/http/Server.ts";
import { layer as workflowLayer } from "../../../src/config/WorkflowLoader.ts";
import {
  type LogRecord,
  type LogSink,
  layer as loggerLayer,
} from "../../../src/observability/Logger.ts";

/* -------------------------------------------------------------------------- */
/* Test fixtures and helpers                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Render a minimal WORKFLOW.md body string. The `serverPort` argument
 * controls whether a `server.port` block is included; when `null`, the
 * server section is omitted entirely (matching the spec's "absent block =
 * HTTP server disabled" semantics).
 */
const workflowBody = (overrides?: {
  apiKey?: string;
  projectSlug?: string;
  serverPort?: number | null;
}): string => {
  const apiKey = overrides?.apiKey ?? "tok-abc";
  const projectSlug = overrides?.projectSlug ?? "my-project";
  const serverPort =
    overrides?.serverPort === undefined ? null : overrides.serverPort;
  const serverBlock =
    serverPort === null ? "" : `server:\n  port: ${serverPort}\n`;
  return `---
tracker:
  kind: linear
  api_key: ${apiKey}
  project_slug: ${projectSlug}
${serverBlock}---
prompt body
`;
};

/** Capture sink for assertion against emitted log records. */
const captureSink = (): {
  sink: LogSink;
  records: ReadonlyArray<LogRecord>;
} => {
  const records: Array<LogRecord> = [];
  return {
    sink: {
      write: (line) => {
        records.push(JSON.parse(line) as LogRecord);
      },
    },
    get records() {
      return records;
    },
  };
};

/** Sleep helper for debounce / reload settling. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Default reload wait: 100ms debounce + 250ms breathing room. */
const RELOAD_WAIT_MS = 500;

/* -------------------------------------------------------------------------- */
/* parsePortFlag — pure parsing                                                */
/* -------------------------------------------------------------------------- */

describe("parsePortFlag", () => {
  it("returns null when --port is absent", () => {
    expect(parsePortFlag([])).toBe(null);
    expect(parsePortFlag(["foo", "bar"])).toBe(null);
  });

  it("parses --port <N>", () => {
    expect(parsePortFlag(["--port", "8080"])).toBe(8080);
    expect(parsePortFlag(["other", "--port", "0", "more"])).toBe(0);
  });

  it("parses --port=<N>", () => {
    expect(parsePortFlag(["--port=8080"])).toBe(8080);
    expect(parsePortFlag(["a", "--port=12345"])).toBe(12345);
  });

  it("returns null for missing or malformed values", () => {
    expect(parsePortFlag(["--port"])).toBe(null);
    expect(parsePortFlag(["--port", ""])).toBe(null);
    expect(parsePortFlag(["--port", "not-a-number"])).toBe(null);
    expect(parsePortFlag(["--port", "-1"])).toBe(null);
    expect(parsePortFlag(["--port", "65536"])).toBe(null);
    expect(parsePortFlag(["--port=", ""])).toBe(null);
    expect(parsePortFlag(["--port=abc"])).toBe(null);
  });
});

/* -------------------------------------------------------------------------- */
/* ServerLive Layer behavior                                                  */
/* -------------------------------------------------------------------------- */

describe("ServerLive", () => {
  let tempDir: string;
  let workflowPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "symphony-http-test-"));
    workflowPath = join(tempDir, "WORKFLOW.md");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("no-ops when neither CLI --port nor server.port is set; logs disabled notice", async () => {
    writeFileSync(workflowPath, workflowBody({ serverPort: null }));
    const captured = captureSink();
    // Build the Layer in a scope so we can close it cleanly. The Layer
    // should succeed and the captured records should include the
    // "http server disabled" info line.
    const scope = await Effect.runPromise(Scope.make());
    try {
      await Effect.runPromise(
        Layer.buildWithScope(
          Layer.provideMerge(
            ServerLive,
            Layer.merge(
              CliFlagsTest(null),
              Layer.provideMerge(
                workflowLayer({ path: workflowPath }),
                loggerLayer({ sink: captured.sink }),
              ),
            ),
          ),
          scope,
        ),
      );
      expect(
        captured.records.some(
          (r) =>
            r.level === "info" &&
            typeof r["msg"] === "string" &&
            (r["msg"] as string).startsWith("http server disabled"),
        ),
      ).toBe(true);
      // And critically: no "http server listening" record.
      expect(
        captured.records.some((r) => r["msg"] === "http server listening"),
      ).toBe(false);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.succeed<void>(undefined)));
    }
  });

  it("CLI --port overrides server.port; logs bound listener", async () => {
    // Set server.port to 9090 in the workflow; pass CLI port 0 (so we
    // bind ephemeral). The "requested_port" field in the listening log
    // should match the CLI value (0), not 9090. That proves CLI won.
    writeFileSync(workflowPath, workflowBody({ serverPort: 9090 }));
    const captured = captureSink();
    const scope = await Effect.runPromise(Scope.make());
    try {
      await Effect.runPromise(
        Layer.buildWithScope(
          Layer.provideMerge(
            ServerLive,
            Layer.merge(
              CliFlagsTest(0),
              Layer.provideMerge(
                workflowLayer({ path: workflowPath }),
                loggerLayer({ sink: captured.sink }),
              ),
            ),
          ),
          scope,
        ),
      );
      const listeningRecord = captured.records.find(
        (r) => r["msg"] === "http server listening",
      );
      expect(listeningRecord).toBeDefined();
      expect(listeningRecord?.["requested_port"]).toBe(0);
      expect(listeningRecord?.["hostname"]).toBe("127.0.0.1");
      // Bound port should be a real ephemeral port (>0).
      expect(typeof listeningRecord?.["port"]).toBe("number");
      expect(listeningRecord?.["port"] as number).toBeGreaterThan(0);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.succeed<void>(undefined)));
    }
  });

  it("binds the ephemeral port when port=0 is set and logs the chosen port", async () => {
    writeFileSync(workflowPath, workflowBody({ serverPort: 0 }));
    const captured = captureSink();
    const scope = await Effect.runPromise(Scope.make());
    try {
      await Effect.runPromise(
        Layer.buildWithScope(
          Layer.provideMerge(
            ServerLive,
            Layer.merge(
              CliFlagsTest(null),
              Layer.provideMerge(
                workflowLayer({ path: workflowPath }),
                loggerLayer({ sink: captured.sink }),
              ),
            ),
          ),
          scope,
        ),
      );
      const listeningRecord = captured.records.find(
        (r) => r["msg"] === "http server listening",
      );
      expect(listeningRecord).toBeDefined();
      expect(listeningRecord?.["requested_port"]).toBe(0);
      expect(typeof listeningRecord?.["port"]).toBe("number");
      expect(listeningRecord?.["port"] as number).toBeGreaterThan(0);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.succeed<void>(undefined)));
    }
  });

  it("releases the listener when the Layer scope closes", async () => {
    // Start a server on an ephemeral port, capture the bound port from the
    // startup log, close the scope, then verify a fresh connection attempt
    // fails — proving the listener was released. We intentionally do NOT
    // make a probe request while the server is open: doing so would
    // establish a keep-alive TCP connection that prevents Bun's graceful
    // `server.stop()` (non-forceful, see platform-bun internals) from
    // completing, masking the teardown we're trying to assert.
    writeFileSync(workflowPath, workflowBody({ serverPort: 0 }));
    const captured = captureSink();
    const scope = await Effect.runPromise(Scope.make());
    let boundPort: number | null = null;
    try {
      await Effect.runPromise(
        Layer.buildWithScope(
          Layer.provideMerge(
            ServerLive,
            Layer.merge(
              CliFlagsTest(null),
              Layer.provideMerge(
                workflowLayer({ path: workflowPath }),
                loggerLayer({ sink: captured.sink }),
              ),
            ),
          ),
          scope,
        ),
      );
      const listeningRecord = captured.records.find(
        (r) => r["msg"] === "http server listening",
      );
      boundPort = (listeningRecord?.["port"] as number | undefined) ?? null;
      expect(boundPort).not.toBe(null);
      expect(boundPort).toBeGreaterThan(0);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.succeed<void>(undefined)));
    }
    // Poll briefly for the listener to drop. With no inflight connections
    // this is near-instant on macOS, but allow a generous budget.
    let post: Response | null = await fetch(
      `http://127.0.0.1:${boundPort}/`,
    ).catch(() => null);
    const deadline = Date.now() + 2_000;
    while (post !== null && Date.now() < deadline) {
      await sleep(50);
      post = await fetch(`http://127.0.0.1:${boundPort}/`).catch(() => null);
    }
    expect(post).toBe(null);
  });

  it("warns when workflow reload changes server.port without rebinding", async () => {
    writeFileSync(workflowPath, workflowBody({ serverPort: 0 }));
    const captured = captureSink();
    const scope = await Effect.runPromise(Scope.make());
    try {
      await Effect.runPromise(
        Layer.buildWithScope(
          Layer.provideMerge(
            ServerLive,
            Layer.merge(
              CliFlagsTest(null),
              Layer.provideMerge(
                workflowLayer({ path: workflowPath, debounceMs: 100 }),
                loggerLayer({ sink: captured.sink }),
              ),
            ),
          ),
          scope,
        ),
      );
      const listeningRecord = captured.records.find(
        (r) => r["msg"] === "http server listening",
      );
      const originalPort = listeningRecord?.["port"] as number | undefined;
      expect(typeof originalPort).toBe("number");

      // Rewrite the workflow with a different server.port and wait for
      // the loader to pick it up.
      writeFileSync(workflowPath, workflowBody({ serverPort: 9091 }));
      await sleep(RELOAD_WAIT_MS);

      // The warn record should now be in the buffer.
      const warn = captured.records.find(
        (r) =>
          r.level === "warn" &&
          r["msg"] === "server.port change ignored; restart required to apply",
      );
      expect(warn).toBeDefined();
      expect(warn?.["previous_port"]).toBe(0);
      expect(warn?.["new_port"]).toBe(9091);

      // The listener should still be on the original ephemeral port —
      // verify by opening a connection. We don't strictly need the
      // request to succeed, just that the listener is still up.
      expect(originalPort).toBeGreaterThan(0);
      const probe = await fetch(
        `http://127.0.0.1:${originalPort}/`,
      ).catch(() => null);
      expect(probe).not.toBe(null);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.succeed<void>(undefined)));
    }
  });
});
