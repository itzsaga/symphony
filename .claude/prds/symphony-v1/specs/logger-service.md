# Logger service

## Objective

Implement `Logger` as an Effect service that writes structured JSONL records to stderr and keeps the most-recent N (default 500) records in an in-memory ring buffer that the HTTP dashboard reads. All log lines are valid JSON; the operator can pipe stderr to `jq` without preprocessing.

## Context

### Parent PRD

- **PRD**: Symphony v1 (Effect.ts + Claude Code)
- **PRD Path**: `.claude/prds/symphony-v1/PRD.md`

### Related Tasks

- **Depends on**: Bun + TypeScript + Effect setup.
- **Blocks**: every service that logs (i.e. all of them); also blocks the HTTP dashboard task (it reads the ring buffer).

## Acceptance Criteria

- [ ] Exposes a `Context.Tag<Logger>` with methods `info(payload)`, `warn(payload)`, `error(payload)`, `debug(payload)` returning `Effect<void>`. Payload is `Record<string, unknown>`.
- [ ] Each emitted record includes: `timestamp` (ISO-8601 UTC), `level` (`debug|info|warn|error`), and the payload keys merged in.
- [ ] Context fields supported: when called from inside an Effect that has set `Logger.withIssue({ issue_id, issue_identifier })` (a helper this task creates) or `Logger.withSession({ session_id })`, those fields are merged into every emitted record while that Effect runs. Implemented via `FiberRef` so the context is scoped, not global.
- [ ] Ring buffer: configurable size (default 500), exposed as `Logger.recentEvents: Effect<ReadonlyArray<LogRecord>>`. Read-only access for the HTTP dashboard.
- [ ] Stderr write is synchronous (single `process.stderr.write` per record + `"\n"`). If stderr is closed/broken, swallow the error and continue (spec §13.2: "logging sink failures do not crash orchestration").
- [ ] Layer `LoggerLive` constructs the FiberRef'd context plus the ring buffer (an `Effect.Ref<CircularBuffer>`).
- [ ] A 2-line file-header comment per CLAUDE.md.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `src/observability/Logger.ts` | Create | Logger service + LoggerLive Layer + `withIssue`/`withSession` helpers + `LogRecord` schema. |

### Technical Constraints

- Use `Effect.Service` or `Context.Tag` (whichever idiom the project converges on; pick one and stick to it). Default to `Context.Tag` per PRD's Architecture sketch.
- Never log API tokens or secret env values (spec §15.3). The Logger itself can't enforce this — but document the rule and treat any caller that passes a `Bearer …` value as a bug.
- The ring buffer should drop the oldest record on overflow (FIFO).
- JSON serialization must handle `undefined` (drop the field) and circular refs (use `JSON.stringify` with a replacer that catches the `TypeError` and substitutes `"<circular>"`).

### Relevant Code References

- PRD §Architecture → "Logger service (stderr JSONL + ring buffer)" — confirms the design.
- Spec §13.1 — required context fields `issue_id`, `issue_identifier`, `session_id`. §13.2 — sink failures must not crash. §15.3 — secret handling.

### Code Examples

```ts
// Sketch of the API
const program = Effect.gen(function*() {
  const log = yield* Logger
  yield* log.info({ msg: "service starting", port: 8080 })
  yield* Effect.scoped(
    Effect.gen(function*() {
      // Inside this scope all logs have issue_id / issue_identifier merged in.
      const log2 = yield* Logger
      yield* log2.info({ msg: "dispatching" })
    }).pipe(Logger.withIssue({ issue_id: "abc", issue_identifier: "MT-1" }))
  )
})
```

## Testing Requirements

- [ ] Unit test: emitting records produces parseable JSON lines on a captured `Writable`.
- [ ] Unit test: scoped context (`withIssue`) merges fields only within the scope.
- [ ] Unit test: ring buffer drops oldest when full.
- [ ] Unit test: a stderr write failure does not abort the parent fiber.

## Out of Scope

- Multiple log sinks. Single sink (stderr) is the v1 decision.
- Pretty-printing for terminal humans. They can pipe to `jq`.
- Log rotation. Operator's job if they redirect stderr to a file.
- Sampling / rate-limiting.
