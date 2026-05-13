# Reconciliation (stall + tracker state refresh)

## Objective

Implement spec §8.5: detect stalled runs (Part A) and refresh tracker state for running issues (Part B). Produce side-effect intents (`InterruptWorker`, `CleanupWorkspace`, `UpdateIssueSnapshot`) the orchestrator runtime executes.

## Context

### Parent PRD

- **PRD**: Symphony v1 (Effect.ts + Claude Code)
- **PRD Path**: `.claude/prds/symphony-v1/PRD.md`

### Related Tasks

- **Depends on**: orchestrator-state.md, linear-client.md, logger-service.md.
- **Blocks**: orchestrator-retry-and-tick.md.

## Acceptance Criteria

- [ ] `reconcileStalled(state, config, now): ReadonlyArray<SideEffect>` (Part A) — pure.
  - For each `running` entry, compute `elapsed_ms = now - (last_event_at ?? started_at)`.
  - If `elapsed_ms > config.agent_runner.stall_timeout_ms` AND `stall_timeout_ms > 0`: emit `StallDetected({ issue_id })` event AND side effects `InterruptWorker` + `ScheduleRetry` (abnormal).
  - If `stall_timeout_ms <= 0`: no-op (stall detection disabled per §8.5).
- [ ] `reconcileTrackerStates(state, refreshed: ReadonlyArray<MinimalIssue>, terminal_states: ReadonlySet<string>, active_states: ReadonlySet<string>): ReadonlyArray<SideEffect>` (Part B) — pure.
  - For each `running` issue:
    - If `issue.state` (lowercased) ∈ terminal: emit `InterruptWorker` + `CleanupWorkspace` + remove from `running`/`claimed`.
    - If `issue.state` (lowercased) ∈ active: emit `UpdateIssueSnapshot` (update the in-memory issue field on the running entry).
    - Otherwise (state is neither active nor terminal): emit `InterruptWorker` (without `CleanupWorkspace`) + remove from `running`/`claimed`.
- [ ] On refresh-fetch failure (in the caller, not here): log + keep workers running, retry on next tick (§8.5: "If state refresh fails, keep workers running and try again on the next tick").
- [ ] Both functions are deterministic and pure.
- [ ] Wired through the orchestrator: every poll tick, the tick fiber calls `reconcileStalled` first, then performs the Linear state-refresh fetch, then calls `reconcileTrackerStates` (per §16.3 reference algorithm).

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `src/orchestrator/Reconcile.ts` | Create | Both pure functions + tests. |

### Technical Constraints

- State-name comparison normalized via `state.toLowerCase()` (§4.2).
- `now` is passed in (not `new Date()` inside the function), to make tests deterministic.
- `terminal_states`/`active_states` are pre-normalized `Set<lowercased>` from `TypedConfig`.

### Relevant Code References

- Spec §8.5 (the entire section), §16.3 (reference algorithm).
- `orchestrator-state.md` — the `RunningEntry.started_at`, `last_event_at` fields.

## Testing Requirements

- [ ] Stall detection: `elapsed_ms = 6 minutes`, `stall_timeout_ms = 5 minutes` → emits `StallDetected` + `InterruptWorker` + `ScheduleRetry`.
- [ ] Stall detection disabled when `stall_timeout_ms <= 0`.
- [ ] Stall detection uses `last_event_at` when present, else `started_at`.
- [ ] Tracker reconcile: terminal state → `InterruptWorker` + `CleanupWorkspace`.
- [ ] Tracker reconcile: active state → `UpdateIssueSnapshot` only.
- [ ] Tracker reconcile: state neither active nor terminal → `InterruptWorker` without cleanup.
- [ ] State name case-insensitive (e.g. `"DONE"` matches `"done"` in terminal_states).
- [ ] No issue in `refreshed` means we don't touch its running entry (caller can decide what "missing" means — typically dropped from Linear since last poll; handled by next tick's candidate fetch).

## Out of Scope

- Fetching the candidate states (that's `orchestrator-retry-and-tick.md`).
- Re-issuing tracker state-refresh on failure (single-attempt per tick; the next tick retries).
- Differentiating "removed from Linear" vs "API hiccup" — the Linear API doesn't tell us.
