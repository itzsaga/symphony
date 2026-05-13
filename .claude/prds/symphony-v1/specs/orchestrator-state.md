# Orchestrator state and reducer

## Objective

Define `OrchestratorRuntimeState` matching spec §4.1.8 and implement a pure reducer for every transition trigger in §7.3. The reducer is total — every event has a defined transition. State is held in a `SubscriptionRef` so HTTP observers can subscribe to changes.

## Context

### Parent PRD

- **PRD**: Symphony v1 (Effect.ts + Claude Code)
- **PRD Path**: `.claude/prds/symphony-v1/PRD.md`

### Related Tasks

- **Depends on**: linear-client.md, claude-event-mapping.md, workspace-manager.md, logger-service.md.
- **Blocks**: orchestrator-dispatch.md, orchestrator-reconcile.md, orchestrator-retry-and-tick.md, http-api-and-dashboard.md.

## Acceptance Criteria

- [ ] `OrchestratorRuntimeState` type matches spec §4.1.8 with our internal `claude_*` token field names:
  ```ts
  type OrchestratorRuntimeState = {
    readonly poll_interval_ms: number
    readonly max_concurrent_agents: number
    readonly running: ReadonlyMap<IssueId, RunningEntry>
    readonly claimed: ReadonlySet<IssueId>
    readonly retry_attempts: ReadonlyMap<IssueId, RetryEntry>
    readonly completed: ReadonlySet<IssueId>
    readonly claude_totals: { input_tokens: number; output_tokens: number; total_tokens: number; seconds_running: number }
    readonly claude_rate_limits: RateLimitInfo | null
  }
  ```
- [ ] `RunningEntry` matches §4.1.5 + §4.1.6 in shape (issue snapshot, started_at, session_id, thread_id, last_event/timestamp/message, token counters incl. last_reported, retry_attempt, turn_count).
- [ ] `RetryEntry` matches §4.1.7 (`issue_id`, `identifier`, `attempt`, `due_at_ms`, `timer_handle`, `error`). `timer_handle` is `Fiber.Fiber<void>`.
- [ ] `OrchestratorEvent` is a tagged union of:
  - `PollTick`
  - `WorkerStarted({ issue, runningEntry })`
  - `WorkerEventReceived({ issue_id, event: RuntimeEvent })` — from EventMapping.
  - `WorkerExited({ issue_id, reason: "normal" | "abnormal", error?: string })`
  - `RetryTimerFired({ issue_id, attempt })`
  - `ReconciliationStateRefresh({ refreshed: ReadonlyArray<MinimalIssue> })`
  - `StallDetected({ issue_id })`
  - `WorkflowReloaded({ definition })` — from WorkflowLoader.
  - `ImmediateTickRequested` — from HTTP /api/v1/refresh.
- [ ] `reduce(state, event): { state, sideEffects }` is a pure function. `sideEffects` is a discriminated union of intents the runtime should execute (`DispatchWorker`, `InterruptWorker`, `ScheduleRetry`, `CancelRetry`, `CleanupWorkspace`, `Log`, `EmitMetric`). The fiber that drives the orchestrator (in `orchestrator-retry-and-tick.md`) interprets these.
- [ ] Initial state factory: `initialState(config): OrchestratorRuntimeState` populates `poll_interval_ms` and `max_concurrent_agents` from current `TypedConfig`, empty collections, zero totals, null rate limits.
- [ ] On `WorkflowReloaded`: update `poll_interval_ms` and `max_concurrent_agents` (spec §6.2). Do NOT cancel in-flight workers (§6.2: "Implementations are not REQUIRED to restart in-flight agent sessions automatically").
- [ ] Convention: `state.claude_totals.seconds_running` is incremented by `running_entry.started_at`'s elapsed time when `WorkerExited` fires (§13.5 "Add run duration seconds to the cumulative ended-session runtime when a session ends").
- [ ] All state mutations route through one consumer fiber that reads `OrchestratorEvent`s off a `Queue` and applies the reducer. This realizes spec §7's "single authority".

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `src/orchestrator/State.ts` | Create | The state types + reducer. |
| `src/orchestrator/events.ts` | Create | `OrchestratorEvent` union + smart constructors. |
| `src/orchestrator/sideEffects.ts` | Create | `SideEffect` union + smart constructors. |

### Technical Constraints

- Pure reducer; no Effect dependency.
- `Map`/`Set` are intentionally immutable on the type level (`ReadonlyMap`/`ReadonlySet`); use `effect`'s `HashMap`/`HashSet` for performance if it matters, or just clone-on-write at v1 scale (~10 concurrent issues max).
- Match `effect`'s `Match.value(event).pipe(Match.tagsExhaustive({…}))` so an unhandled event type is a compile error.
- Don't bake §8.2 candidate selection logic into the reducer; that's `orchestrator-dispatch.md`. The reducer just records claims, dispatches, exits.

### Relevant Code References

- Spec §4.1.5–§4.1.8 (entity shapes), §7.3 (transition triggers), §8 (poll/scheduling).
- `claude-event-mapping.md` — what `RuntimeEvent` looks like.

## Testing Requirements

- [ ] Reducer is exhaustive over event variants (compile-time check).
- [ ] `WorkerStarted` adds to `running` and `claimed`, removes from `retry_attempts`.
- [ ] `WorkerExited(normal)` removes from `running`, adds to `completed`, schedules a continuation retry (attempt 1, 1s delay) via a `ScheduleRetry` side effect.
- [ ] `WorkerExited(abnormal)` removes from `running`, schedules exponential-backoff retry.
- [ ] `RetryTimerFired` removes the retry entry (caller fetches state by ID and decides if re-dispatch).
- [ ] `ReconciliationStateRefresh` with terminal issue produces an `InterruptWorker` + `CleanupWorkspace` side effect.
- [ ] `WorkflowReloaded` updates poll interval and concurrency but doesn't touch `running`.

## Out of Scope

- The fiber that runs the reducer loop (separate task).
- Side-effect interpretation (separate task — but the side-effect types live here).
- Persistence of state across restarts.
