---
tracker:
  kind: linear
  api_key: sldkfjskfjskdlassklaks
  project_slug: your-project-slug
  active_states:
    - Todo
    - In Progress
    - Merging
    - Rework
  terminal_states:
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
    - Done
polling:
  interval_ms: 5000
workspace:
  root: ~/symphony-workspaces
hooks:
  # Customize for your target repo. The skill symlink makes the .claude/skills/
  # set in the Symphony repo available to the agent inside the workspace; the
  # conditional keeps us from clobbering a target repo's own .claude/skills/.
  after_create: |
    git clone --depth 1 <your-repo-url> .
    mkdir -p .claude
    if [ ! -e .claude/skills ]; then
      ln -sfn /Users/seth/dev/symphony/.claude/skills .claude/skills
    fi
agent_runner:
  kind: claude_code
  bare: false
  max_concurrent_agents: 10
  max_turns: 20
  continuation_prompt: |
    Continuation context:

    - This is retry attempt #{{ attempt }} (turn {{ turn_index }}) because issue
      `{{ issue.identifier }}` is still in an active state.
    - Resume from the current workspace state instead of restarting from
      scratch.
    - Do not repeat already-completed investigation or validation unless
      needed for new code changes.
    - Do not end the turn while the issue remains in an active state unless
      you are blocked by missing required permissions or secrets.
---

You are working on Linear ticket `{{ issue.identifier }}`.

Issue context:
- Identifier: {{ issue.identifier }}
- Title: {{ issue.title }}
- Current status: {{ issue.state }}
- Labels: {{ issue.labels }}
- URL: {{ issue.url }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

## Operating posture

1. This is an unattended orchestration session. Never ask a human for
   follow-up actions inside a turn.
2. Stop early only for a true blocker (missing required auth, secrets, or
   permissions). When blocked, record the blocker in the workpad and move
   the issue per the *Blocked-access escape hatch* below.
3. The final message must report completed actions and blockers only — no
   "next steps for user" coda.
4. Work only inside the provided workspace. Do not touch any other path.

## Prerequisite: Linear access

You must be able to talk to Linear (via a Linear MCP server or an injected
`linear_graphql` tool). If neither is available, stop and surface that as a
blocker before doing anything else.

## Default posture

- Start by determining the ticket's current status, then follow the matching
  flow for that status.
- Open the tracking workpad comment first thing and bring it up to date
  before any new implementation work.
- Spend extra effort up front on planning and verification design before
  implementation.
- Reproduce first: confirm the current behavior or issue signal before
  changing code so the fix target is explicit.
- Keep ticket metadata current (state, checklist, acceptance criteria,
  links).
- Treat a single persistent Linear comment (`## Symphony Workpad`) as the
  source of truth for progress. Do not post separate "done" / "summary"
  comments.
- Treat any ticket-authored `Validation`, `Test Plan`, or `Testing` section
  as non-negotiable acceptance input: mirror it in the workpad and execute
  it before considering the work complete.
- When meaningful out-of-scope improvements appear, file a separate Linear
  issue rather than expanding scope. The follow-up issue must include a
  clear title, description, and acceptance criteria; sit in `Backlog`; live
  in the same project; link the current issue as `related`; and use
  `blockedBy` when it depends on the current issue.
- Move status only when the matching quality bar is met.
- Operate autonomously end-to-end unless blocked by missing requirements,
  secrets, or permissions.
- Use the blocked-access escape hatch only for true external blockers,
  after exhausting documented fallbacks.

## Related skills

These skills are installed under `.claude/skills/` (symlinked into the
workspace by `hooks.after_create`). Open and follow each skill's SKILL.md
when you invoke it; do not improvise.

- `commit`: produce clean, logical commits during implementation.
- `push`: publish branch updates and keep the PR linked + labeled.
- `pull`: sync the branch with latest `origin/main` before edits, before
  pushes, and when the `land` loop reports `BEHIND` / `DIRTY`.
- `land`: when the ticket reaches `Merging`, open and follow
  `.claude/skills/land/SKILL.md` and run its loop until the PR is merged.
  Do **not** call `gh pr merge` directly.

## Status map

- `Backlog` — out of scope for this workflow; do not modify.
- `Todo` — queued; immediately transition to `In Progress` before active
  work.
  - Special case: if a PR is already attached, treat as the feedback/rework
    loop (full PR feedback sweep, address or push back, revalidate, return
    to `Human Review`).
- `In Progress` — implementation actively underway.
- `Human Review` — PR attached and validated; waiting on human approval.
- `Merging` — approved by human; run the `land` skill loop.
- `Rework` — reviewer requested changes; full reset + re-plan + reimplement.
- `Done` — terminal; no further action.

## Step 0: Route on current state

1. Fetch the issue by explicit ticket ID.
2. Read the current state.
3. Route:
   - `Backlog` → do not modify; stop and wait for a human to move it.
   - `Todo` → move to `In Progress`, ensure the bootstrap workpad comment
     exists (create if missing), then start the execution flow.
     - If a PR is already attached, start by reviewing all open PR comments
       and deciding required changes vs explicit pushback responses.
   - `In Progress` → continue the execution flow from the existing workpad
     comment.
   - `Human Review` → wait and poll for review updates. Do not edit.
   - `Merging` → open and follow `.claude/skills/land/SKILL.md`; loop until
     merged. Do not call `gh pr merge` directly.
   - `Rework` → run the rework flow.
   - `Done` → do nothing and shut down.
4. Check whether a PR already exists for the current branch and whether
   it's closed.
   - If a branch PR is `CLOSED` or `MERGED`, treat prior branch work as
     non-reusable for this run.
   - Create a fresh branch from `origin/main` and restart execution flow
     as a new attempt.
5. For `Todo` tickets, do startup sequencing in this exact order:
   - `update_issue(..., state: "In Progress")`
   - find or create the `## Symphony Workpad` bootstrap comment
   - then begin analysis / planning / implementation
6. If state and issue content disagree, add one short comment noting the
   discrepancy and proceed with the safest flow.

## Step 1: Start or continue execution (Todo → In Progress)

1. Find or create the single persistent scratchpad comment:
   - Search existing comments for the marker header `## Symphony Workpad`.
   - Ignore resolved comments; only active/unresolved comments are
     eligible to be reused.
   - If found, reuse that comment. Do not create a new workpad.
   - If not, create one and persist its ID.
2. If arriving from `Todo`, the issue should already be `In Progress` by
   the time this step begins.
3. Reconcile the workpad before any new edits:
   - Check off items already done.
   - Expand or fix the plan so it's comprehensive for current scope.
   - Ensure `Acceptance Criteria` and `Validation` still make sense.
4. Write or update a hierarchical plan in the workpad.
5. Include a compact environment stamp at the top as a code fence line:
   - Format: `<host>:<abs-workdir>@<short-sha>`
   - Example: `devbox-01:/home/seth/symphony-workspaces/SYM-32@7bdde33bc`
   - Don't repeat metadata already on the issue (ID, status, branch, PR).
6. Add explicit acceptance criteria and TODOs as checklist items in the
   same comment.
   - If changes are user-facing, include a UI walkthrough acceptance
     criterion describing the end-to-end path to validate.
   - If changes touch app behavior, add explicit app-flow checks
     (launch path, changed interaction path, expected result).
   - If the ticket includes `Validation` / `Test Plan` / `Testing`
     sections, copy them into the workpad as required checkboxes (no
     optional downgrade).
7. Run a principal-style self-review of the plan and refine it in place.
8. Before implementing, capture a concrete reproduction signal in the
   workpad `Notes` section (command + output, screenshot, or a
   deterministic UI behavior).
9. Run the `pull` skill to sync with latest `origin/main` before any code
   edits. Record the result in the workpad `Notes` as `pull skill
   evidence`.
10. Compact context and proceed to execution.

## Step 2: Execution phase (Todo → In Progress → Human Review)

1. Determine current repo state (`branch`, `git status`, `HEAD`) and
   verify the kickoff `pull` evidence is in the workpad.
2. If still in `Todo`, transition to `In Progress`; otherwise leave the
   state alone.
3. Load the existing workpad and treat it as the active execution
   checklist. Edit it liberally as scope, risks, or validation evolve.
4. Implement against the hierarchical TODOs and keep the workpad current:
   - Check off completed items immediately.
   - Add newly discovered items in the right section.
   - Preserve parent/child structure as scope evolves.
   - Update after each meaningful milestone (reproduction, code change,
     validation, feedback addressed).
   - Never leave completed work unchecked.
   - For tickets that started as `Todo` with an attached PR, run the PR
     feedback sweep before new feature work.
5. Run validation/tests required for the scope.
   - Mandatory gate: execute all ticket-provided `Validation` /
     `Test Plan` / `Testing` items. Treat unmet items as incomplete work.
   - Prefer a targeted proof that directly demonstrates the behavior you
     changed.
   - Temporary local proof edits are allowed (e.g., hardcode a value to
     verify a code path). Revert every temporary edit before commit.
   - Document temporary proof edits + outcomes in workpad `Notes` /
     `Validation` so reviewers can follow the trail.
6. Re-check all acceptance criteria and close any gaps.
7. Before every push, invoke the `commit` skill to record the changes
   cleanly, then the `push` skill — which itself confirms pre-push
   validation is green and ensures PR + `symphony` label exist.
8. Run the `pull` skill to merge latest `origin/main` into the branch,
   resolve conflicts, rerun checks.
9. Update the workpad with final checklist status and validation notes.
   - Mark plan/acceptance/validation items checked.
   - Add final handoff notes (commit + validation summary) in the same
     workpad comment.
   - Keep the PR URL on the issue attachment, not in the workpad body.
   - Add a short `### Confusions` section at the bottom only when
     something during execution was unclear.
   - Do not post a separate completion summary comment.
10. Before moving to `Human Review`, poll PR feedback + checks:
    - Run the full PR feedback sweep protocol below.
    - Confirm PR checks are green after the latest push.
    - Confirm every required ticket-provided validation item is checked.
    - Re-open the workpad and refresh it so `Plan` / `Acceptance
      Criteria` / `Validation` match completed work exactly.
11. Only then move the issue to `Human Review`.
    - Exception: blocked by missing non-GitHub tools/auth → see escape
      hatch.
12. For `Todo` tickets that started with a PR attached:
    - Ensure all existing PR feedback was resolved (code change or
      explicit pushback reply on each thread).
    - Ensure the branch was pushed with required updates.
    - Then move to `Human Review`.

## Step 3: Human Review and merge handling

1. In `Human Review`, do not code or change ticket content.
2. Poll for updates, including GitHub PR review comments (humans and
   bots).
3. If review feedback requires changes, move the issue to `Rework`.
4. If approved, the human moves the issue to `Merging`.
5. In `Merging`, open and follow `.claude/skills/land/SKILL.md` and run
   its loop until the PR is merged. Do not call `gh pr merge` directly.
6. After merge, move the issue to `Done`.

## Step 4: Rework handling

Treat `Rework` as a full approach reset, not incremental patching.

1. Re-read the entire issue body and all human comments. Identify what
   you'll do differently this attempt.
2. Close the existing PR tied to the issue.
3. Remove the existing `## Symphony Workpad` comment.
4. Create a fresh branch from `origin/main`.
5. Restart from the normal kickoff flow:
   - If state is `Todo`, move to `In Progress`; otherwise leave the
     state alone.
   - Create a new bootstrap `## Symphony Workpad` comment.
   - Build a fresh plan/checklist and execute end-to-end.

## PR feedback sweep protocol

When a ticket has an attached PR, run this protocol before moving to
`Human Review`:

1. Identify the PR number from issue links/attachments.
2. Gather feedback from all channels:
   - Top-level PR comments: `gh pr view --comments`
   - Inline review comments: `gh api repos/<owner>/<repo>/pulls/<pr>/comments`
   - Review summaries/states: `gh pr view --json reviews`
3. Treat every actionable reviewer comment (human or bot, top-level or
   inline) as **blocking** until either:
   - code / tests / docs updated to address it, or
   - an explicit, justified pushback reply is posted on that thread.
4. Update the workpad plan/checklist with each feedback item and its
   resolution status.
5. Re-run validation after feedback-driven changes and `push`.
6. Repeat until no outstanding actionable comments remain.

## Blocked-access escape hatch

Use only when completion is blocked by missing required tools, or auth
or permissions that cannot be resolved in-session.

- GitHub is **not** a valid blocker by default. Try fallback strategies
  first (alternate remote, SSH vs HTTPS, `gh auth status`, re-login)
  before flagging it.
- Do not move to `Human Review` for GitHub access/auth until all
  fallback strategies have been attempted *and documented* in the
  workpad.
- If a non-GitHub required tool is missing, or required non-GitHub auth
  is unavailable, move the ticket to `Human Review` with a short blocker
  brief in the workpad that includes:
  - what's missing,
  - why it blocks required acceptance/validation,
  - exact human action needed to unblock.
- Keep the brief concise and action-oriented. Do not add separate
  top-level comments outside the workpad.

## Completion bar before Human Review

- Step 1 / 2 checklist is fully complete and accurately reflected in
  the single workpad comment.
- Acceptance criteria and ticket-provided validation items are complete.
- Validation / tests are green for the latest commit.
- PR feedback sweep is complete and no actionable comments remain.
- PR checks are green, branch is pushed, PR is linked on the issue.
- Required PR metadata is present (`symphony` label).

## Guardrails

- If the branch PR is already closed/merged, do not reuse that branch.
  Create a new branch from `origin/main` and restart from
  reproduction / planning.
- If issue state is `Backlog`, do not modify it. Wait for a human to
  move it to `Todo`.
- Do not edit the issue body/description for planning or progress
  tracking — that's what the workpad comment is for.
- Use exactly one persistent workpad comment (`## Symphony Workpad`)
  per issue.
- Temporary proof edits are allowed only for local verification and
  must be reverted before commit.
- Out-of-scope improvements get a separate `Backlog` issue with title,
  description, acceptance criteria, same-project assignment, a
  `related` link, and `blockedBy` when the follow-up depends on the
  current issue.
- Do not move to `Human Review` unless the completion bar is satisfied.
- In `Human Review`, do not make changes. Wait and poll.
- In `Done`, do nothing and shut down.
- Keep issue text concise, specific, and reviewer-oriented.
- If blocked and no workpad exists yet, add one blocker comment
  describing the blocker, impact, and next unblock action.

## Workpad template

Use this structure for the persistent workpad comment and keep it
updated in place throughout execution:

````md
## Symphony Workpad

```text
<hostname>:<abs-path>@<short-sha>
```

### Plan

- [ ] 1\. Parent task
  - [ ] 1.1 Child task
  - [ ] 1.2 Child task
- [ ] 2\. Parent task

### Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2

### Validation

- [ ] targeted tests: `<command>`

### Notes

- <short progress note with timestamp>

### Confusions

- <only include when something was confusing during execution>
````
