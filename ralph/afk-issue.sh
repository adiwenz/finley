#!/bin/bash
set -eo pipefail

# afk-issue.sh — work ONE issue to completion in its own isolated checkout, on
# its own branch, in its own sandbox. Run several at once (one per issue) and
# they never step on each other: separate working trees, separate branches,
# separate `claude-<dir>` sandboxes you can `/login` to independently.
#
# Why a clone and not a `git worktree`: this repo's Docker sandbox mounts ONLY
# the workspace directory (its `.git` lives inside it). A worktree keeps its real
# git data under the MAIN repo's `.git/worktrees/…`, which is NOT mounted in the
# worktree's sandbox — so `git commit` (even `git status`) fails inside it. A
# clone is self-contained, so git works normally in the sandbox.

if [ -z "$1" ]; then
  echo "Usage: $0 <issue> [iterations] [local|commit]"
  echo "  issue        the single GitHub issue number to work on"
  echo "  iterations   max iterations (default 10)"
  echo "  commit (default) checks out ralph/issue-<n>, commits there, closes the issue"
  echo "  local        report-only: leaves changes in the checkout, no commits"
  echo
  echo "Example — two issues in parallel, in two terminals:"
  echo "  $0 25        # goal authoring in UI"
  echo "  $0 37        # (other issue)"
  exit 1
fi

ISSUE="$1"
ITERATIONS="${2:-10}"
MODE="${3:-commit}"

case "$MODE" in
  local|commit) ;;
  *) echo "Unknown mode '$MODE' (expected 'local' or 'commit')"; exit 1 ;;
esac

# --- Resolve a stable, unique checkout + branch for this issue --------------
REPO_ROOT=$(git rev-parse --show-toplevel)
REPO_NAME=$(basename "$REPO_ROOT")
PARENT=$(cd "$REPO_ROOT/.." && pwd)          # absolute, no ".." — matches sandbox naming
CHECKOUT="$PARENT/$REPO_NAME-issue-$ISSUE"   # sibling dir -> sandbox "claude-<basename>"
BRANCH="ralph/issue-$ISSUE"

# --- Create (or reuse) the isolated clone ----------------------------------
if [ -d "$CHECKOUT" ]; then
  if [ -d "$CHECKOUT/.git" ] || [ -f "$CHECKOUT/.git" ]; then
    echo "Reusing existing checkout at $CHECKOUT"
  else
    echo "Directory $CHECKOUT exists but is not a git checkout; aborting." >&2
    exit 1
  fi
else
  echo "Creating isolated checkout for issue #$ISSUE at $CHECKOUT"
  origin_url=$(git -C "$REPO_ROOT" remote get-url origin)
  # Clone from the local repo: fast (hardlinks objects on the same filesystem).
  git clone --quiet "$REPO_ROOT" "$CHECKOUT"
  # Point origin at GitHub so a human can `git push -u origin $BRANCH` later, and
  # so `gh` operations resolve the right repo.
  git -C "$CHECKOUT" remote set-url origin "$origin_url"
  git -C "$CHECKOUT" fetch --quiet origin || true
  git -C "$CHECKOUT" switch -c "$BRANCH"
  # A fresh clone has only tracked files. Carry over untracked local tooling the
  # agent relies on — notably .claude/ (skills like /tdd, settings).
  if [ -d "$REPO_ROOT/.claude" ]; then
    cp -R "$REPO_ROOT/.claude" "$CHECKOUT/.claude"
  fi
  echo "Created branch $BRANCH in $CHECKOUT"
fi

cd "$CHECKOUT"

# --- Interactive login -----------------------------------------------------
# A fresh sandbox has no Claude credentials. Open an interactive session so you
# can authenticate; the login persists in this sandbox (named after this
# directory) for the autonomous run that follows.
cat <<EOF

────────────────────────────────────────────────────────────
An interactive Claude session will open in this issue's sandbox
(claude-$(basename "$PWD")).
  • Run  /login  and complete authentication.
  • Then /exit (or Ctrl-D) to start the autonomous run.
  • Already authenticated in this sandbox? Just /exit.
EOF
if [ "$MODE" = "commit" ]; then
  cat <<EOF
  • commit mode also needs GitHub auth for closing the issue. If
    'gh' isn't authed in this sandbox, the commits still land on
    $BRANCH; run this in another terminal to enable issue-closing:
      docker sandbox exec claude-$(basename "$PWD") gh auth login
EOF
fi
echo "────────────────────────────────────────────────────────────"
echo

docker sandbox run claude .

# --- Work the issue to completion ------------------------------------------
# afk.sh runs its own sandbox preflight, then loops on this single pinned issue.
# We're already on $BRANCH, so afk.sh's branch handling is a no-op here.
echo "=== Working issue #$ISSUE on $BRANCH until complete ==="
exec bash ralph/afk.sh "$ITERATIONS" "$MODE" "$ISSUE"
