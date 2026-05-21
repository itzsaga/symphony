// Shared bootstrap for the §17.8 real-Linear integration suite: API-key
// resolution, namespaced identifiers, cleanup registry, scripted constants.
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/* -------------------------------------------------------------------------- */
/* API key resolution                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a Linear API key for the integration suite. The §17.8 contract
 * accepts two sources in priority order:
 *
 *   1. `LINEAR_API_KEY` env var (preferred — what CI uses).
 *   2. The first line of `~/.linear_api_key` (developer ergonomics fallback
 *      named in spec §17.8 verbatim).
 *
 * Returns `null` when neither source yields a non-empty string. The whole
 * suite gates on this — when it is `null` every test is reported skipped.
 */
export const resolveLinearApiKey = (): string | null => {
  const fromEnv = process.env["LINEAR_API_KEY"];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  const fallbackPath = join(homedir(), ".linear_api_key");
  if (!existsSync(fallbackPath)) return null;
  try {
    const contents = readFileSync(fallbackPath, "utf8");
    const firstLine = contents.split("\n")[0] ?? "";
    const trimmed = firstLine.trim();
    return trimmed.length === 0 ? null : trimmed;
  } catch {
    return null;
  }
};

/** Resolved at module load so tests see a stable value for the whole run. */
export const LINEAR_API_KEY: string | null = resolveLinearApiKey();

/** True when this run is allowed to talk to Linear at all. */
export const HAS_LINEAR_API_KEY: boolean = LINEAR_API_KEY !== null;

/**
 * Whether the explicit "fail the job on integration-test failure" flag is
 * set. Spec §17.8 says enabled-mode failures SHOULD fail the job. When the
 * key is present but this flag is absent the suite still runs — bun test
 * will surface real failures either way; the flag exists primarily as a
 * documented CI knob (see README).
 */
export const SYMPHONY_INTEGRATION_TESTS_ENABLED: boolean =
  process.env["SYMPHONY_INTEGRATION_TESTS"] === "enabled";

/* -------------------------------------------------------------------------- */
/* Test-project + identifier scheme                                           */
/* -------------------------------------------------------------------------- */

/**
 * `slugId` of the Linear project that contains the integration suite's
 * fixture issues. Falls back to `symphony-integration` so a developer can
 * stand up a project with that slug without setting another env var.
 *
 * The README documents how to bootstrap this project and what state values
 * it should contain.
 */
export const TEST_PROJECT_SLUG: string =
  process.env["SYMPHONY_INTEGRATION_PROJECT_SLUG"] ?? "symphony-integration";

/**
 * Optional team key (e.g. `SYM`) used by mutations that create issues for
 * cleanup verification. Absent → mutation-driven tests skip themselves.
 */
export const TEST_TEAM_ID: string | null =
  process.env["SYMPHONY_INTEGRATION_TEAM_ID"] ?? null;

/**
 * Per-run namespace prefix. Every artifact the suite creates uses this so
 * partial cleanups from an aborted previous run can't collide with the
 * current run.
 */
export const TEST_NAMESPACE: string = `symphony-integration-${Date.now()}`;

/**
 * Default Linear GraphQL endpoint. Configurable for sanity (e.g. routing
 * through a local proxy during diagnosis) but rarely overridden.
 */
export const LINEAR_ENDPOINT: string =
  process.env["SYMPHONY_INTEGRATION_LINEAR_ENDPOINT"] ??
  "https://api.linear.app/graphql";

/**
 * Workspace root for the end-to-end smoke. Lives under the OS temp dir so
 * dev workspaces under `~/.symphony/workspaces` don't get touched.
 */
export const INTEGRATION_WORKSPACE_ROOT: string = join(
  tmpdir(),
  "symphony_integration_workspaces",
);

/* -------------------------------------------------------------------------- */
/* Cleanup registry                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Kind tags for cleanup entries — used by `cleanupAll` to dispatch to the
 * appropriate Linear mutation. Kept narrow so each branch has an explicit
 * mutation string; "issueLabel" is treated separately from "issue" because
 * Linear's archive surface differs.
 */
export type CleanupKind = "issue" | "comment" | "issueLabel";

interface CleanupEntry {
  readonly kind: CleanupKind;
  readonly id: string;
  /** Optional human label that aids debugging when cleanup fails. */
  readonly label: string;
}

const cleanupRegistry: Array<CleanupEntry> = [];

/**
 * Record an artifact for `afterAll` cleanup. The registry is a module-level
 * array so any helper that creates a tracker artifact can record it without
 * threading state through the test body.
 */
export const recordForCleanup = (
  kind: CleanupKind,
  id: string,
  label: string,
): void => {
  cleanupRegistry.push({ kind, id, label });
};

/**
 * Drain the cleanup registry. Each entry is best-effort — a cleanup failure
 * is logged via the supplied logger but does NOT fail the test run, since
 * the artifact may have already been removed by hand or by a previous run.
 */
export const drainCleanup = (): ReadonlyArray<CleanupEntry> => {
  const snapshot = cleanupRegistry.slice();
  cleanupRegistry.length = 0;
  return snapshot;
};

/* -------------------------------------------------------------------------- */
/* GraphQL mutation strings used by the cleanup harness.                      */
/*                                                                            */
/* We issue mutations via LinearClient.executeRaw so we don't have to grow    */
/* the client's surface for what is exclusively a test concern.               */
/* -------------------------------------------------------------------------- */

/**
 * Archive an issue. Linear's "archive" is a soft-delete that hides the
 * issue from default views; it is the correct cleanup verb for issues
 * created by an integration run.
 */
export const ISSUE_ARCHIVE_MUTATION: string = `
mutation SymphonyIntegrationArchiveIssue($id: String!) {
  issueArchive(id: $id) { success }
}
`.trim();

/** Delete a comment outright. */
export const COMMENT_DELETE_MUTATION: string = `
mutation SymphonyIntegrationDeleteComment($id: String!) {
  commentDelete(id: $id) { success }
}
`.trim();

/** Archive an issue label. */
export const ISSUE_LABEL_ARCHIVE_MUTATION: string = `
mutation SymphonyIntegrationArchiveLabel($id: String!) {
  issueLabelArchive(id: $id) { success }
}
`.trim();

/**
 * Map a CleanupKind to the appropriate mutation string. Centralized here so
 * the cleanup harness doesn't carry policy in a switch.
 */
export const mutationFor = (kind: CleanupKind): string => {
  switch (kind) {
    case "issue":
      return ISSUE_ARCHIVE_MUTATION;
    case "comment":
      return COMMENT_DELETE_MUTATION;
    case "issueLabel":
      return ISSUE_LABEL_ARCHIVE_MUTATION;
  }
};

/* -------------------------------------------------------------------------- */
/* Skip banners                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Emit the §17.8 "skipped: real Linear integration …" banner once per
 * module so the operator sees a clear reason in test output. Called from
 * the test file's top-level when `HAS_LINEAR_API_KEY` is false.
 *
 * We write directly to stderr (rather than through `console.log`) because
 * bun test redirects console but mirrors stderr verbatim.
 */
let bannerEmitted = false;
export const emitSkipBanner = (): void => {
  if (bannerEmitted) return;
  bannerEmitted = true;
  process.stderr.write(
    "skipped: real Linear integration (set LINEAR_API_KEY)\n",
  );
};
