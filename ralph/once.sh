#!/bin/bash

issues=$(gh issue list --label "ready-for-agent" --state open --json number,title,body \
  --jq '.[] | "## Issue #\(.number): \(.title)\n\n\(.body)\n\n---\n"' 2>/dev/null)
issues=${issues:-"No open AFK issues found."}
commits=$(git log -n 5 --format="%H%n%ad%n%B---" --date=short 2>/dev/null || echo "No commits found")
prompt=$(cat ralph/prompt.md)

claude --permission-mode acceptEdits \
  "Previous commits: $commits Issues: $issues $prompt"
