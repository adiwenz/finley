#!/usr/bin/env bash
#
# Remove the review worktree created for a Sandcastle issue.
# Leaves the branch and its commits intact — only the working directory is torn
# down.
#
# Usage: remove-review-worktree.sh <issue-id>

set -euo pipefail

ISSUE_ID="${1:?usage: remove-review-worktree.sh <issue-id>}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
REVIEW_DIR="${REPO_ROOT}/../finley-review-issue-${ISSUE_ID}"

if [[ -d "$REVIEW_DIR" ]]; then
  echo "[review] Removing worktree at ${REVIEW_DIR}..."
  git worktree remove "$REVIEW_DIR" --force
  echo "[review] Removed worktree for issue #${ISSUE_ID}."
else
  echo "[review] No worktree found at ${REVIEW_DIR}; nothing to remove."
  # Prune any stale administrative references just in case.
  git worktree prune
fi
