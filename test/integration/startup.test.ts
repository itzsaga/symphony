// Integration tests for src/main.ts: CLI surface, startup terminal cleanup, HTTP bring-up, SIGTERM teardown.
// Spawns the daemon as a child Bun process so signal handling and exit codes exercise the real runtime.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* -------------------------------------------------------------------------- */
/* Resolved paths                                                             */
/* -------------------------------------------------------------------------- */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const MAIN_PATH = join(REPO_ROOT, "src", "main.ts");

/* -------------------------------------------------------------------------- */
/* Fixture                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Render a minimal WORKFLOW.md body with optional overrides. We point
 * `tracker.api_key` at an unset env var so the workflow loads successfully
 * (dispatch preflight is allowed to fail at runtime — the orchestrator
 * tolerates a missing key and only fails ticks).
 *
 * `polling.interval_ms` is set high so the orchestrator's tick loop sleeps
 * past the test's lifetime, leaving the SIGTERM path the only way out.
 */
const workflowBody = (overrides?: {
  readonly serverPort?: number;
  readonly workspaceRoot?: string;
}): string => {
  const serverBlock =
    overrides?.serverPort === undefined
      ? ""
      : `server:\n  port: ${overrides.serverPort}\n`;
  const workspaceBlock =
    overrides?.workspaceRoot === undefined
      ? ""
      : `workspace:\n  root: ${overrides.workspaceRoot}\n`;
  return `---
tracker:
  kind: linear
  api_key: tok-fake
  project_slug: symphony-test
polling:
  interval_ms: 86400000
${workspaceBlock}${serverBlock}---
test prompt
`;
};

/* -------------------------------------------------------------------------- */
/* Test temp directory                                                        */
/* -------------------------------------------------------------------------- */

let tmpDir = "";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "symphony-startup-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Child-process helpers                                                       */
/* -------------------------------------------------------------------------- */

interface SpawnResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Spawn the daemon as a child process and wait for it to exit on its own
 * (no signal). Used for the "fails clearly on missing workflow" assertions
 * — those exit immediately.
 */
const spawnAndWait = async (
  args: ReadonlyArray<string>,
  cwd: string,
): Promise<SpawnResult> => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", MAIN_PATH, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const exitCode = await proc.exited;
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

/**
 * Spawn the daemon, wait for it to emit a marker log line on stderr (or
 * time out), then return a handle that allows the caller to send a signal
 * and inspect the final exit state. The marker is matched as a substring.
 */
interface RunningChild {
  readonly proc: ReturnType<typeof Bun.spawn>;
  /** Stderr accumulated so far. Updated as data arrives. */
  readonly stderr: () => string;
  /** Stdout accumulated so far. */
  readonly stdout: () => string;
  /** Send a signal and wait for the process to exit. */
  readonly stopWith: (signal: NodeJS.Signals) => Promise<number>;
}

/**
 * Start the daemon and return a handle once the named substring appears on
 * stderr. Rejects if the substring does not appear within `timeoutMs`.
 */
const startUntil = async (
  args: ReadonlyArray<string>,
  cwd: string,
  marker: string,
  timeoutMs = 10_000,
): Promise<RunningChild> => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", MAIN_PATH, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  let stderrBuf = "";
  let stdoutBuf = "";
  let exitCodeRef: number | null = null;

  // Async drain of stderr; resolves the marker promise on first match.
  let markerResolved = false;
  const markerHit = new Promise<void>((resolveMarker, rejectMarker) => {
    const timer = setTimeout(() => {
      if (!markerResolved) {
        rejectMarker(
          new Error(
            `marker '${marker}' not seen within ${timeoutMs}ms; stderr so far:\n${stderrBuf}`,
          ),
        );
      }
    }, timeoutMs);

    const drainStderr = async (): Promise<void> => {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        stderrBuf += decoder.decode(value, { stream: true });
        if (!markerResolved && stderrBuf.includes(marker)) {
          markerResolved = true;
          clearTimeout(timer);
          resolveMarker();
        }
      }
    };
    const drainStdout = async (): Promise<void> => {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        stdoutBuf += decoder.decode(value, { stream: true });
      }
    };
    // Fire and forget — drain handlers run for the process lifetime.
    void drainStderr();
    void drainStdout();
  });

  await markerHit;

  const stopWith = async (signal: NodeJS.Signals): Promise<number> => {
    proc.kill(signal);
    exitCodeRef = await proc.exited;
    return exitCodeRef;
  };

  return {
    proc,
    stderr: () => stderrBuf,
    stdout: () => stdoutBuf,
    stopWith,
  };
};

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("symphony main.ts", () => {
  it("exits non-zero with an operator-visible error for a nonexistent explicit workflow path", async () => {
    const missing = join(tmpDir, "does-not-exist.md");
    const result = await spawnAndWait([missing], tmpDir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("workflow file not found");
    expect(result.stderr).toContain(missing);
  });

  it("exits non-zero when no argument is supplied and ./WORKFLOW.md is missing in cwd", async () => {
    // tmpDir intentionally has no WORKFLOW.md
    const result = await spawnAndWait([], tmpDir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "no workflow path supplied and default ./WORKFLOW.md not found",
    );
  });

  it("exits non-zero with usage text on unknown flag", async () => {
    const result = await spawnAndWait(["--bogus"], tmpDir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("unknown argument: --bogus");
    expect(result.stderr).toContain("usage:");
  });

  it("exits non-zero on malformed --port value", async () => {
    const result = await spawnAndWait(
      ["--port", "abc", "missing.md"],
      tmpDir,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--port: invalid port value");
  });

  it("starts cleanly and exits 0 on SIGTERM with no HTTP port", async () => {
    const wfPath = join(tmpDir, "no-http.WORKFLOW.md");
    const wsRoot = join(tmpDir, "ws-no-http");
    writeFileSync(wfPath, workflowBody({ workspaceRoot: wsRoot }));

    const child = await startUntil(
      [wfPath],
      tmpDir,
      "symphony ready",
    );
    const exitCode = await child.stopWith("SIGTERM");
    expect(exitCode).toBe(0);
    // Confirm startup cleanup ran (best-effort — the fake API key makes the
    // Linear fetch fail, so the warn path is taken; either path is OK).
    const stderr = child.stderr();
    const sweptOrSkipped =
      stderr.includes("startup terminal cleanup: sweeping workspaces") ||
      stderr.includes("startup terminal cleanup: fetch failed");
    expect(sweptOrSkipped).toBe(true);
  }, 20_000);

  it("--port 0 binds an ephemeral HTTP port and serves /api/v1/state", async () => {
    const wfPath = join(tmpDir, "http.WORKFLOW.md");
    const wsRoot = join(tmpDir, "ws-http");
    writeFileSync(wfPath, workflowBody({ workspaceRoot: wsRoot }));

    const child = await startUntil(
      ["--port", "0", wfPath],
      tmpDir,
      "http server listening",
    );

    try {
      // Pull the bound port out of the listening log record.
      const stderr = child.stderr();
      const listeningLine = stderr
        .split("\n")
        .find((l) => l.includes('"msg":"http server listening"'));
      expect(listeningLine).toBeDefined();
      const parsed = JSON.parse(listeningLine ?? "{}") as {
        readonly port: number;
        readonly hostname: string;
      };
      expect(parsed.hostname).toBe("127.0.0.1");
      expect(parsed.port).toBeGreaterThan(0);

      // Hit /api/v1/state and verify a 200 with a state envelope.
      const resp = await fetch(`http://127.0.0.1:${parsed.port}/api/v1/state`);
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as Record<string, unknown>;
      // Spec §13.7.1 shape: top-level should have running and retry_attempts.
      expect(typeof body).toBe("object");
      expect("running" in body || "retrying" in body).toBe(true);
    } finally {
      const exitCode = await child.stopWith("SIGTERM");
      expect(exitCode).toBe(0);
    }
  }, 30_000);

  it("SIGINT also produces a clean exit", async () => {
    const wfPath = join(tmpDir, "sigint.WORKFLOW.md");
    const wsRoot = join(tmpDir, "ws-sigint");
    writeFileSync(wfPath, workflowBody({ workspaceRoot: wsRoot }));

    const child = await startUntil([wfPath], tmpDir, "symphony ready");
    const exitCode = await child.stopWith("SIGINT");
    expect(exitCode).toBe(0);
  }, 20_000);
});
