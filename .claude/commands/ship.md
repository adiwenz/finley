---
description: Ship a completed Sandcastle issue — commit, PR, merge, close, pull main, and tear down its review worktree.
argument-hint: <issue-number> [commit message]
allowed-tools: Bash
---

Ship the completed Sandcastle work for the issue given in `$ARGUMENTS`.

The first token of `$ARGUMENTS` is the issue number; anything after it is an
optional commit message for the not-yet-committed changes.

You do NOT need to be inside the issue's worktree — the script resolves the
review worktree deterministically from the issue number
(`../finley-review-issue-<id>`, branch `sandcastle/issue-<id>`), so this works no
matter which worktree the session is currently in.

Steps:

1. FIRST, before running the script, reconcile the summary with reality. This
   MUST happen now, while the review edits are still uncommitted — the script's
   very next actions are to copy the summary into the PR body and then commit the
   remaining changes, so once it runs it is too late to fold new edits in. The PR
   body is generated from `.sandcastle/summary-<id>.md` inside the review worktree
   (`../finley-review-issue-<id>` relative to the main checkout). That summary was
   written by the implementer and may predate changes made during review. So:
   - Read the summary file and look at what actually changed on the branch since
     it was written — the still-uncommitted diff (`git -C <review-worktree> status`
     / `diff`) and the branch commits (`git -C <review-worktree> log origin/main..HEAD`).
   - If any decisions in the code now differ from what the summary describes, edit
     `.sandcastle/summary-<id>.md` so it reflects the current decisions (add a
     short "Updated during review" note describing what changed and why).
   - If nothing meaningful diverged, leave the summary as-is.

   Do not add the `Closes #<id>` line yourself — the script appends it. Do not
   commit the summary — the script keeps it out of the commit and deletes it.

2. Run the ship script from the repo root, passing the issue number and (if the
   user supplied one) the commit message as a single quoted argument:

   ```bash
   "$(git rev-parse --show-toplevel)/scripts/ship-worktree.sh" <issue-number> ["commit message"]
   ```

   It is fully unattended and does, in order: copy the summary into the PR body →
   commit remaining changes (never the summary file) → push `sandcastle/issue-<id>`
   → open the PR with that body (or update an existing PR's description) → delete
   the summary file and commit its removal, now that its content is safe on the PR
   → merge (merge commit) → close the issue → pull main → remove the review
   worktree and delete the branch (local + origin).

3. If the script exits because the review worktree does not exist, it prints the
   exact `create-review-worktree.sh` commands to stand one up. Show those to the
   user and ask whether to create it and retry — do not create it silently.

4. When it finishes, report concisely: the resolved worktree, the PR URL, and
   confirmation that the issue is closed and the worktree/branch are cleaned up.
   If any step failed, the script stops before the irreversible merge/teardown —
   surface the error and the fact that nothing was merged or deleted.
