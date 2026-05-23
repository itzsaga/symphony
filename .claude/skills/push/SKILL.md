---
name: push
description: Publish branch updates and ensure a PR is open with the `symphony` label. Use after every commit batch that should be visible to reviewers; required before moving a ticket to `Human Review`.
---

# push

Publish your work, make it reviewable, and keep the issue ↔ PR linkage
intact.

## When to invoke

- After every meaningful commit batch (one or more commits that form a
  reviewable unit).
- Required immediately before moving a ticket to `Human Review`.
- After any change in response to PR feedback.

## Preconditions

- Working tree is clean (everything you want pushed is committed —
  invoke the `commit` skill first if not).
- Required validation (typecheck, tests, lint) is green for the current
  HEAD. Push *only* after green. If red, fix or revert; do not push
  broken code.
- You've run the `pull` skill at least once on this branch since the
  last edit, so the push won't immediately fall behind base.

## Protocol

1. **Confirm green.** Run the project's required pre-push checks. If
   you don't know which they are, look for a `pre-push` git hook,
   `package.json` script named `verify` / `check` / `ci`, or
   `WORKFLOW.md` notes. Default to typecheck + test suite.

2. **Push.**

   ```sh
   git push -u origin HEAD
   ```

   `-u` so subsequent `git push` / `git pull` work without arguments.

3. **Ensure a PR exists.**

   ```sh
   gh pr view --json number 2>/dev/null || \
   gh pr create --fill --base main
   ```

   - `--fill` seeds title/body from your last commit; edit afterward
     if the issue's acceptance criteria aren't already in the
     commit message.
   - Use the issue ID in the PR title prefix (e.g., `SYM-12: <subject>`)
     unless the repo convention says otherwise.

4. **Ensure the `symphony` label is on the PR.**

   ```sh
   gh pr edit --add-label symphony
   ```

   Idempotent; if the label is missing from the repo, create it once:
   `gh label create symphony --color BFD4F2 --description "Opened by Symphony agent"`.

5. **Link the PR to the issue.** Prefer Linear's attachment surface so
   the link shows in the issue sidebar. If Linear MCP is unavailable,
   add the PR URL to the workpad `Notes` section (not as a separate
   comment).

6. **Record evidence** in the workpad `Notes`:

   ```
   push skill evidence
   - head: <short SHA>
   - pr: #<num>
   - checks: pending   # update on next sweep
   ```

## Stop conditions

- Pre-push checks failed → fix or revert; do not push.
- `git push` rejected as non-fast-forward → run `pull`, resolve, retry.
  Never `--force` a shared branch.
- PR creation failed (e.g., no remote, no GitHub auth) → see the
  blocked-access escape hatch in `WORKFLOW.md`. GitHub auth issues are
  *not* an automatic blocker; exhaust fallbacks first (alternate
  remote, SSH vs HTTPS, `gh auth status`) and document each attempt.
