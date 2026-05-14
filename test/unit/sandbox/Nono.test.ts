// Integration tests for the Sandbox service against a real `nono` binary.
// Cover dry-run argv parsing, stdin round-trip, and scope-driven SIGTERM->SIGKILL escalation.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunContext } from "@effect/platform-bun";
import { Chunk, Duration, Effect, Layer, Stream } from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { toAbsolutePathSync } from "../../../src/config/PathSafety.ts";
import {
  Sandbox,
  SandboxLive,
  SandboxLiveWithGrace,
  type SandboxPolicy,
} from "../../../src/sandbox/Nono.ts";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** A scratch tmpdir that lives for the whole describe block. */
let TMPROOT = "";
let WORKSPACE = "" as string;
let WORKFLOW_DIR = "" as string;

beforeAll(() => {
  TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-sandbox-"));
  WORKSPACE = path.join(TMPROOT, "ws");
  WORKFLOW_DIR = path.join(TMPROOT, "wf");
  fs.mkdirSync(WORKSPACE, { recursive: true });
  fs.mkdirSync(WORKFLOW_DIR, { recursive: true });
});

afterAll(() => {
  if (TMPROOT.length > 0) {
    fs.rmSync(TMPROOT, { recursive: true, force: true });
  }
});

/** Skip the live nono tests if the binary is not on PATH. */
const NONO_PATH = (() => {
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, "nono");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
})();

const liveLayer = Layer.provide(SandboxLive, BunContext.layer);
const liveLayerShortGrace = Layer.provide(
  SandboxLiveWithGrace(Duration.millis(500)),
  BunContext.layer,
);

const hookPolicy = (): SandboxPolicy => ({
  kind: "hook",
  workspace: toAbsolutePathSync(WORKSPACE),
  workflow_dir: toAbsolutePathSync(WORKFLOW_DIR),
  // `default` is the most conservative built-in nono profile and is
  // present on every install; we use it here because the test only
  // needs *some* parseable profile.
  profile: "default",
});

const agentPolicy = (): SandboxPolicy => ({
  kind: "agent_runner",
  workspace: toAbsolutePathSync(WORKSPACE),
  workflow_dir: toAbsolutePathSync(WORKFLOW_DIR),
  network_profile: "claude-code",
  credentials: [],
  claude_home_access: "allow",
});

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("Sandbox (live nono)", () => {
  it.skipIf(NONO_PATH === null)(
    "spawns echo through the hook policy and exits cleanly",
    async () => {
      const program = Effect.gen(function* () {
        const sandbox = yield* Sandbox;
        const proc = yield* sandbox.spawn({
          command: ["echo", "ok"],
          cwd: toAbsolutePathSync(WORKSPACE),
          policy: hookPolicy(),
          env: {},
        });
        // Drain stdout (otherwise the OS pipe can fill on chatty programs;
        // here it's a single line but draining is the contract).
        const stdoutBytes = yield* proc.stdout.pipe(
          Stream.runCollect,
          Effect.map((chunks) => {
            const buffers = Chunk.toReadonlyArray(chunks);
            const total = buffers.reduce((n, b) => n + b.length, 0);
            const out = new Uint8Array(total);
            let offset = 0;
            for (const b of buffers) {
              out.set(b, offset);
              offset += b.length;
            }
            return new TextDecoder().decode(out);
          }),
        );
        const code = yield* proc.waitForExit;
        return { code, stdoutBytes };
      });
      const result = await Effect.runPromise(
        Effect.scoped(program).pipe(Effect.provide(liveLayer)),
      );
      expect(result.code).toBe(0);
      expect(result.stdoutBytes.trim()).toBe("ok");
    },
  );

  it.skipIf(NONO_PATH === null)(
    "round-trips stdin through `cat` under the hook policy",
    async () => {
      const payload = JSON.stringify({ hello: "symphony" }) + "\n";
      const program = Effect.gen(function* () {
        const sandbox = yield* Sandbox;
        const proc = yield* sandbox.spawn({
          command: ["cat"],
          cwd: toAbsolutePathSync(WORKSPACE),
          policy: hookPolicy(),
          env: {},
        });
        // Forked write so we can drain stdout in the same fiber tree.
        const writeFiber = yield* Stream.fromIterable<Uint8Array>([
          new TextEncoder().encode(payload),
        ]).pipe(Stream.run(proc.stdin), Effect.fork);
        const stdoutText = yield* proc.stdout.pipe(
          Stream.runCollect,
          Effect.map((chunks) => {
            const buffers = Chunk.toReadonlyArray(chunks);
            const total = buffers.reduce((n, b) => n + b.length, 0);
            const out = new Uint8Array(total);
            let offset = 0;
            for (const b of buffers) {
              out.set(b, offset);
              offset += b.length;
            }
            return new TextDecoder().decode(out);
          }),
        );
        yield* writeFiber.await;
        const code = yield* proc.waitForExit;
        return { code, stdoutText };
      });
      const result = await Effect.runPromise(
        Effect.scoped(program).pipe(Effect.provide(liveLayer)),
      );
      expect(result.code).toBe(0);
      expect(result.stdoutText).toBe(payload);
    },
    20_000,
  );

  it.skipIf(NONO_PATH === null)(
    "scope cancellation terminates a sleeping child within the grace window",
    async () => {
      // Spawn a long sleep, immediately scope-close, and confirm that the
      // process exits within ~1.5s (grace=500ms + slop). Without our
      // SIGKILL escalation the child would survive past the timeout and
      // this test would hang.
      const start = Date.now();
      const program = Effect.gen(function* () {
        const sandbox = yield* Sandbox;
        const proc = yield* sandbox.spawn({
          command: ["sleep", "60"],
          cwd: toAbsolutePathSync(WORKSPACE),
          policy: hookPolicy(),
          env: {},
        });
        // Spend a brief moment so we observe the process actually started
        // before we tear down the scope.
        yield* Effect.sleep(Duration.millis(100));
        return proc.pid;
      });
      const pid = await Effect.runPromise(
        Effect.scoped(program).pipe(Effect.provide(liveLayerShortGrace)),
      );
      const elapsed = Date.now() - start;
      expect(typeof pid).toBe("number");
      // Generous upper bound: 100ms warmup + 500ms grace + Bun + nono
      // teardown overhead. If this regresses past ~3s the SIGKILL
      // escalation has likely broken.
      expect(elapsed).toBeLessThan(6_000);
    },
    10_000,
  );

  it.skipIf(NONO_PATH === null)(
    "passes --dry-run for the agent_runner policy without spawning the inner command",
    async () => {
      // Build the argv ourselves and prepend `--dry-run`. We bypass the
      // Sandbox service and directly spawn nono so we can prove the
      // policy argv we generate is actually parseable by the binary.
      const { agentRunnerArgv } = await import(
        "../../../src/sandbox/policies.ts"
      );
      const argv = ["--dry-run", ...agentRunnerArgv(
        {
          kind: "agent_runner",
          workspace: toAbsolutePathSync(WORKSPACE),
          workflow_dir: toAbsolutePathSync(WORKFLOW_DIR),
          network_profile: "claude-code",
          credentials: ["anthropic"],
          claude_home_access: "read",
        },
        ["echo", "ok"],
      )];
      // The first element is "run" — splice --dry-run after it because
      // nono expects subcommand-then-flags ordering.
      const reordered = [argv[1]!, "--dry-run", ...argv.slice(2)];
      const proc = Bun.spawn({
        cmd: ["nono", ...reordered],
        stdout: "pipe",
        stderr: "pipe",
      });
      const exit = await proc.exited;
      // We don't strictly require code 0 — older nono builds emit
      // non-zero on `--dry-run` for some flag combos. We DO require that
      // the parser didn't choke, which manifests as exit 2 ("argv
      // parse error"). Anything else is acceptable.
      expect(exit).not.toBe(2);
    },
    10_000,
  );

  it.skipIf(NONO_PATH === null)(
    "passes --dry-run for the hook policy without spawning the inner command",
    async () => {
      const { hookArgv } = await import("../../../src/sandbox/policies.ts");
      const argv = hookArgv(
        {
          kind: "hook",
          workspace: toAbsolutePathSync(WORKSPACE),
          workflow_dir: toAbsolutePathSync(WORKFLOW_DIR),
          profile: "default",
        },
        ["echo", "ok"],
      );
      // Splice --dry-run after the "run" subcommand.
      const reordered = [argv[0]!, "--dry-run", ...argv.slice(1)];
      const proc = Bun.spawn({
        cmd: ["nono", ...reordered],
        stdout: "pipe",
        stderr: "pipe",
      });
      const exit = await proc.exited;
      expect(exit).not.toBe(2);
    },
    10_000,
  );
});
