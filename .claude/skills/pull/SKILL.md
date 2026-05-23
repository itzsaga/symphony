---
name: pull
description: Sync the current branch with the latest `origin/main` (or the PR's base ref). Use before starting implementation, before pushing, and whenever the `land` skill reports `BEHIND` or `DIRTY`.
---

# pull

Bring the branch up to date with its base. Resolve conflicts in-tree.
Record evidence so the workpad has a trail.

## When to invoke

- Kickoff of any execution flow, before the first edit.
- Before every `push`.
- Inside the `land` loop when PR state is `BEHIND` or `DIRTY`.
- After any reviewer comment that says "rebase me" or "merge in main".

## Protocol

1. **Identify the base ref.** For PRs:

   ```sh
   gh pr view --json baseRefName --jq .baseRefName
   ```

   Default to `main` if not on a PR yet.

2. **Fetch.**

   ```sh
   git fetch origin
   ```

3. **Capture pre-state** (for the workpad evidence line):

   ```sh
   git rev-parse --short HEAD
   git status --porcelain
   ```

   If the working tree is dirty, stop and surface the dirty files —
   never auto-stash unless the workpad has already noted it.

4. **Merge** `origin/<base>` into the branch.

   ```sh
   git merge --no-edit origin/<base>
   ```

   - Prefer merge over rebase: PR branches are shared with reviewers,
     and rebase rewrites their review anchors.
   - If the repo's convention is rebase (visible from prior PRs or
     CONTRIBUTING), use `git rebase origin/<base>` instead, but only on
     a fresh, unshared branch.

5. **Resolve conflicts** if any. Conflict resolution rules:

   - Prefer your change when the conflict is in code you just authored;
     prefer `origin/<base>` when the conflict is in unrelated code that
     evolved upstream.
   - For lockfiles (`bun.lock`, `package-lock.json`, `Cargo.lock`,
     `mix.lock`): take `origin/<base>`'s version, then re-run the
     install command for the language so your changes are
     re-incorporated.
   - Never resolve a conflict by deleting reviewer-added code without
     understanding why it's there.

6. **Verify the build still works** after merge: at minimum, run the
   project's typecheck or fastest sanity-check command.

7. **Record evidence** in the workpad `Notes` section:

   ```
   pull skill evidence
   - source: origin/main
   - result: clean   # or "conflicts resolved in <files>"
   - head: <new short SHA>
   ```

## Stop conditions

- Working tree was dirty at start and you don't have an explicit
  workpad note authorizing a stash → stop, surface the dirty files.
- Conflicts touch code you don't understand → stop, ask in the workpad
  before resolving.
- Post-merge typecheck/sanity fails → stop, treat as new work needed
  (don't push a broken merge).
