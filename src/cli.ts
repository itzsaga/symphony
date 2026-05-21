// Symphony v1 CLI argv parser: positional workflow path + `--port` override.
// Pure function — the daemon's signal handling, layer wiring, and exit codes live in main.ts.

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Parsed CLI surface. The workflow path is `null` when no positional argument
 * was supplied — `main.ts` falls back to `./WORKFLOW.md` in that case (per
 * §17.7). `port` is `null` when no `--port` flag was supplied; the HTTP
 * extension's resolver promotes a workflow `server.port` value in that case.
 * `errors` is non-empty exactly when argv contained unknown flags or
 * malformed values; callers should `die` with a non-zero exit code.
 */
export interface ParsedCli {
  readonly workflowPath: string | null;
  readonly port: number | null;
  readonly errors: ReadonlyArray<string>;
}

/* -------------------------------------------------------------------------- */
/* Parser                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Parse the argv tail (everything after `<runtime> <script>`). The accepted
 * surface is:
 *
 *   - One optional positional argument: the workflow path. The first non-flag
 *     token wins; additional positionals produce an "unknown argument" error.
 *   - `--port <N>` or `--port=<N>`: port override. Malformed values produce
 *     an error (rather than silently dropping the override as `parsePortFlag`
 *     does — `parsePortFlag` is the HTTP-layer's "best-effort" reader, while
 *     this parser is the operator-facing surface).
 *
 * Unknown flags (`--foo`, `-x`) produce an "unknown argument" error so a
 * typo doesn't silently start the daemon in an unexpected configuration.
 */
export const parseCli = (argv: ReadonlyArray<string>): ParsedCli => {
  let workflowPath: string | null = null;
  let port: number | null = null;
  const errors: Array<string> = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--port") {
      const next = argv[i + 1];
      if (next === undefined) {
        errors.push("--port requires a value");
        continue;
      }
      const parsed = parsePortValueStrict(next);
      if (parsed === null) {
        errors.push(`--port: invalid port value '${next}'`);
      } else {
        port = parsed;
      }
      i += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      const raw = arg.slice("--port=".length);
      const parsed = parsePortValueStrict(raw);
      if (parsed === null) {
        errors.push(`--port: invalid port value '${raw}'`);
      } else {
        port = parsed;
      }
      continue;
    }

    if (arg.startsWith("--") || arg.startsWith("-")) {
      errors.push(`unknown argument: ${arg}`);
      continue;
    }

    // Positional — first one wins; any further positional is an error.
    if (workflowPath === null) {
      workflowPath = arg;
      continue;
    }
    errors.push(`unexpected positional argument: ${arg}`);
  }

  return { workflowPath, port, errors };
};

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Strict integer-port parser: rejects empty input, non-integers, negatives,
 * and out-of-range values. Returns `null` to signal "malformed" so the caller
 * can produce an operator-readable error message naming the offending value.
 */
const parsePortValueStrict = (raw: string): number | null => {
  if (raw.length === 0) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 65_535) {
    return null;
  }
  return n;
};

/**
 * Render the canonical usage line. Kept here (not in main.ts) so tests can
 * assert on the exact text without importing the entire entrypoint.
 */
export const USAGE = "usage: symphony [<path-to-WORKFLOW.md>] [--port <N>]";
