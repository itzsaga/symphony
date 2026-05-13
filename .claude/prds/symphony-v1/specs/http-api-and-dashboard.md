# JSON API and dashboard

## Objective

Implement the spec §13.7 routes — `GET /`, `GET /api/v1/state`, `GET /api/v1/<identifier>`, `POST /api/v1/refresh` — backed by `OrchestratorRuntimeState` and the Logger's ring buffer. The dashboard is server-rendered HTML; the JSON API is documented in §13.7.

## Context

### Parent PRD

- **PRD**: Symphony v1 (Effect.ts + Claude Code)
- **PRD Path**: `.claude/prds/symphony-v1/PRD.md`

### Related Tasks

- **Depends on**: http-server-setup.md, orchestrator-retry-and-tick.md, logger-service.md.
- **Blocks**: nothing further; this is a leaf consumer.

## Acceptance Criteria

- [ ] `GET /` returns a server-rendered HTML page (Content-Type `text/html; charset=utf-8`) depicting:
  - Counts: running / retrying.
  - A table of running sessions with identifier, state, session_id, turn_count, last_event, last_event_at, tokens.
  - A table of retry queue entries with identifier, attempt, due_at, error.
  - Aggregate token totals + cumulative runtime seconds.
  - Latest rate-limit info (if any).
  - Recent events from Logger's ring buffer (last 50).
  - Auto-refresh tag (`<meta http-equiv="refresh" content="5">`) so the operator-facing view stays current without JS.
- [ ] `GET /api/v1/state` returns the §13.7.1 shape exactly:
  ```json
  {
    "generated_at": "<ISO-8601>",
    "counts": { "running": N, "retrying": N },
    "running": [{ "issue_id", "issue_identifier", "state", "session_id", "turn_count", "last_event", "last_message", "started_at", "last_event_at", "tokens": { "input_tokens", "output_tokens", "total_tokens" } }, …],
    "retrying": [{ "issue_id", "issue_identifier", "attempt", "due_at", "error" }, …],
    "codex_totals": { "input_tokens", "output_tokens", "total_tokens", "seconds_running" },
    "rate_limits": …
  }
  ```
  Field name `codex_totals` is spec-mandated (§13.7.1 example). Internally we track `claude_*`; rename at this boundary.
- [ ] `GET /api/v1/<identifier>` returns the §13.7.2 shape with `issue_identifier`, `issue_id`, `status` (`"running" | "retrying" | "unknown"`), `workspace.path`, `attempts.{restart_count, current_retry_attempt}`, `running` (if active), `retry` (if retrying), `logs.codex_session_logs` (empty array in v1 — we don't persist session logs to file), `recent_events` (last 50 events for this issue, filtered from the Logger ring buffer by `issue_id`), `last_error`, `tracked` (empty object placeholder).
- [ ] `GET /api/v1/<identifier>` for unknown identifier returns `404` with `{"error":{"code":"issue_not_found","message":"…"}}`.
- [ ] `POST /api/v1/refresh` enqueues `ImmediateTickRequested` into the orchestrator queue and returns `202` with the §13.7.2 example response `{ "queued": true, "coalesced": false, "requested_at": "…", "operations": ["poll", "reconcile"] }`. Coalesce repeated requests within a 1s window (return `coalesced: true` for the duplicates).
- [ ] Unsupported methods on defined routes return `405` with `Allow` header.
- [ ] API errors use `{ "error": { "code", "message" } }` JSON envelope (§13.7 "API errors SHOULD use a JSON envelope").

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `src/http/Api.ts` | Create | The four route handlers. |
| `src/http/Dashboard.ts` | Create | Server-side HTML rendering for `/`. |
| `src/http/snapshot.ts` | Create | `OrchestratorRuntimeState → ApiState` translator (does the `claude_* → codex_*` rename + ISO-8601 timestamps). |

### Technical Constraints

- HTML escaping: every string interpolated into the dashboard HTML goes through an `escapeHtml` helper. No template engine; tagged-template-literal `html\`...\`` style is fine.
- ISO-8601 timestamps via `Date.toISOString()`.
- The `codex_totals` field name (and any other `codex_*` field the spec example uses) is spec-mandated; document the rename clearly in code comments.
- `recent_events` per issue: filter the Logger ring buffer by `issue_id`. Capped at 50.
- POST /refresh coalescing: hold an `Effect.Ref<{ lastQueuedAt: Date | null }>`. Within 1s of last queue, return `coalesced: true` and don't enqueue.

### Relevant Code References

- Spec §13.7.1 / §13.7.2 (exact response shapes), §13.3 (runtime snapshot RECOMMENDED fields).
- `orchestrator-retry-and-tick.md` — the orchestrator interface this consumes.
- `logger-service.md` — the ring buffer this reads.

## Testing Requirements

- [ ] `GET /api/v1/state` returns the spec-example fields and the rename is correct.
- [ ] `GET /api/v1/<known-identifier>` returns 200 with the running view.
- [ ] `GET /api/v1/<retrying-identifier>` returns 200 with the retry view (no `running` field).
- [ ] `GET /api/v1/<unknown>` returns 404 with the error envelope.
- [ ] `POST /api/v1/refresh` enqueues an immediate tick; second `POST` within 1s gets `coalesced: true`.
- [ ] `PATCH /api/v1/refresh` returns 405 with `Allow: POST`.
- [ ] `GET /` returns HTML containing the running-table when a session is active.
- [ ] HTML is correctly escaped against XSS (issue title with `<script>` not rendered as a tag).

## Out of Scope

- WebSocket / SSE push (the dashboard polls via meta-refresh in v1).
- A client-side JS dashboard. Pure server-rendered HTML.
- Authentication/authorization. Loopback bind is the boundary.
- Pagination on `recent_events`. Cap at 50 and that's the v1 answer.
- An OpenAPI spec. The shape lives in `SPEC.md` §13.7.
