#!/bin/bash
set -eo pipefail

if [ -z "$1" ]; then
  echo "Usage: $0 <iterations> [local|commit] [issues]"
  echo "  iterations       max iterations PER issue"
  echo "  local  (default) report-only: no commits, pushes, or issue writes"
  echo "  commit           commits changes and closes/comments the issue"
  echo "  issues           one issue, or a quoted space-separated list worked one"
  echo "                   after another (default \"35\"); \"\" = all ready-for-agent"
  exit 1
fi

ITERATIONS="$1"

# Select the prompt flow. Defaults to local (report-only).
case "${2:-local}" in
  local)  prompt_file="ralph/local_prompt.md" ;;
  commit) prompt_file="ralph/commit_prompt.md" ;;
  *) echo "Unknown mode '$2' (expected 'local' or 'commit')"; exit 1 ;;
esac

# Pin Ralph to a list of issues, worked one after another. Defaults to "35";
# override with the 3rd argument (one number, or a quoted list like "35 36"), or
# pass "" to let Ralph pick from all open `ready-for-agent` issues in one pass.
ISSUES="${3-36}"

# --- Preflight: platform-native dependencies in the sandbox -----------------
# node_modules is a shared virtiofs mount between the macOS host and the linux
# sandbox, and native deps (esbuild) ship per-OS binaries that can't be shared,
# so a node_modules built on the host segfaults here. sandbox-preflight.sh
# clean-reinstalls for the sandbox's platform when the toolchain is broken.
# (This makes the SANDBOX own node_modules; if you later run the app on the
# macOS host, run `npm install` there once to rebuild its binaries.)
SANDBOX="claude-$(basename "$PWD")"
docker sandbox create claude . >/dev/null 2>&1 || true
echo "Preflight: verifying sandbox dependencies…"
docker sandbox exec "$SANDBOX" sh -lc "cd '$PWD' && bash ralph/sandbox-preflight.sh"

# jq filter to extract streaming text from assistant messages
stream_text='select(.type == "assistant").message.content[]? | select(.type == "text").text // empty | gsub("\n"; "\r\n") | . + "\r\n\n"'

# jq filter to extract final result
final_result='select(.type == "result").result // empty'

# Run up to ITERATIONS on a single issues block. Returns 0 as soon as Ralph
# reports NO MORE TASKS; returns 1 if the iteration budget is exhausted first.
run_issue() {
  local label="$1" issues_block="$2"
  for ((i=1; i<=ITERATIONS; i++)); do
    local tmpfile commits prompt result
    tmpfile=$(mktemp)

    # Recomputed each iteration: Ralph's own commits become prior context.
    commits=$(git log -n 5 --format="%H%n%ad%n%B---" --date=short 2>/dev/null || echo "No commits found")
    prompt=$(cat "$prompt_file")

    docker sandbox run claude . -- \
      --model claude-opus-4-8 \
      --verbose \
      --print \
      --output-format stream-json \
      "Previous commits: $commits Issues: $issues_block $prompt" \
    | grep --line-buffered '^{' \
    | tee "$tmpfile" \
    | jq --unbuffered -rj "$stream_text"

    result=$(jq -r "$final_result" "$tmpfile")
    rm -f "$tmpfile"

    if [[ "$result" == *"<promise>NO MORE TASKS</promise>"* ]]; then
      echo "Ralph complete on $label after $i iterations."
      return 0
    fi
  done
  echo "Ralph hit the $ITERATIONS-iteration budget on $label without finishing."
  return 1
}

if [ -n "$ISSUES" ]; then
  # Work each pinned issue in turn; a finished (or budget-exhausted) issue moves
  # on to the next rather than ending the run.
  for issue in $ISSUES; do
    echo "=== Ralph starting issue #$issue ==="
    block=$(gh issue view "$issue" --json number,title,body \
      --jq '"## Issue #\(.number): \(.title)\n\n\(.body)\n\n---\n"' 2>/dev/null)
    block=${block:-"Issue #$issue not found."}
    run_issue "#$issue" "$block" || true
  done
  echo "Ralph finished all issues: $ISSUES"
else
  # No pins: one pass over every open ready-for-agent issue, as before.
  block=$(gh issue list --label "ready-for-agent" --state open --json number,title,body \
    --jq '.[] | "## Issue #\(.number): \(.title)\n\n\(.body)\n\n---\n"' 2>/dev/null)
  block=${block:-"No open AFK issues found."}
  run_issue "all ready-for-agent" "$block" || true
fi
