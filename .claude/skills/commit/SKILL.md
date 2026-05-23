---
name: commit
description: Produce clean, logical commits — one purpose per commit, imperative subject, body explains the why. Use any time you have changes ready to record locally.
---

# commit

Group changes into commits a human reviewer can reason about one at a
time. One commit per logical purpose.

## Principles

- **One purpose per commit.** A bug fix, a refactor, and a feature
  addition are three commits even if they touch the same file. A
  reviewer should be able to revert any single commit and have a
  coherent intermediate state.
- **Subject = imperative, ≤72 chars.** "Add X", "Fix Y", "Refactor Z".
  Not "Added", not "Adding", not "Fixed X (because Y)".
- **Body = the why, not the what.** The diff shows what changed. The
  body explains the motivation, the constraints, the alternatives
  considered. Wrap at ~72 chars.
- **No AI co-authorship trailers.** Do not add `Co-Authored-By:
  Claude`, `Generated with Claude Code`, or similar lines. Per repo
  convention (see `AGENTS.md` / `CLAUDE.md`).
- **Reference the ticket** in the body if the connection isn't obvious
  from context: `Refs SYM-12` or `Closes SYM-12` for the final commit
  in a series.

## Protocol

1. **Survey what's pending.**

   ```sh
   git status --short
   git diff --stat
   ```

2. **Group changes** mentally into logical units. If the diff is one
   logical unit, commit it. If it's three, plan three commits.

3. **For each unit:**

   a. Stage *only* the files (or hunks) for that unit:

      ```sh
      git add <specific files>
      # or for partial files:
      git add -p
      ```

      Never `git add -A` or `git add .` — that's how secrets, stray
      build artifacts, and unrelated edits sneak into commits.

   b. Write the commit:

      ```sh
      git commit -m "$(cat <<'EOF'
      Short imperative subject

      Why this change exists. Constraints that shaped the approach.
      What was considered and rejected, if non-obvious.

      Refs SYM-XX
      EOF
      )"
      ```

   c. Verify the commit landed cleanly:

      ```sh
      git log -1 --stat
      ```

4. **Never use `--no-verify`.** If a pre-commit hook fails, fix the
   root cause. The hooks exist because someone got burned without them.

5. **Never `--amend` a pushed commit.** If you've already pushed and
   need to change the previous commit, add a follow-up commit instead.
   Amending public history forces reviewers to re-anchor their
   comments.

## When to stop and split

If you find yourself writing a commit subject with "and" in it — split
the commit. "Fix login redirect and rename auth helper" → two commits.

If the body needs more than ~5 lines to justify what changed — either
the change is too big (split it) or the design needs an issue-level
write-up first.
