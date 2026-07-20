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

1. Run the ship script from the repo root, passing the issue number and (if the
   user supplied one) the commit message as a single quoted argument:

   ```bash
   "$(git rev-parse --show-toplevel)/scripts/ship-worktree.sh" <issue-number> ["commit message"]
   ```

   It is fully unattended and does, in order: commit remaining changes → push
   `sandcastle/issue-<id>` → open a PR that closes the issue → merge (merge
   commit) → close the issue → pull main → remove the review worktree and delete
   the branch (local + origin).

2. If the script exits because the review worktree does not exist, it prints the
   exact `create-review-worktree.sh` commands to stand one up. Show those to the
   user and ask whether to create it and retry — do not create it silently.

3. When it finishes, report concisely: the resolved worktree, the PR URL, and
   confirmation that the issue is closed and the worktree/branch are cleaned up.
   If any step failed, the script stops before the irreversible merge/teardown —
   surface the error and the fact that nothing was merged or deleted.
