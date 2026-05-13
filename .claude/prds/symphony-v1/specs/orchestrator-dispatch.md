# Dispatch (candidate selection, sorting, slots)

## Objective

Implement spec §8.2 candidate eligibility, §8.3 concurrency control (global + per-state), and the stable dispatch sort order. Pure functions over `(issues, state, config) → (dispatch_decisions, side_effects)`.

## Context

### Parent PRD

- **PRD**: Symphony v1 (Effect.ts + Claude Code)
- **PRD Path**: `.claude/prds/symphony-v1/PRD.md`

### Related Tasks

- **Depends on**: orchestrator-state.md.
- **Blocks**: orchestrator-retry-and-tick.md.

## Acceptance Criteria

- [ ] `selectDispatchBatch(candidates: ReadonlyArray<Issue>, state: OrchestratorRuntimeState, config: TypedConfig): { toDispatch: ReadonlyArray<Issue>; reasons_skipped: Map<IssueId, SkipReason> }`. Pure.
- [ ] Eligibility per §8.2:
  - Has `id`, `identifier`, `title`, `state`.
  - State is in `tracker.active_states` and not in `tracker.terminal_states` (normalized lowercase compare per §4.2).
  - Not in `state.running`.
  - Not in `state.claimed`.
  - Global slots: `state.running.size < config.agent_runner.max_concurrent_agents` AT TIME OF CHECK; recompute as we accumulate `toDispatch`.
  - Per-state slots: `config.agent_runner.max_concurrent_agents_by_state[issue.state.lowercase]` if present; otherwise fall back to global.
  - Blocker rule (§8.2): if `issue.state.lowercase === "todo"`, do NOT dispatch when any blocker is non-terminal.
- [ ] Sort order per §8.2 (stable):
  1. `priority` ascending, null/unknown sorts last.
  2. `created_at` oldest first.
  3. `identifier` lexicographic tie-breaker.
- [ ] `SkipReason` discriminated union: `AlreadyRunning | AlreadyClaimed | NoGlobalSlot | NoPerStateSlot | TodoBlocked | StateNotActive`. Used for logging + the operator-visible debug view in HTTP `/api/v1/<id>`.
- [ ] `max_concurrent_agents_by_state` lookup normalizes both sides (state key lowercased before lookup, per §4.2 and §8.3).

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `src/orchestrator/Dispatch.ts` | Create | `selectDispatchBatch` + `sortForDispatch` + `SkipReason`. |

### Technical Constraints

- Pure; no Effect dependency.
- Must be deterministic and stable. A test seeded with the same input list and state must produce the same output every time.
- Watch out for floating-point or BigInt issues in priority comparison — priorities are integers.
- ISO-8601 timestamps come in as strings from Linear; coerce to `Date` once at normalization (linear-client.md) and compare as `Date`.

### Relevant Code References

- Spec §8.2 (eligibility), §8.3 (concurrency), §4.2 (normalization).
- `orchestrator-state.md` — `OrchestratorRuntimeState`, `TypedConfig`.

### Code Examples

```ts
const sortForDispatch = (issues: ReadonlyArray<Issue>): ReadonlyArray<Issue> =>
  [...issues].sort((a, b) => {
    const pa = a.priority ?? Number.MAX_SAFE_INTEGER
    const pb = b.priority ?? Number.MAX_SAFE_INTEGER
    if (pa !== pb) return pa - pb
    const ca = a.created_at?.getTime() ?? Number.MAX_SAFE_INTEGER
    const cb = b.created_at?.getTime() ?? Number.MAX_SAFE_INTEGER
    if (ca !== cb) return ca - cb
    return a.identifier.localeCompare(b.identifier)
  })
```

## Testing Requirements

- [ ] Priority 1 ahead of priority 4.
- [ ] Equal priority: older `created_at` first.
- [ ] Equal priority + null `created_at`s: lexicographic identifier order.
- [ ] Already-running issue is skipped with `AlreadyRunning`.
- [ ] Already-claimed issue is skipped.
- [ ] `Todo` with non-terminal blocker is skipped with `TodoBlocked`.
- [ ] `Todo` with all-terminal blockers is eligible (regression: don't conflate "no blockers" with "blockers exist but all terminal").
- [ ] Per-state cap of 1 with two same-state issues: only the first dispatches; second skipped with `NoPerStateSlot`.
- [ ] Global cap of 2 with five eligible issues: only two dispatch; rest skipped with `NoGlobalSlot`.
- [ ] State name lookup case-insensitive (`"In Progress"` vs `"in progress"` config key both work).

## Out of Scope

- Fairness / priority inversion. The §8.2 sort order is the law.
- Issue caching between ticks (always fresh from `fetch_candidate_issues`).
- Workspace-level concurrency limits (e.g. "don't dispatch two issues to the same workspace") — single-issue-per-workspace by design.
