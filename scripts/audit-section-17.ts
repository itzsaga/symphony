// Audit script for the §17 conformance gate.
// Parses test/section-17-coverage.md and verifies each referenced test exists.
//
// Exit codes:
//   0 — every required bullet has a present test reference
//   1 — at least one bullet is missing or its referenced test is not found
//
// Usage:
//   bun run scripts/audit-section-17.ts
//
// Expected coverage doc format (per-bullet, machine-parseable):
//
//   ## §17.x Section Title
//   - [x] Bullet description
//     - `test/unit/path/to/file.test.ts > exact test name`
//
// Bullets that are intentionally not implemented in v1 are marked with an
// unchecked box and an HTML comment, e.g.:
//
//   - [ ] Humanized event summaries cover key event classes <!-- not implemented in v1 -->

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/* -------------------------------------------------------------------------- */
/* Locate repo root + coverage doc                                            */
/* -------------------------------------------------------------------------- */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const COVERAGE_DOC = resolve(REPO_ROOT, "test", "section-17-coverage.md");

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

interface BulletEntry {
  readonly section: string;
  readonly description: string;
  readonly checked: boolean;
  readonly notImplemented: boolean;
  readonly testPath: string | null;
  readonly testName: string | null;
  readonly lineNumber: number;
}

interface AuditError {
  readonly bullet: BulletEntry;
  readonly reason: string;
}

/* -------------------------------------------------------------------------- */
/* Parser                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Parse the coverage doc into structured bullet entries. Tolerates blank
 * lines and prose paragraphs between sections. Each "- [ ]" or "- [x]"
 * bullet line is paired with the next indented "  - `...`" reference line
 * (if any).
 */
const parseCoverageDoc = (content: string): ReadonlyArray<BulletEntry> => {
  const lines = content.split("\n");
  const out: Array<BulletEntry> = [];
  // `null` means we haven't entered a § section yet — bullets before the
  // first `## §17.x` heading are documentation examples and are skipped.
  let currentSection: string | null = null;
  let inCodeFence = false;
  const sectionRe = /^##\s+§(17\.\d+)\s+(.*?)\s*$/;
  const bulletRe = /^-\s+\[(\s|x)\]\s+(.*?)\s*$/;
  // The reference is a backticked path > name pair. The path side may not
  // contain backticks; the name side may contain escaped backticks (`\``)
  // — we unescape those after capture.
  const refRe = /^\s{2,}-\s+`([^`>]+?)\s*>\s*(.+?)`\s*$/;
  const notImplRe = /<!--\s*not implemented(?:\s+in\s+v1)?\s*-->/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Skip fenced code blocks so doc-internal markdown examples don't
    // register as real bullets.
    if (/^```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    const secMatch = sectionRe.exec(line);
    if (secMatch !== null) {
      currentSection = `§${secMatch[1] ?? ""} ${secMatch[2] ?? ""}`.trim();
      continue;
    }
    if (currentSection === null) continue;

    const bMatch = bulletRe.exec(line);
    if (bMatch === null) continue;

    const checked = (bMatch[1] ?? " ") === "x";
    const description = (bMatch[2] ?? "").trim();
    const notImplemented = notImplRe.test(description);

    // Look at the next non-blank line for a backticked reference.
    let testPath: string | null = null;
    let testName: string | null = null;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? "";
      if (next.trim() === "") continue;
      const rMatch = refRe.exec(next);
      if (rMatch !== null) {
        testPath = (rMatch[1] ?? "").trim();
        // Unescape doc-level backtick escapes so the captured name matches
        // the literal `it("…")` string in the test file.
        testName = (rMatch[2] ?? "").trim().replace(/\\`/g, "`");
      }
      break;
    }
    out.push({
      section: currentSection,
      description,
      checked,
      notImplemented,
      testPath,
      testName,
      lineNumber: i + 1,
    });
  }
  return out;
};

/* -------------------------------------------------------------------------- */
/* Test presence check                                                        */
/* -------------------------------------------------------------------------- */

/** Cache file contents so we read each referenced test file only once. */
const fileCache = new Map<string, string>();

const readTestFile = (relPath: string): string | null => {
  const abs = resolve(REPO_ROOT, relPath);
  if (fileCache.has(abs)) return fileCache.get(abs) ?? null;
  if (!existsSync(abs)) {
    fileCache.set(abs, "");
    return null;
  }
  const content = readFileSync(abs, "utf8");
  fileCache.set(abs, content);
  return content;
};

/**
 * Confirm that `testName` appears as the first argument of an `it(...)` or
 * `test(...)` (including `it.effect`, `it.live`, `it.skipIf`, `it.skip`,
 * `test.skip`) inside the supplied file content. We require the literal
 * string to appear in either single- or double-quoted form to keep the
 * matcher robust to either quote style.
 */
const fileHasTest = (content: string, testName: string): boolean => {
  const needleSingle = `'${testName}'`;
  const needleDouble = `"${testName}"`;
  return content.includes(needleSingle) || content.includes(needleDouble);
};

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

const main = (): void => {
  if (!existsSync(COVERAGE_DOC)) {
    process.stderr.write(
      `audit-section-17: coverage doc not found at ${COVERAGE_DOC}\n`,
    );
    process.exit(1);
  }
  const doc = readFileSync(COVERAGE_DOC, "utf8");
  const bullets = parseCoverageDoc(doc);

  let total = 0;
  let covered = 0;
  let notImpl = 0;
  const errors: Array<AuditError> = [];

  for (const bullet of bullets) {
    total++;
    if (bullet.notImplemented) {
      // Bullets marked "not implemented in v1" are exempt. We still surface
      // them in the counts so the operator sees the divergence.
      notImpl++;
      if (bullet.checked) {
        errors.push({
          bullet,
          reason:
            "marked 'not implemented' but the checkbox is checked — pick one",
        });
      }
      continue;
    }
    if (!bullet.checked) {
      errors.push({
        bullet,
        reason: "checkbox is unchecked — bullet has no implementation",
      });
      continue;
    }
    if (bullet.testPath === null || bullet.testName === null) {
      errors.push({
        bullet,
        reason: "no `test_file > test_name` reference on the line below",
      });
      continue;
    }
    const fileContent = readTestFile(bullet.testPath);
    if (fileContent === null) {
      errors.push({
        bullet,
        reason: `referenced test file does not exist: ${bullet.testPath}`,
      });
      continue;
    }
    if (!fileHasTest(fileContent, bullet.testName)) {
      errors.push({
        bullet,
        reason:
          `test name not found in ${bullet.testPath}: "${bullet.testName}"`,
      });
      continue;
    }
    covered++;
  }

  // Summary
  const newlyAdded = total - covered - notImpl - errors.length;
  process.stdout.write(`audit-section-17: ${total} bullets parsed\n`);
  process.stdout.write(`  covered:           ${covered}\n`);
  process.stdout.write(`  not implemented:   ${notImpl}\n`);
  if (newlyAdded > 0) {
    process.stdout.write(`  uncategorized:     ${newlyAdded}\n`);
  }

  if (errors.length > 0) {
    process.stderr.write(
      `\naudit-section-17: ${errors.length} bullet(s) failing:\n`,
    );
    for (const err of errors) {
      process.stderr.write(
        `  - ${err.bullet.section}: ${err.bullet.description}\n`,
      );
      process.stderr.write(`    line ${err.bullet.lineNumber}: ${err.reason}\n`);
      if (err.bullet.testPath !== null && err.bullet.testName !== null) {
        process.stderr.write(
          `    referenced: ${err.bullet.testPath} > ${err.bullet.testName}\n`,
        );
      }
    }
    process.stderr.write(
      `\nmissing test for §17.x bullet — run \`bun test\` for full coverage check\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`\naudit-section-17: OK\n`);
};

main();
