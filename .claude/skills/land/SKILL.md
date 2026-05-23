---
name: land
description: Merge an approved PR by looping through the merge gates until the branch is in main. Use when a Symphony-tracked ticket is in `Merging`; never call `gh pr merge` directly.
---

# land

You are landing an approved PR. The human has already moved the ticket to
`Merging`; your job is to drive it through the remaining gates and into
`main`. This is a **loop**: each iteration inspects state, attempts the
next action, and re-checks. Do not stop until the PR is `MERGED` or you
hit a true blocker.

## Preconditions

- Ticket is in `Merging`.
- A PR exists on the branch, is open, and has at least one approval.
- You are in the workspace for this ticket (workpad comment knows the
  abs path + short SHA).

## Loop body

Run this loop until the PR reports `state: MERGED` or you hit a blocker
condition listed under *Stop conditions*.

1. **Read PR state.**

   ```sh
   gh pr view --json state,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid,baseRefName
   ```

   Pull out: `state`, `mergeable`, `mergeStateStatus`, `reviewDecision`,
   and the rollup of required check conclusions.

2. **Route on `mergeStateStatus`:**

   | Status        | Action                                                                                                                  |
   | ------------- | ----------------------------------------------------------------------------------------------------------------------- |
   | `CLEAN`       | Attempt merge (see step 3).                                                                                             |
   | `HAS_HOOKS`   | Attempt merge — required hooks pass; merge will trigger them.                                                           |
   | `UNSTABLE`    | Non-required checks are red but required checks are green. Attempt merge.                                               |
   | `BEHIND`      | Run the `pull` skill to merge `origin/<base>` into the branch, push, then loop.                                         |
   | `BLOCKED`     | Inspect `reviewDecision` + `statusCheckRollup`. If a required check is `FAILURE`, see step 4. If review is missing, stop (see *Stop conditions*). |
   | `DIRTY`       | Merge conflicts. Run `pull`, resolve, push, loop.                                                                       |
   | `DRAFT`       | PR is a draft. `gh pr ready` to mark ready, loop.                                                                       |
   | `UNKNOWN`     | GitHub hasn't computed yet. Wait 10s, loop.                                                                             |

3. **Attempt merge.**

   ```sh
   gh pr merge --squash --auto --delete-branch
   ```

   - Prefer `--squash` unless the repo's `WORKFLOW.md` or PR description
     calls for a merge commit or rebase strategy. Match repo convention
     if visible.
   - `--auto` lets the merge-queue / required-checks queue swallow the
     request when not all gates are green yet. Safe to retry.
   - Re-read state and loop.

4. **Required check failed.**

   - Identify the failing check from `statusCheckRollup`.
   - If the failure is clearly flaky (transient infra, network), re-run
     it: `gh run rerun --failed <run-id>`. Loop.
   - If the failure looks real (your change broke something), stop the
     land loop and move the ticket back to `Rework` with a workpad note
     summarizing the failed check and a link to the run.

5. **Backoff.** Between iterations, sleep at least 10s so you aren't
   hammering the API. If the queue is wait-heavy, sleep 30s.

## Stop conditions

Stop the loop and surface the result:

- **`state == MERGED`** — success. Move the ticket to `Done`, update the
  workpad with merge commit SHA, and exit.
- **`reviewDecision == CHANGES_REQUESTED`** — a reviewer landed
  rejection while you were looping. Move ticket to `Rework`, note the
  reviewer + comment URL in the workpad.
- **Required check is genuinely red** (not flake) — see step 4 above.
- **Merge fails 5 consecutive iterations** with the same
  `mergeStateStatus` and no progress — stop, write a workpad note with
  the last status, and move ticket to `Human Review` for human
  diagnosis.

## Non-negotiables

- Never call `gh pr merge` without going through this loop. The auto
  flag + state inspection is what makes this safe in a merge-queue or
  required-checks repo.
- Never force-push or rewrite shared branch history during landing.
- Never disable required checks to make merge succeed.
- The land loop is the *only* thing that should move a ticket from
  `Merging` to `Done`. Do not transition state from any other code
  path.
