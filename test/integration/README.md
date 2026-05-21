# Integration tests

This directory holds Symphony's integration tests. There are two suites with
very different shapes:

- **`startup.test.ts`** — always runs. Spawns `src/main.ts` as a child Bun
  process with a fake Linear key to exercise startup, signals, HTTP bring-up,
  and SIGTERM teardown. No external services required.
- **`linear-real.test.ts`** — the §17.8 Real Integration Profile. Gated on
  `LINEAR_API_KEY`. When the key is absent, every case is reported skipped.
  When the key is present, the suite talks to a real Linear workspace and
  spawns the daemon end-to-end against the real `claude` CLI.

The rest of this document describes how to bootstrap the real-integration
profile.

## Running the suites

```sh
# Both suites; linear-real will skip cleanly if no key is available.
nix develop --command bun test test/integration/

# Just the integration directory, via the npm script:
nix develop --command bun run test:integration

# Force-fail the run on integration-test failures (CI mode):
SYMPHONY_INTEGRATION_TESTS=enabled nix develop --command bun run test:integration
```

## Gating

The suite resolves the Linear API key in this order:

1. The `LINEAR_API_KEY` env var (preferred — CI sets this).
2. The first line of `~/.linear_api_key` (developer ergonomics fallback,
   named verbatim in spec §17.8).

If neither yields a non-empty string, every case in `linear-real.test.ts`
runs through `it.skipIf` and is reported as skipped. The suite also writes
a single banner line to stderr — `skipped: real Linear integration (set
LINEAR_API_KEY)` — so the reason is unambiguous in the test output.

`SYMPHONY_INTEGRATION_TESTS=enabled` is the canonical CI knob. Per spec
§17.8: "If a real-integration profile is explicitly enabled in CI or
release validation, failures SHOULD fail that job." `bun test` always
fails the run on a real test failure, so the flag is currently
informational — but downstream wrappers (CI scripts) MAY consult it to
decide whether to treat the absence of the key as a hard failure.

## Bootstrap: required Linear shape

The suite assumes a small dedicated Linear project. Do **not** point it at
your team's real project — the smoke test will dispatch the daemon against
whatever Todo / In-Progress issues it finds there.

1. **Create a project** with a memorable slug (default
   `symphony-integration`). The slug is what Linear shows in the URL bar
   after `/projects/`. Override the default with
   `SYMPHONY_INTEGRATION_PROJECT_SLUG=my-slug` if you prefer a different
   value.

2. **Seed at least one fixture issue** with state `Todo` or `In Progress`.
   This is what `fetchCandidateIssues` returns and what the orchestrator
   smoke dispatches against. A single issue with a one-line description is
   enough — the prompt template instructs Claude to respond with `"done"`
   and exit, so the issue contents don't matter.

3. **(Optional) Seed a `Done` issue** so the
   `fetchIssuesByStates(["Done"])` test exercises a non-empty terminal
   sweep. The test does not require this — an empty result is treated as
   a passing shape check.

4. **(Optional) Set `SYMPHONY_INTEGRATION_TEAM_ID`** if you plan to extend
   the suite with mutation-driven tests. The base profile does not need it.

## Required API key permissions

The Linear API key needs:

- **Read** access on the test project — for `fetchCandidateIssues`,
  `fetchIssuesByStates`, `fetchIssueStatesByIds`, and the `viewer` query.
- **Read** access on at least one workflow state matching the configured
  `active_states` (`Todo`, `In Progress`) and on the `terminal_states`
  (`Done` is the one the suite touches).

Mutation scopes are only needed if the operator extends the suite with
tests that create issues / comments / labels (the cleanup harness uses
`issueArchive`, `commentDelete`, and `issueLabelArchive` against any IDs
recorded via `recordForCleanup`). The base profile in this repo does not
create artifacts, so a read-only key is sufficient.

Personal API keys (Settings → API → Personal API keys in Linear) work
fine. OAuth bot tokens would also work; the suite has not been tested
against them.

## Environment variables, full reference

| Variable                                  | Purpose                                                                | Default                            |
| ----------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------- |
| `LINEAR_API_KEY`                          | Linear API key. Absence → suite skips.                                 | _(none)_                           |
| `SYMPHONY_INTEGRATION_TESTS`              | Set to `enabled` to mark the run as a CI / release validation profile. | _(unset)_                          |
| `SYMPHONY_INTEGRATION_PROJECT_SLUG`       | `slugId` of the Linear project that contains the fixture issues.       | `symphony-integration`             |
| `SYMPHONY_INTEGRATION_TEAM_ID`            | Optional team ID for mutation-driven tests.                            | _(none)_                           |
| `SYMPHONY_INTEGRATION_LINEAR_ENDPOINT`    | Override the Linear GraphQL endpoint.                                  | `https://api.linear.app/graphql`   |

## Cleanup contract

Every artifact a test creates is recorded in a module-level registry via
`recordForCleanup(kind, id, label)`. The `afterAll` hook drains the
registry and archives / deletes every recorded artifact, then removes the
ephemeral workspace root under `<system-temp>/symphony_integration_workspaces/`.

Per-entry cleanup failures are logged to stderr but do **not** fail the
run — the artifact may have already been removed by hand or by a previous
attempt. Inspect stderr after the run if you want to confirm no leftovers
remain.

Identifiers created by the suite use the prefix
`symphony-integration-<timestamp>` so a partial cleanup from an aborted
prior run does not collide with the current run.

## Cost note

The end-to-end smoke spawns the real `claude` CLI with `max_turns: 2`. A
single run costs on the order of one or two Claude turns — small, but not
free. Run the smoke deliberately, not on every commit.
