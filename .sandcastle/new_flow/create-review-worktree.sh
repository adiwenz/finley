#!/usr/bin/env bash
#
# Create an isolated, fully functional git worktree for reviewing a Sandcastle
# branch. The agent's sandbox worktree is torn down once its commits land, so
# this recreates one on the host for the branch, installs dependencies, and
# tells you how to start the dev server on a per-issue port.
#
# Usage: create-review-worktree.sh <branch> <issue-id>

set -euo pipefail

BRANCH="${1:?usage: create-review-worktree.sh <branch> <issue-id>}"
ISSUE_ID="${2:?usage: create-review-worktree.sh <branch> <issue-id>}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
REVIEW_DIR="${REPO_ROOT}/../finley-review-issue-${ISSUE_ID}"

# Deterministic per-issue port so several review worktrees can run concurrently
# without colliding. Non-numeric ids fall back to the Vite default.
if [[ "$ISSUE_ID" =~ ^[0-9]+$ ]]; then
  PORT=$(( 5173 + ISSUE_ID % 900 ))
else
  PORT=5173
fi

cd "$REPO_ROOT"

if [[ -d "$REVIEW_DIR" ]]; then
  echo "[review] Worktree already exists at ${REVIEW_DIR}; reusing it."
else
  echo "[review] Creating worktree for ${BRANCH} at ${REVIEW_DIR}..."
  git worktree add "$REVIEW_DIR" "$BRANCH"
fi

echo "[review] Installing dependencies (fresh worktree has no node_modules)..."
( cd "$REVIEW_DIR" && npm install )

echo "[review] Worktree ready for issue #${ISSUE_ID} (${BRANCH})."
echo "[review] Review the draft commits:"
echo "           cd ${REVIEW_DIR} && git log --oneline ${BRANCH}"
echo "[review] Implementation summary: ${REVIEW_DIR}/.sandcastle/summary-${ISSUE_ID}.md"
echo "[review] Start the dev server:"
echo "           cd ${REVIEW_DIR} && npm run dev -w @finley/app -- --port ${PORT}"
echo "[review] When done, remove it:"
echo "           .sandcastle/new_flow/remove-review-worktree.sh ${ISSUE_ID}"
