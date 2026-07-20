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
#   1. Copy .sandcastle/summary-<id>.md into the PR body (+ "Closes #<id>")
#   2. Commit any remaining changes in that review worktree (never the summary)
#   3. Push sandcastle/issue-<id>
#   4. Open the PR with that description — or, if a PR already exists, update its
#      description (so extra commits made after the summary was written can be
#      reflected by re-running after editing the summary). The summary's content
#      is now safe on the PR in GitHub.
#   5. Delete the summary file and commit the removal, so it is not merged into
#      main — no local restore is ever needed, the content already lives on the PR
#   6. Merge the PR with a merge commit
#   7. Close the issue (belt & suspenders — the merge already closes it)
#   8. Pull main in the main worktree
#   9. Remove the review worktree (via remove-review-worktree.sh) and delete the
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

# ---- read the summary into the PR body (do NOT delete it yet) -----------
# .sandcastle/summary-<id>.md is the implementer's write-up. We copy it into the
# PR body (with a trailing "Closes #<id>") but never ship the file itself. The
# copy into GitHub happens BEFORE the file is deleted, so if a later step fails
# the description is already safe on the PR — nothing local has to be restored.
# If you added commits after the summary was written, edit the summary first so
# the body reflects the newer decisions.
step "Preparing PR description"
SUMMARY_FILE=".sandcastle/summary-${ISSUE}.md"
PR_BODY_FILE="$(mktemp)"
trap 'rm -f "$PR_BODY_FILE"' EXIT
HAVE_SUMMARY=0
if [[ -f "$SUMMARY_FILE" ]]; then
  HAVE_SUMMARY=1
  cat "$SUMMARY_FILE" >"$PR_BODY_FILE"
  printf '\n\nCloses #%s\n' "$ISSUE" >>"$PR_BODY_FILE"
  echo "PR body will come from $SUMMARY_FILE (copied to the PR, then the file is deleted)."
else
  printf 'Closes #%s\n' "$ISSUE" >"$PR_BODY_FILE"
  echo "No $SUMMARY_FILE found; PR body will be just 'Closes #$ISSUE'."
fi

# ---- 1. commit remaining changes (but never the summary file) ----------
step "Committing remaining changes"
git add -A
# Keep the summary out of the commit; it goes into the PR body, not into main.
git reset -q -- "$SUMMARY_FILE" 2>/dev/null || true
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
# On create, always set the body. On reuse, only overwrite the body when we
# actually have a summary this run — otherwise a re-run after the summary was
# already deleted would clobber the good description with just "Closes #<id>".
step "Opening or updating PR"
if PR_URL="$(gh pr view "$BRANCH" --json url -q .url 2>/dev/null)"; then
  if [[ "$HAVE_SUMMARY" -eq 1 ]]; then
    gh pr edit "$BRANCH" --body-file "$PR_BODY_FILE" >/dev/null
    echo "Updated existing PR description: $PR_URL"
  else
    echo "Reusing existing PR (no summary this run; description left as-is): $PR_URL"
  fi
else
  PR_URL="$(gh pr create \
    --base main \
    --head "$BRANCH" \
    --title "${ISSUE_TITLE} (#${ISSUE})" \
    --body-file "$PR_BODY_FILE")"
  echo "Opened: $PR_URL"
fi

# ---- 4. delete the summary now that its content is safe on the PR ------
# Committed and pushed as its own commit so it is removed from the merge into
# main. Skipped cleanly if there was no summary (nothing to delete).
if [[ "$HAVE_SUMMARY" -eq 1 && -e "$SUMMARY_FILE" ]]; then
  step "Removing $SUMMARY_FILE (its content now lives in the PR description)"
  git rm -f --quiet -- "$SUMMARY_FILE" >/dev/null 2>&1 || rm -f "$SUMMARY_FILE"
  git add -A
  if ! git diff --cached --quiet; then
    git commit -m "Remove ${SUMMARY_FILE} (moved into the PR description for #${ISSUE})"
    git push
  fi
fi

# ---- 5. merge -----------------------------------------------------------
step "Merging PR (merge commit)"
gh pr merge "$BRANCH" --merge

# ---- 6. close the issue (belt & suspenders) -----------------------------
step "Closing issue #$ISSUE"
gh issue close "$ISSUE" 2>/dev/null || echo "Issue already closed."

# ---- 7. pull main -------------------------------------------------------
step "Updating main"
cd "$MAIN_WORKTREE"
git checkout main >/dev/null 2>&1 || true
git pull --ff-only origin main

# ---- 8. tear down the worktree + branch ---------------------------------
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
