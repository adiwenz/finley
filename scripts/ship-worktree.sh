#!/usr/bin/env bash
#
# ship-worktree.sh — ship a completed Sandcastle issue end to end.
#
# Sandcastle gives every issue a deterministic branch `sandcastle/issue-<id>`
# (see .sandcastle/new_flow/plan-prompt.md) and, once you run
# create-review-worktree.sh, a sibling review worktree at
# `../finley-review-issue-<id>`. Because BOTH are derived from the issue number,
# you can run this from ANYWHERE in the repo — the main checkout or any other
# review worktree — and it will locate and operate on the right worktree. You
# never have to cd there yourself.
#
# For the given issue it will, fully unattended:
#   1. Build the PR description from .sandcastle/summary-<id>.md (+ "Closes #<id>"),
#      then delete that file so it is NOT committed or merged into main
#   2. Commit any remaining changes in that review worktree
#   3. Push sandcastle/issue-<id>
#   4. Open the PR with that description — or, if a PR already exists, update its
#      description (so extra commits made after the summary was written can be
#      reflected by re-running after editing the summary)
#   5. Merge the PR with a merge commit
#   6. Close the issue (belt & suspenders — the merge already closes it)
#   7. Pull main in the main worktree
#   8. Remove the review worktree (via remove-review-worktree.sh) and delete the
#      branch locally and on origin
#
# `set -e` halts on any failure BEFORE the merge/teardown steps, so a broken run
# leaves your commits and worktree intact.
#
# Usage:
#   scripts/ship-worktree.sh <issue-number> [commit message]
#
# Examples:
#   scripts/ship-worktree.sh 82
#   scripts/ship-worktree.sh 82 "Wire up the planner summary export"
#
set -euo pipefail

# ---- args ---------------------------------------------------------------
ISSUE="${1:?Usage: ship-worktree.sh <issue-number> [commit message]}"
ISSUE="${ISSUE#\#}"                       # tolerate a leading '#'
COMMIT_MSG="${2:-}"
if ! [[ "$ISSUE" =~ ^[0-9]+$ ]]; then
  echo "error: issue number must be numeric, got '$ISSUE'" >&2
  exit 1
fi

BRANCH="sandcastle/issue-${ISSUE}"
step() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }

# ---- preflight ----------------------------------------------------------
step "Preflight"
command -v gh >/dev/null || { echo "error: gh CLI not found" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "error: gh is not authenticated (run: gh auth login)" >&2; exit 1; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo "error: not inside the finley git repo" >&2; exit 1; }

# The first entry of `git worktree list` is always the main working tree.
MAIN_WORKTREE="$(git worktree list --porcelain | sed -n 's/^worktree //p' | head -n1)"
# Review worktrees are siblings of the main checkout, named by issue id — the
# exact convention create-review-worktree.sh uses.
REVIEW_DIR="$(dirname "$MAIN_WORKTREE")/finley-review-issue-${ISSUE}"

# ---- locate the review worktree (deterministic from the issue number) ---
step "Locating review worktree for issue #$ISSUE"
if [[ ! -d "$REVIEW_DIR" ]]; then
  cat >&2 <<EOF
error: no review worktree at
  $REVIEW_DIR
Create it first, then re-run this:
  git -C "$MAIN_WORKTREE" fetch origin $BRANCH
  "$MAIN_WORKTREE/.sandcastle/new_flow/create-review-worktree.sh" $BRANCH $ISSUE
EOF
  exit 1
fi

ACTUAL_BRANCH="$(git -C "$REVIEW_DIR" rev-parse --abbrev-ref HEAD)"
if [[ "$ACTUAL_BRANCH" == "HEAD" ]]; then
  echo "error: $REVIEW_DIR is in detached HEAD state." >&2
  exit 1
fi
if [[ "$ACTUAL_BRANCH" != "$BRANCH" ]]; then
  echo "warning: $REVIEW_DIR is on '$ACTUAL_BRANCH', not the expected '$BRANCH'." >&2
  echo "         Shipping '$ACTUAL_BRANCH'." >&2
  BRANCH="$ACTUAL_BRANCH"
fi

ISSUE_TITLE="$(gh issue view "$ISSUE" --json title -q .title)" \
  || { echo "error: issue #$ISSUE not found" >&2; exit 1; }

echo "Worktree     : $REVIEW_DIR"
echo "Branch       : $BRANCH"
echo "Issue        : #$ISSUE  $ISSUE_TITLE"
echo "Main worktree: $MAIN_WORKTREE"

cd "$REVIEW_DIR"

# ---- build the PR description from the summary, then drop the summary ----
# .sandcastle/summary-<id>.md is the agent's implementation write-up. We use it
# as the PR body (with a trailing "Closes #<id>") but never ship the file
# itself: capture its contents now, then delete it so it is not committed or
# merged into main. If you added commits after the summary was written, edit the
# summary first so the PR body reflects the newer decisions.
step "Preparing PR description"
SUMMARY_FILE=".sandcastle/summary-${ISSUE}.md"
PR_BODY_FILE="$(mktemp)"
trap 'rm -f "$PR_BODY_FILE"' EXIT
if [[ -f "$SUMMARY_FILE" ]]; then
  cat "$SUMMARY_FILE" >"$PR_BODY_FILE"
  printf '\n\nCloses #%s\n' "$ISSUE" >>"$PR_BODY_FILE"
  echo "Using $SUMMARY_FILE as the PR body; it will be deleted, not committed."
  # Remove it so it never lands on main (staged removal if tracked, else plain rm).
  git rm -f --quiet -- "$SUMMARY_FILE" >/dev/null 2>&1 || rm -f "$SUMMARY_FILE"
else
  printf 'Closes #%s\n' "$ISSUE" >"$PR_BODY_FILE"
  echo "No $SUMMARY_FILE found; PR body will be just 'Closes #$ISSUE'."
fi

# ---- 1. commit remaining changes ---------------------------------------
step "Committing remaining changes"
git add -A
if git diff --cached --quiet; then
  echo "Nothing to commit."
else
  git commit -m "${COMMIT_MSG:-Ship issue #${ISSUE}: ${ISSUE_TITLE}}"
fi

git fetch --quiet origin main
if git diff --quiet "origin/main...HEAD"; then
  echo "error: no differences between origin/main and this branch — nothing to ship." >&2
  exit 1
fi

# ---- 2. push ------------------------------------------------------------
step "Pushing $BRANCH"
git push -u origin "$BRANCH"

# ---- 3. open the PR, or update an existing one's description ------------
step "Opening or updating PR"
if PR_URL="$(gh pr view "$BRANCH" --json url -q .url 2>/dev/null)"; then
  gh pr edit "$BRANCH" --body-file "$PR_BODY_FILE" >/dev/null
  echo "Updated existing PR description: $PR_URL"
else
  PR_URL="$(gh pr create \
    --base main \
    --head "$BRANCH" \
    --title "${ISSUE_TITLE} (#${ISSUE})" \
    --body-file "$PR_BODY_FILE")"
  echo "Opened: $PR_URL"
fi

# ---- 4. merge -----------------------------------------------------------
step "Merging PR (merge commit)"
gh pr merge "$BRANCH" --merge

# ---- 5. close the issue (belt & suspenders) -----------------------------
step "Closing issue #$ISSUE"
gh issue close "$ISSUE" 2>/dev/null || echo "Issue already closed."

# ---- 6. pull main -------------------------------------------------------
step "Updating main"
cd "$MAIN_WORKTREE"
git checkout main >/dev/null 2>&1 || true
git pull --ff-only origin main

# ---- 7. tear down the worktree + branch ---------------------------------
step "Removing review worktree and branch"
REMOVE_SCRIPT="$MAIN_WORKTREE/.sandcastle/new_flow/remove-review-worktree.sh"
if [[ -f "$REMOVE_SCRIPT" ]]; then
  bash "$REMOVE_SCRIPT" "$ISSUE"
else
  git worktree remove --force "$REVIEW_DIR"
fi
git branch -D "$BRANCH" 2>/dev/null || true
git push origin --delete "$BRANCH" 2>/dev/null || true

step "Done — #$ISSUE shipped and cleaned up."
echo "PR: $PR_URL"
