# Retry + tick fiber

## Objective

Implement the §8.4 retry/backoff machinery using Fiber-based timers, and the §8.1 poll tick that drives the orchestrator end-to-end (reconcile → preflight → fetch candidates → dispatch → notify). Wires together everything: state reducer, dispatch selection, reconciliation, LinearClient, WorkflowLoader, WorkspaceManager, WorkspaceHooks, ClaudeSubprocess, EventMapping.

## Context

### Parent PRD

- **PRD**: Symphony v1 (Effect.ts + Claude Code)
- **PRD Path**: `.claude/prds/symphony-v1/PRD.md`

### Related Tasks

- **Depends on**: orchestrator-state.md, orchestrator-dispatch.md, orchestrator-reconcile.md, linear-client.md, workflow-loader-and-watch.md, workspace-manager.md, workspace-hooks.md, claude-subprocess-lifecycle.md, claude-event-mapping.md, mcp-server-and-linear-graphql.md, logger-service.md.
- **Blocks**: application-wiring.md, http-api-and-dashboard.md (HTTP /refresh injects ImmediateTickRequested).

## Acceptance Criteria

- [ ] `Orchestrator` `Context.Tag` exposing:
  - `state: Effect<OrchestratorRuntimeState>` and `stateChanges: Stream<OrchestratorRuntimeState>` — for HTTP snapshots/subscriptions.
  - `enqueue(event: OrchestratorEvent): Effect<void>` — entry point for external triggers (HTTP `/refresh` → `ImmediateTickRequested`, WorkflowLoader → `WorkflowReloaded`).
- [ ] `OrchestratorLive` Layer:
  - Builds the initial state from `WorkflowLoader.current`.
  - Forks the **consumer fiber** that drains an internal `Queue<OrchestratorEvent>` and applies `reduce` from `orchestrator-state.md`. Interprets returned side effects:
    - `DispatchWorker(issue)` → fork a worker fiber (sequence below).
    - `InterruptWorker(issue_id)` → `Fiber.interrupt` on the running worker's fiber.
    - `ScheduleRetry({ issue_id, attempt, delay_ms })` → fork a retry fiber `Effect.sleep(delay_ms) *> enqueue(RetryTimerFired)`; store in `state.retry_attempts[issue_id].timer_handle`. Cancel any prior timer first via `Fiber.interrupt`.
    - `CancelRetry(issue_id)` → `Fiber.interrupt` on the stored timer handle.
    - `CleanupWorkspace(identifier)` → `WorkspaceHooks.runBeforeRemove` then `WorkspaceManager.cleanWorkspaceFor`.
    - `UpdateIssueSnapshot({ issue_id, issue })` → applied by the next event; the side-effect interpreter is essentially the reducer's I/O arm.
    - `Log(level, payload)` → `Logger`.
  - Forks the **tick fiber**: every `state.poll_interval_ms`, enqueues `PollTick`. On `ImmediateTickRequested` event, performs the tick immediately and resets the next-tick countdown.
  - Forks a **workflow-reload subscriber** on `WorkflowLoader.changes` that enqueues `WorkflowReloaded`.
- [ ] `PollTick` handler (sequence from §8.1 / §16.2):
  1. Reconcile (Part A stalled detection, then candidate-state refresh fetch, then Part B tracker reconcile).
  2. `WorkflowLoader.validateForDispatch`. If validation fails, log + skip dispatch but keep reconciling next time (§6.3).
  3. `LinearClient.fetchCandidateIssues`. On failure: log + skip dispatch (§14.2).
  4. `selectDispatchBatch` (orchestrator-dispatch.md) → enqueue `DispatchWorker` side effects.
- [ ] Worker fiber pipeline (`DispatchWorker(issue)` side effect):
  1. `WorkspaceManager.prepareForIssue(issue)` → `Workspace`.
  2. If `Workspace.created_now`, `WorkspaceHooks.runAfterCreate(workspace)`. Failure → fail worker.
  3. `Prompt.renderPrompt(template, { issue, attempt: retry_attempt })` → string.
  4. Loop until `turn_count >= config.agent_runner.max_turns` or refreshed issue state goes non-active:
     a. `WorkspaceHooks.runBeforeRun(workspace)`. Failure → fail worker.
     b. `ClaudeSubprocess.spawn(...)` (first turn) OR send next user message on the existing subprocess (continuation turns). The runner emits frames; the event-mapping consumes them; events are enqueued into the orchestrator queue.
     c. Wait for `TurnCompleted` (success) or `TurnFailed`/`TurnInputRequired` (failure). Failure → break with `WorkerExited(abnormal)`.
     d. `WorkspaceHooks.runAfterRun(workspace)` (best-effort).
     e. `LinearClient.fetchIssueStatesByIds([issue.id])` → refresh. Failure → break with abnormal.
     f. If refreshed state not active → break (normal).
     g. Otherwise, increment turn_count, build continuation prompt, loop.
  5. Stop the Claude subprocess (closes stdin, awaits up to 5s graceful exit).
  6. `WorkspaceHooks.runAfterRun(workspace)` if not run for the last turn.
  7. Enqueue `WorkerExited(normal | abnormal, error?)`.
- [ ] Retry/backoff (§8.4):
  - Continuation retry (after normal exit): `delay = 1000` ms, attempt = 1.
  - Failure retry: `delay = min(10000 * 2^(attempt-1), config.agent_runner.max_retry_backoff_ms)`.
  - Cancel-then-set on existing retry (interrupt the prior timer fiber first).
- [ ] Retry-timer-fired handler (§16.6):
  1. Remove the retry entry from state.
  2. Re-fetch candidates.
  3. If issue not present → release claim.
  4. If no slots → re-schedule with the same attempt+1.
  5. Otherwise dispatch with `attempt = retry_entry.attempt`.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `src/orchestrator/Orchestrator.ts` | Create | The Live Layer, consumer fiber, tick fiber, worker-fiber sequencer. |
| `src/orchestrator/Retry.ts` | Create | Pure backoff math + retry-fiber lifecycle helpers. |
| `src/orchestrator/Worker.ts` | Create | The per-issue worker pipeline (workspace → hooks → claude → loop). |

### Technical Constraints

- The consumer fiber processes events strictly serially. No parallel state mutations.
- The worker fiber feeds events back via the same queue. This is what makes the orchestrator the "single authority" (§7).
- Sleep for retry uses `Effect.sleep` (which respects `TestClock` in tests).
- Per-issue worker fibers are stored in `running[issue_id].worker_handle` so the side-effect interpreter can `Fiber.interrupt` them.
- Reconcile and dispatch use the SAME poll-tick fetch result for state refresh AND candidate selection where possible — but the spec separates them (`fetch_candidate_issues` vs `fetch_issue_states_by_ids`). Honor that.
- Token totals accumulation: when a worker exits, add `seconds_running` = `now - started_at` to `state.claude_totals.seconds_running` (§13.5).
- `WorkflowReloaded` updates poll interval; the tick fiber's loop must re-read poll_interval_ms each iteration.

### Relevant Code References

- Spec §7 (state machine), §8.1 (poll loop), §8.4 (retry/backoff), §8.5 (reconciliation), §16 (reference algorithms).

### Code Examples

```ts
// Retry backoff
const backoffMs = (attempt: number, cap_ms: number): number =>
  Math.min(10_000 * Math.pow(2, attempt - 1), cap_ms)

// Continuation
const continuationDelayMs = 1000
```

## Testing Requirements

- [ ] Backoff math: attempt 1 → 10s; attempt 2 → 20s; attempt 5 → 160s; cap respected.
- [ ] Continuation retry uses fixed 1s delay regardless of attempt.
- [ ] Cancel existing timer when scheduling new retry for same issue (Fiber.interrupt observed).
- [ ] Tick fiber respects `WorkflowReloaded` poll interval change at the next iteration.
- [ ] `ImmediateTickRequested` fires the tick within ms, not after the full poll interval.
- [ ] Slot exhaustion at retry time re-queues with `error: "no available orchestrator slots"`.
- [ ] Worker fiber happy-path: workspace → hooks → claude → result → exit normal → continuation retry scheduled.
- [ ] Worker fiber abnormal-exit: subprocess crashes → exit abnormal → exponential backoff retry scheduled.
- [ ] Stalled worker is interrupted on reconcile and retry scheduled.

## Out of Scope

- Persistence of retry timers across restart (§14.3 explicitly: not required).
- A priority-aware tick scheduler. Single poll interval for everyone.
- Per-issue progress callbacks beyond the event queue.
