#!/bin/bash

# Select the prompt flow. Defaults to local (report-only).
case "${1:-local}" in
  local)  prompt_file="ralph/local_prompt.md" ;;
  commit) prompt_file="ralph/commit_prompt.md" ;;
  *) echo "Usage: $0 [local|commit]"; exit 1 ;;
esac

issues=$(gh issue list --label "ready-for-agent" --state open --json number,title,body \
  --jq '.[] | "## Issue #\(.number): \(.title)\n\n\(.body)\n\n---\n"' 2>/dev/null)
issues=${issues:-"No open AFK issues found."}
commits=$(git log -n 5 --format="%H%n%ad%n%B---" --date=short 2>/dev/null || echo "No commits found")
prompt=$(cat "$prompt_file")

claude --permission-mode acceptEdits \
  "Previous commits: $commits Issues: $issues $prompt"
