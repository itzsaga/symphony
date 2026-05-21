// Pure dispatch planner: candidate eligibility (§8.2), stable sort, and
// concurrency control (§8.3). Inputs are immutable; outputs describe intent.
import { Data } from "effect";
import type { Issue } from "../linear/schemas.ts";
import type { TypedConfig } from "../config/WorkflowSchema.ts";
import type { IssueId, OrchestratorRuntimeState } from "./State.ts";

/* -------------------------------------------------------------------------- */
/* SkipReason — the discriminated union surfaced for logging / HTTP debug.    */
/*                                                                            */
/* Used by both the dispatcher's logging path and the operator-visible        */
/* `/api/v1/<id>` view, so each variant carries enough context to render the  */
/* explanation without a second lookup against the orchestrator state.        */
/* -------------------------------------------------------------------------- */

/** Issue is missing one of the spec §4.1.1 required fields, or its state is
 *  not in `tracker.active_states` (or is in `tracker.terminal_states`). */
export class StateNotActive extends Data.TaggedClass("StateNotActive")<{
  readonly state: string;
}> {}

/** Issue id already present in `state.running`. */
export class AlreadyRunning extends Data.TaggedClass("AlreadyRunning")<{
  readonly since: Date | null;
}> {}

/** Issue id already present in `state.claimed` but not in `running` — usually
 *  a worker fiber forked between the dispatch decision and the next tick. */
export class AlreadyClaimed extends Data.TaggedClass("AlreadyClaimed")<{}> {}

/**
 * Spec §8.2 blocker rule for `Todo`: at least one blocker is not in
 * `tracker.terminal_states`. The blocker identifiers (when known) are echoed
 * back so the operator can see which tickets are gating dispatch.
 */
export class TodoBlocked extends Data.TaggedClass("TodoBlocked")<{
  readonly blockers: ReadonlyArray<{
    readonly identifier: string | null;
    readonly state: string | null;
  }>;
}> {}

/** Global slot count (§8.3) is exhausted at the time of the check. */
export class NoGlobalSlot extends Data.TaggedClass("NoGlobalSlot")<{
  readonly running: number;
  readonly cap: number;
}> {}

/** Per-state slot count (§8.3) for the issue's state is exhausted. */
export class NoPerStateSlot extends Data.TaggedClass("NoPerStateSlot")<{
  readonly state: string;
  readonly running_in_state: number;
  readonly cap: number;
}> {}

/** Discriminated union of every dispatcher skip reason. */
export type SkipReason =
  | StateNotActive
  | AlreadyRunning
  | AlreadyClaimed
  | TodoBlocked
  | NoGlobalSlot
  | NoPerStateSlot;

/* -------------------------------------------------------------------------- */
/* Public result shape.                                                       */
/* -------------------------------------------------------------------------- */

/** Output of {@link selectDispatchBatch}: dispatched issues + skip rationale. */
export interface DispatchPlan {
  readonly toDispatch: ReadonlyArray<Issue>;
  readonly reasons_skipped: ReadonlyMap<IssueId, SkipReason>;
}

/* -------------------------------------------------------------------------- */
/* Sort helpers.                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Parse an ISO-8601 string into milliseconds; `null` and unparseable strings
 * sort last per spec §8.2 ("null/unknown sorts last"). Normalization in
 * `linear/normalize.ts` already validates the string format, so the
 * `Date.parse` here should always succeed in practice; the NaN guard is
 * defense-in-depth.
 */
const createdAtMs = (raw: string | null): number => {
  if (raw === null) return Number.MAX_SAFE_INTEGER;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? Number.MAX_SAFE_INTEGER : ms;
};

/**
 * Stable sort per spec §8.2:
 *   1. `priority` ascending (1..4 preferred; null/unknown last)
 *   2. `created_at` oldest first
 *   3. `identifier` lexicographic tie-breaker
 *
 * `Array.prototype.sort` is stable on every modern JS engine (V8, JSC,
 * SpiderMonkey, Bun's JSC fork), so the tie-breaker step is genuinely the
 * last word — no hidden non-determinism from engine-implementation details.
 */
export const sortForDispatch = (
  issues: ReadonlyArray<Issue>,
): ReadonlyArray<Issue> =>
  [...issues].sort((a, b) => {
    const pa = a.priority ?? Number.MAX_SAFE_INTEGER;
    const pb = b.priority ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    const ca = createdAtMs(a.created_at);
    const cb = createdAtMs(b.created_at);
    if (ca !== cb) return ca - cb;
    return a.identifier.localeCompare(b.identifier);
  });

/* -------------------------------------------------------------------------- */
/* Eligibility helpers.                                                       */
/* -------------------------------------------------------------------------- */

const isMissingRequiredFields = (issue: Issue): boolean =>
  issue.id === "" ||
  issue.identifier === "" ||
  issue.title === "" ||
  issue.state === "";

const lowerSet = (xs: ReadonlyArray<string>): ReadonlySet<string> => {
  const out = new Set<string>();
  for (const x of xs) out.add(x.toLowerCase());
  return out;
};

/**
 * Pull the global concurrency cap. We prefer the workflow-resident
 * `agent_runner.max_concurrent_agents` (spec §5.3.5) so a hot reload's value
 * is honored on the very next tick; `state.max_concurrent_agents` is the
 * cached mirror updated by `WorkflowReloaded` and acts as a fallback.
 */
const globalCap = (
  state: OrchestratorRuntimeState,
  config: TypedConfig,
): number =>
  config.agent_runner.max_concurrent_agents ??
  state.max_concurrent_agents;

/**
 * Lowercase normalization of `agent_runner.max_concurrent_agents_by_state`
 * per spec §4.2 / §8.3. The schema accepts the operator's casing as-written;
 * the dispatcher normalizes on read so lookups by lowercased state name are
 * O(1) without re-walking the source map per candidate.
 */
const readPerStateCaps = (
  config: TypedConfig,
): ReadonlyMap<string, number> => {
  const raw = config.agent_runner.max_concurrent_agents_by_state;
  const out = new Map<string, number>();
  for (const [k, v] of Object.entries(raw)) {
    out.set(k.toLowerCase(), v);
  }
  return out;
};

/**
 * Count issues in `state.running` whose state matches the given lowercase
 * state name. The runtime keeps the in-memory `issue.state` field in sync
 * via reconciliation (see `ReconciliationStateRefresh` handling in
 * `State.ts`), so this count tracks the operator-visible state per §8.3.
 */
const runningCountByState = (
  state: OrchestratorRuntimeState,
  lowerStateName: string,
): number => {
  let n = 0;
  for (const entry of state.running.values()) {
    if (entry.issue.state.toLowerCase() === lowerStateName) n += 1;
  }
  return n;
};

/* -------------------------------------------------------------------------- */
/* Main entry point.                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Pure dispatch planner.
 *
 * Walks `candidates` in spec §8.2 sorted order, classifying each issue as
 * either dispatchable (added to `toDispatch`) or skipped (added to
 * `reasons_skipped`). Slot accounting is incremental: global and per-state
 * counters are updated as `toDispatch` grows, so a candidate list of size N
 * with a cap of K dispatches exactly K issues and skips N - K with
 * `NoGlobalSlot` / `NoPerStateSlot`.
 *
 * Eligibility-check ordering (first match wins):
 *   1. Required-field presence + state-list membership (`StateNotActive`)
 *   2. `state.running` membership (`AlreadyRunning`)
 *   3. `state.claimed` membership (`AlreadyClaimed`)
 *   4. `Todo` blocker rule (`TodoBlocked`)
 *   5. Global slot (`NoGlobalSlot`)
 *   6. Per-state slot (`NoPerStateSlot`)
 *
 * The ordering matters for the operator-facing debug view: it prefers the
 * structural reasons (state, identity) over the dynamic reasons (slots), so
 * an issue that's permanently un-dispatchable reads consistently across
 * ticks instead of flipping between `NoGlobalSlot` and `AlreadyRunning`.
 */
export const selectDispatchBatch = (
  candidates: ReadonlyArray<Issue>,
  state: OrchestratorRuntimeState,
  config: TypedConfig,
): DispatchPlan => {
  const activeLower = lowerSet(config.tracker.active_states);
  const terminalLower = lowerSet(config.tracker.terminal_states);
  const perStateCaps = readPerStateCaps(config);
  const globalSlotCap = globalCap(state, config);

  const sorted = sortForDispatch(candidates);
  const toDispatch: Array<Issue> = [];
  const reasons_skipped = new Map<IssueId, SkipReason>();

  // Local running-count cache so we don't rescan state.running on every loop.
  // Seeded from the actual running map and incremented as we accumulate
  // dispatches so the per-state cap reflects "live + planned" usage.
  const runningInState = new Map<string, number>();
  let runningTotal = state.running.size;

  for (const issue of sorted) {
    const stateLower = issue.state.toLowerCase();

    // 1. Required fields + active/terminal state membership.
    if (isMissingRequiredFields(issue)) {
      reasons_skipped.set(
        issue.id,
        new StateNotActive({ state: issue.state }),
      );
      continue;
    }
    if (!activeLower.has(stateLower) || terminalLower.has(stateLower)) {
      reasons_skipped.set(
        issue.id,
        new StateNotActive({ state: issue.state }),
      );
      continue;
    }

    // 2. Already running.
    const runningEntry = state.running.get(issue.id);
    if (runningEntry !== undefined) {
      reasons_skipped.set(
        issue.id,
        new AlreadyRunning({ since: runningEntry.started_at }),
      );
      continue;
    }

    // 3. Already claimed (without a running entry — racing dispatch).
    if (state.claimed.has(issue.id)) {
      reasons_skipped.set(issue.id, new AlreadyClaimed());
      continue;
    }

    // 4. Todo blocker rule.
    if (stateLower === "todo") {
      const nonTerminalBlockers = issue.blocked_by.filter((b) => {
        if (b.state === null) {
          // A blocker we can't see the state of is conservatively treated
          // as non-terminal — better to wait on a possibly-open blocker
          // than to dispatch through an unknown.
          return true;
        }
        return !terminalLower.has(b.state.toLowerCase());
      });
      if (nonTerminalBlockers.length > 0) {
        reasons_skipped.set(
          issue.id,
          new TodoBlocked({
            blockers: nonTerminalBlockers.map((b) => ({
              identifier: b.identifier,
              state: b.state,
            })),
          }),
        );
        continue;
      }
    }

    // 5. Global slot — recomputed against `runningTotal` which includes
    //    already-planned dispatches in this batch.
    if (runningTotal >= globalSlotCap) {
      reasons_skipped.set(
        issue.id,
        new NoGlobalSlot({ running: runningTotal, cap: globalSlotCap }),
      );
      continue;
    }

    // 6. Per-state slot. When no explicit per-state cap is configured, the
    //    spec §8.3 fallback is the global cap; we've already enforced that
    //    above, so absence of an entry means "no additional gate". This
    //    matches the spec text "otherwise fallback to global limit" without
    //    double-counting.
    const perStateCap = perStateCaps.get(stateLower);
    if (perStateCap !== undefined) {
      const current = runningInState.get(stateLower) ??
        runningCountByState(state, stateLower);
      runningInState.set(stateLower, current);
      if (current >= perStateCap) {
        reasons_skipped.set(
          issue.id,
          new NoPerStateSlot({
            state: issue.state,
            running_in_state: current,
            cap: perStateCap,
          }),
        );
        continue;
      }
    }

    // All gates passed — plan the dispatch and bump the counters.
    toDispatch.push(issue);
    runningTotal += 1;
    if (perStateCap !== undefined) {
      const current = runningInState.get(stateLower) ?? 0;
      runningInState.set(stateLower, current + 1);
    } else {
      // Even when no cap is configured, keep the per-state cache primed
      // for any later cap consultation in the same batch (e.g. if a
      // future schema lets a single workflow define caps per priority
      // group, the cache stays consistent).
      const current = runningInState.get(stateLower);
      if (current !== undefined) runningInState.set(stateLower, current + 1);
    }
  }

  return { toDispatch, reasons_skipped };
};
