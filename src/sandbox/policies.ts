// Pure argv builders for the two `nono run` policy variants Symphony uses.
// Tests assert exact argv shape; nothing here touches the filesystem or env.
import * as os from "node:os";
import * as path from "node:path";
import type { AbsolutePath } from "../config/PathSafety.ts";

/**
 * Hard-coded read-only filesystem grants applied to every `agent_runner`
 * sandbox. These are the system bins Claude (and its tool subprocesses) need
 * just to find the executables it shells out to. Hard-coding them in the
 * policy module keeps the agent_runner argv shape predictable across machines
 * and keeps the spec §15.4 trust surface auditable in one place.
 *
 * Order matches the spec verbatim so tests can assert exact argv.
 */
export const AGENT_RUNNER_BASE_READS: ReadonlyArray<string> = [
  "/usr/bin",
  "/bin",
  "/usr/local/bin",
  "/opt/homebrew",
];

/**
 * Discriminated union of policy variants accepted by `Sandbox.spawn`. The two
 * shapes mirror the two callers Symphony has today:
 *
 * - `agent_runner`: wraps each `claude` invocation with the
 *   `--network-profile` + credential-injection + `--allow workspace` /
 *   `--read workflow_dir` / `--read|--allow ~/.claude` set.
 * - `hook`: wraps each workflow hook script with a tighter
 *   `--profile <profile> --allow workspace --read workflow_dir` set. Hooks
 *   are repo-owned trusted code per spec §15.4 but we still want blast-radius
 *   limits.
 */
export type SandboxPolicy =
  | {
      readonly kind: "agent_runner";
      readonly workspace: AbsolutePath;
      readonly workflow_dir: AbsolutePath;
      readonly network_profile: string;
      readonly credentials: ReadonlyArray<string>;
      /**
       * `read`  → `--read ~/.claude` (token store is not mutated; auth comes
       *           from injected `ANTHROPIC_API_KEY` env). Use when
       *           `agent_runner.bare === true`. `credentials` SHOULD include
       *           `"anthropic"`.
       * `allow` → `--allow ~/.claude` so the CLI can refresh OAuth tokens on
       *           401 mid-session. Use when `agent_runner.bare === false`.
       *           `credentials` SHOULD be empty.
       */
      readonly claude_home_access: "read" | "allow";
    }
  | {
      readonly kind: "hook";
      readonly workspace: AbsolutePath;
      readonly workflow_dir: AbsolutePath;
      readonly profile: string;
    };

/**
 * Resolve the `~/.claude` path. Pulled out so tests can construct the
 * expected argv without re-implementing the homedir join inline.
 */
export const claudeHomePath = (): string =>
  path.join(os.homedir(), ".claude");

/**
 * Build the argv for the `agent_runner` policy variant.
 *
 * Output shape (verbatim — tests assert exact ordering):
 *
 *   [
 *     "run",
 *     "--network-profile", <network_profile>,
 *     "--credential", <c1>, "--credential", <c2>, ...,    // optional
 *     "--allow", <workspace>,
 *     "--read",  <workflow_dir>,
 *     "--read"|"--allow", <~/.claude>,
 *     "--read", "/usr/bin",
 *     "--read", "/bin",
 *     "--read", "/usr/local/bin",
 *     "--read", "/opt/homebrew",
 *     "--",
 *     ...command,
 *   ]
 *
 * Note: this returns the argv to pass to `nono` (i.e. WITHOUT the leading
 * `"nono"` program name). The caller composes that separately so the same
 * function is reusable when invoking nono via an executor that takes
 * (command, ...args) like `@effect/platform`'s `Command.make`.
 */
export const agentRunnerArgv = (
  policy: Extract<SandboxPolicy, { kind: "agent_runner" }>,
  command: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const argv: Array<string> = ["run", "--network-profile", policy.network_profile];
  for (const credential of policy.credentials) {
    argv.push("--credential", credential);
  }
  argv.push("--allow", policy.workspace);
  argv.push("--read", policy.workflow_dir);
  const claudeHomeFlag =
    policy.claude_home_access === "allow" ? "--allow" : "--read";
  argv.push(claudeHomeFlag, claudeHomePath());
  for (const baseRead of AGENT_RUNNER_BASE_READS) {
    argv.push("--read", baseRead);
  }
  argv.push("--", ...command);
  return argv;
};

/**
 * Build the argv for the `hook` policy variant.
 *
 * Output shape (verbatim):
 *
 *   [
 *     "run",
 *     "--profile", <profile>,
 *     "--allow",   <workspace>,
 *     "--read",    <workflow_dir>,
 *     "--",
 *     ...command,
 *   ]
 *
 * As with `agentRunnerArgv` the leading `"nono"` program name is the
 * caller's responsibility.
 */
export const hookArgv = (
  policy: Extract<SandboxPolicy, { kind: "hook" }>,
  command: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  "run",
  "--profile",
  policy.profile,
  "--allow",
  policy.workspace,
  "--read",
  policy.workflow_dir,
  "--",
  ...command,
];

/**
 * Dispatch helper: turn any `SandboxPolicy` into the corresponding `nono`
 * argv. Keeps the `Sandbox` Layer from open-coding the discriminator.
 */
export const policyArgv = (
  policy: SandboxPolicy,
  command: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  switch (policy.kind) {
    case "agent_runner":
      return agentRunnerArgv(policy, command);
    case "hook":
      return hookArgv(policy, command);
  }
};
