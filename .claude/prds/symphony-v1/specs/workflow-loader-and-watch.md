# WorkflowLoader service with file watch

## Objective

Wrap the pure `parseWorkflow` in an Effect service that holds the current effective `WorkflowDefinition` in a `SubscriptionRef`, watches the file for changes, and re-parses + broadcasts on every change. Invalid reloads keep the last-known-good (§6.2).

## Context

### Parent PRD

- **PRD**: Symphony v1 (Effect.ts + Claude Code)
- **PRD Path**: `.claude/prds/symphony-v1/PRD.md`

### Related Tasks

- **Depends on**: workflow-schema-and-parser.md, logger-service.md.
- **Blocks**: orchestrator-state.md, orchestrator-retry-and-tick.md, http-server-setup.md, application-wiring.md.

## Acceptance Criteria

- [ ] `WorkflowLoader` `Context.Tag` exposes:
  - `current: Effect<WorkflowDefinition>` — current effective definition (last known good).
  - `changes: Stream<WorkflowDefinition>` — emits on every successful reload.
  - `validateForDispatch: Effect<void, ValidationError>` — re-runs §6.3 preflight.
- [ ] `WorkflowLoaderLive` Layer:
  - On startup: loads + parses + validates (§16.1 startup); fails startup with operator-visible error if invalid (§6.3).
  - Forks a fiber that watches `source_path` (Node/Bun `fs.watch`) and re-parses on change.
  - Invalid reload: logs warn, keeps prior `WorkflowDefinition`, emits operator-visible error (§6.2).
  - Valid reload: replaces `SubscriptionRef`, emits on `changes` stream, logs info with diff summary.
  - Layer is `Layer.scopedDiscard` so the watcher fiber is interrupted on shutdown.
- [ ] Defensive re-validation hook used by Orchestrator before each dispatch (§6.3 / §6.2: "Implementations SHOULD also re-validate/reload defensively during runtime operations in case filesystem watch events are missed").
- [ ] Watch the *file's parent directory*, not just the file, to handle editors that rename-on-save (vim, etc.). Filter events to the watched filename.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `src/config/WorkflowLoader.ts` | Create | The service + Live Layer + fs.watch fiber. |

### Technical Constraints

- Use `SubscriptionRef` (from `effect`) so HTTP/Orchestrator can subscribe to changes via `changes` stream.
- Debounce file events with a short window (250ms) — editors fire multiple events per save.
- Don't use `chokidar` or other deps; Bun's native `fs.watch` is sufficient.
- Symlink-followed paths: resolve `realpath` once on startup; watch the resolved target.
- Don't tear down running agent fibers on reload — §6.2: "Implementations are not REQUIRED to restart in-flight agent sessions automatically".

### Relevant Code References

- Spec §6.2 (dynamic reload semantics), §6.3 (dispatch preflight), §5.5 (error surface), §16.1 (start_service references `start_workflow_watch(on_change=reload_and_reapply_workflow)`).

### Code Examples

```ts
// Sketch
interface WorkflowLoader {
  readonly current: Effect.Effect<WorkflowDefinition>
  readonly changes: Stream.Stream<WorkflowDefinition>
  readonly validateForDispatch: Effect.Effect<void, ValidationError>
}
```

## Testing Requirements

- [ ] Initial load succeeds; `current` returns the parsed definition.
- [ ] Touching the watched file with valid content emits on `changes` and updates `current`.
- [ ] Touching the watched file with invalid content does NOT update `current` (last-known-good preserved) and emits a warn log.
- [ ] Validate preflight detects missing `tracker.api_key` after `$VAR` resolution.
- [ ] Watcher fiber is interrupted when the Layer scope closes (no fd leak).

## Out of Scope

- Watching `.env` files for `$VAR` env changes. Env is read at parse time only.
- Hot-rebinding the HTTP listener port (§6.2 allows restart-required for HTTP).
- Cross-file workflow includes / imports. Single-file only.
