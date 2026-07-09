#!/bin/bash
set -eo pipefail

if [ -z "$1" ]; then
  echo "Usage: $0 <iterations> [local|commit]"
  echo "  local  (default) report-only: no commits, pushes, or issue writes"
  echo "  commit           commits changes and closes/comments the issue"
  exit 1
fi

# Select the prompt flow. Defaults to local (report-only).
case "${2:-local}" in
  local)  prompt_file="ralph/local_prompt.md" ;;
  commit) prompt_file="ralph/commit_prompt.md" ;;
  *) echo "Unknown mode '$2' (expected 'local' or 'commit')"; exit 1 ;;
esac

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

for ((i=1; i<=$1; i++)); do
  tmpfile=$(mktemp)
  trap "rm -f $tmpfile" EXIT

  commits=$(git log -n 5 --format="%H%n%ad%n%B---" --date=short 2>/dev/null || echo "No commits found")
  issues=$(gh issue list --label "ready-for-agent" --state open --json number,title,body \
    --jq '.[] | "## Issue #\(.number): \(.title)\n\n\(.body)\n\n---\n"' 2>/dev/null)
  issues=${issues:-"No open AFK issues found."}
  prompt=$(cat "$prompt_file")

  docker sandbox run claude . -- \
    --model claude-opus-4-8 \
    --verbose \
    --print \
    --output-format stream-json \
    "Previous commits: $commits Issues: $issues $prompt" \
  | grep --line-buffered '^{' \
  | tee "$tmpfile" \
  | jq --unbuffered -rj "$stream_text"

  result=$(jq -r "$final_result" "$tmpfile")

  if [[ "$result" == *"<promise>NO MORE TASKS</promise>"* ]]; then
    echo "Ralph complete after $i iterations."
    exit 0
  fi
done
