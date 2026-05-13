// Symphony v1 CLI entry point.
// Stub: parses argv for <path-to-WORKFLOW.md> and verifies the file exists; full layer wiring lands in a later task.
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const PROGRAM = "symphony";

const usage = (): string =>
  `usage: ${PROGRAM} <path-to-WORKFLOW.md>`;

const die = (message: string, code = 1): never => {
  process.stderr.write(`${PROGRAM}: ${message}\n`);
  process.exit(code);
};

const main = (): void => {
  // Bun forwards script args starting at argv[2], matching Node's convention.
  const args = process.argv.slice(2);
  const workflowArg = args[0];

  if (workflowArg === undefined || workflowArg.length === 0) {
    return die(`missing required argument: <path-to-WORKFLOW.md>\n${usage()}`, 2);
  }

  const workflowPath = resolve(process.cwd(), workflowArg);

  process.stderr.write(
    `${PROGRAM} starting (workflow=${workflowPath})\n`,
  );

  if (!existsSync(workflowPath)) {
    die(`workflow file not found: ${workflowPath}`, 1);
  }

  const stats = statSync(workflowPath);
  if (!stats.isFile()) {
    die(`workflow path is not a regular file: ${workflowPath}`, 1);
  }

  // Application wiring (Layer.launch, signal handling, orchestrator) is intentionally
  // deferred to the application-wiring task. This stub exits cleanly so downstream
  // tasks can build on a known-good entry point.
  process.exit(0);
};

main();
