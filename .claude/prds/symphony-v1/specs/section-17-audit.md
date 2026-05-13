# Section 17.1-17.7 coverage audit

## Objective

Cross-check every bullet in spec §17.1 through §17.7 against the actual test suite. For each bullet without coverage, add a test. Produce a checklist mapping each §17.x bullet to the test file/case that covers it, committed at `test/section-17-coverage.md`. This is the conformance gate.

## Context

### Parent PRD

- **PRD**: Symphony v1 (Effect.ts + Claude Code)
- **PRD Path**: `.claude/prds/symphony-v1/PRD.md`

### Related Tasks

- **Depends on**: every other implementation task (per-component unit tests should already be in place from each component's spec; this task audits gaps and fills them).
- **Blocks**: linear-integration-profile.md.

## Acceptance Criteria

- [ ] `test/section-17-coverage.md` exists. Format:
  ```markdown
  # §17 Test Coverage Audit

  Generated against SPEC.md §17 as of `<commit-sha>`.

  ## §17.1 Workflow and Config Parsing
  - [ ] Workflow file path precedence (explicit > cwd default)
    - `test/unit/config/parseWorkflow.test.ts > workflow path precedence`
  - [ ] Workflow file changes detected and trigger re-read/re-apply without restart
    - `test/unit/config/WorkflowLoader.test.ts > re-applies on change`
  …
  ```
- [ ] Each §17.x bullet (across §17.1, §17.2, §17.3, §17.4, §17.5, §17.6, §17.7) maps to at least one test file/case. Bullets gated by "If X is implemented" are required (we ship the HTTP server, the `linear_graphql` tool, humanized event summaries we don't ship — explicitly mark "not implemented" rows as such).
- [ ] If a bullet lacks coverage at audit time: write the test, then check the box.
- [ ] Audit script: `scripts/audit-section-17.sh` (or a bun script) that re-runs the cross-check and fails if any bullet's mapped test doesn't exist or doesn't run.
- [ ] All tests run under `bun test`.
- [ ] All tests in this audit pass on a clean checkout in the Nix dev shell.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `test/section-17-coverage.md` | Create | The checklist + audit format. |
| `scripts/audit-section-17.{ts,sh}` | Create | Verification script. |
| `test/unit/**/*.test.ts` | Edit | Fill any gaps the audit reveals. |

### Technical Constraints

- The mapping format is one bullet per markdown checkbox line, with the test path on the next indented line. Machine-parseable.
- The audit script greps each referenced test file for the test name and confirms its presence (NOT its passing — `bun test` confirms passing).
- "Not implemented" bullets (e.g. §17.6 humanized event summaries) are listed explicitly with `<!-- not implemented -->` rather than checked off.

### Relevant Code References

- Spec §17 (entire section).
- The PRD's "Test framework" decision: `bun test` + `@effect/vitest`.

## Testing Requirements

- [ ] Running `bun run audit:section-17` exits 0 when every required bullet has a matching test.
- [ ] Removing a referenced test causes the audit to fail with a clear "missing test for §17.x bullet" message.
- [ ] The dashboard `/api/v1/state` shape matches the spec example (§17.4 "If a snapshot API is implemented" bullets).
- [ ] `linear_graphql` tool extension bullets in §17.5 are exercised.

## Out of Scope

- §17.8 real integration tests (separate task: linear-integration-profile.md).
- Performance/load testing.
- Mutation testing or property-based testing.
- Cross-platform CI matrix.
