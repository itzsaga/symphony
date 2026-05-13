# Section 17.8 real Linear integration profile

## Objective

Implement the §17.8 "Real Integration Profile" — gated tests that exercise the LinearClient and the orchestrator end-to-end against a real Linear API. Skipped (with explicit "skipped" status) when `LINEAR_API_KEY` is unset. Tracker artifacts cleaned up after each run.

## Context

### Parent PRD

- **PRD**: Symphony v1 (Effect.ts + Claude Code)
- **PRD Path**: `.claude/prds/symphony-v1/PRD.md`

### Related Tasks

- **Depends on**: section-17-audit.md (unit tests must be green first), every implementation task.
- **Blocks**: nothing; this is the final acceptance gate.

## Acceptance Criteria

- [ ] `test/integration/linear-real.test.ts` exists and runs only when `LINEAR_API_KEY` is set in the env.
- [ ] When the key is absent: tests are reported as `skipped` (not silently passing). `bun test` output includes a clear `skipped: real Linear integration (set LINEAR_API_KEY)` line.
- [ ] When the key is present and `SYMPHONY_INTEGRATION_TESTS=enabled` env flag is set, failures fail the test run (per §17.8 "If a real-integration profile is explicitly enabled in CI or release validation, failures SHOULD fail that job").
- [ ] Tests cover:
  - `fetchCandidateIssues` returns at least one issue for a test-project slug that has known Todo/In-Progress test issues.
  - `fetchIssuesByStates(["Done"])` returns terminal issues.
  - `fetchIssueStatesByIds([known_id])` returns the expected state.
  - `LinearClient.executeRaw` round-trip: a no-op `query { viewer { id email } }` returns the expected shape.
  - End-to-end smoke: spawn the orchestrator against a test workflow with the real Linear key, observe at least one issue dispatch + at least one Claude turn complete + HTTP `/api/v1/state` reflects the running session, then clean shutdown.
- [ ] Cleanup: any issues / comments / labels created during the test run are deleted in `afterAll`. Identifiers are namespaced (`symphony-integration-<timestamp>`) so partial cleanups don't collide.
- [ ] Documentation: `test/integration/README.md` explains how to bootstrap the test Linear project, what `LINEAR_API_KEY` permissions are needed, what `SYMPHONY_INTEGRATION_TESTS=enabled` does.
- [ ] A `~/.linear_api_key` fallback (§17.8 "valid credentials supplied by `LINEAR_API_KEY` or a documented local bootstrap mechanism (for example `~/.linear_api_key`)") is supported: if the env var is absent, read the first line of `~/.linear_api_key`.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `test/integration/linear-real.test.ts` | Create | The integration suite. |
| `test/integration/setup.ts` | Create | API-key resolution, test-project slug, cleanup harness. |
| `test/integration/README.md` | Create | Operator-facing docs for running the suite. |
| `package.json` | Edit | Add `test:integration` script. |

### Technical Constraints

- Use `bun test`'s native `.skipIf(condition)` (or whatever the equivalent is). Don't silently pass — the skip must be visible in output.
- The end-to-end smoke test uses a tiny dedicated test project on Linear. Don't run against personal/production projects.
- Workspace root for the integration suite goes under `<system-temp>/symphony_integration_workspaces/` to keep it separate from dev workspaces. Cleaned up in `afterAll`.
- The Claude subprocess in the smoke test should run with `--max-turns 2` to keep cost bounded.
- All HTTP requests have explicit timeouts (per LinearClient's 30s contract).

### Relevant Code References

- Spec §17.8 (entire bullet list), §11 (Linear contract), §11.5 (write boundary).
- `linear-client.md`, `application-wiring.md`.

## Testing Requirements

- [ ] Suite reports `skipped` when LINEAR_API_KEY unset.
- [ ] Suite runs when LINEAR_API_KEY set; passes against a known-good test project.
- [ ] All created test artifacts are cleaned up; rerunning the suite produces zero leftover issues.
- [ ] `SYMPHONY_INTEGRATION_TESTS=enabled` mode treats skips as failures (regression catch for CI).

## Out of Scope

- Continuous integration setup. This task lands the tests; CI configuration is a separate concern.
- Multi-account / multi-organization Linear testing.
- Soak / load testing (running the orchestrator for hours).
- Adversarial / malicious-input testing (e.g. prompt injection in issue titles).
