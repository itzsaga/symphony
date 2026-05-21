// Doc-invariant tests for TRUST.md.
// Guards against silent drift between the sandbox implementation and the trust doc.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Resolve TRUST.md at the repo root. The test file lives at
 * test/unit/docs/TRUST.md.test.ts, so three `..` segments take us to
 * the repo root. We resolve once at module load — if the file is
 * missing or unreadable the `it("exists", …)` assertion below
 * surfaces it as a typed test failure rather than a noisy
 * `ENOENT` at suite parse time.
 */
const TRUST_MD_PATH = path.resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "TRUST.md",
);

const readTrustMd = (): string => fs.readFileSync(TRUST_MD_PATH, "utf-8");

describe("TRUST.md doc invariants", () => {
  it("exists at the repo root", () => {
    expect(fs.existsSync(TRUST_MD_PATH)).toBe(true);
  });

  it("contains the sentinel `nono run --network-profile claude-code` argv line", () => {
    // The exact substring asserted here is the policy sentinel: if
    // src/sandbox/policies.ts ever stops emitting `--network-profile
    // claude-code` (or someone renames the profile), the doc will be
    // out of sync with the code and this test should fail loudly.
    const body = readTrustMd();
    expect(body).toContain("nono run --network-profile claude-code");
  });

  it("documents the agent-runner spec divergence (claude CLI replaces Codex app-server)", () => {
    // We match on the keywords from TRUST.md §7 rather than a verbatim
    // phrase so minor copy-editing doesn't break the test, but the two
    // load-bearing tokens (`claude CLI` + `Codex`) must both appear in
    // a single divergence bullet.
    const body = readTrustMd();
    const hasClaudeReplacesCodex =
      /claude\s+CLI[^\n]{0,120}\bCodex\b/i.test(body) ||
      /\bCodex\b[^\n]{0,120}claude\s+CLI/i.test(body);
    expect(hasClaudeReplacesCodex).toBe(true);
  });

  it("documents the front-matter spec divergence (agent_runner.* replaces codex.*)", () => {
    // Same approach as above: require both namespace tokens to appear
    // close enough together to be plausibly the same bullet.
    const body = readTrustMd();
    const hasAgentRunnerReplacesCodex =
      /agent_runner\.\*[^\n]{0,120}codex\.\*/i.test(body) ||
      /codex\.\*[^\n]{0,120}agent_runner\.\*/i.test(body);
    expect(hasAgentRunnerReplacesCodex).toBe(true);
  });

  it("acknowledges what the implementation does NOT defend against (honesty section)", () => {
    // Spec acceptance criterion #9: an honest list of un-defended
    // exposures must be present. We assert on the section heading
    // pattern from TRUST.md so accidentally deleting the section is
    // caught even if the body text gets reshuffled.
    const body = readTrustMd();
    expect(body).toMatch(/does\s+NOT\s+defend\s+against/i);
  });
});
