// Interactive Claude session in a sandbox
// Execution: npx tsx .sandcastle/new_flow/claude-interactive.ts
//
// Drops you into Claude Code's TUI inside the same Docker sandbox `main.ts`
// uses, on the current branch. When you exit, Sandcastle collects any commits.
//
// No env plumbing here on purpose: Sandcastle reads .sandcastle/.env itself and
// injects it into the container, so CLAUDE_CODE_OAUTH_TOKEN and GH_TOKEN are
// already present. The image (.sandcastle/Dockerfile) pre-accepts Claude Code's
// first-run onboarding — without that the TUI runs an OAuth login flow on every
// fresh container, because onboarding ignores CLAUDE_CODE_OAUTH_TOKEN.

import { interactive, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

async function main() {
  await interactive({
    // Sandcastle passes --dangerously-skip-permissions automatically whenever the
    // agent runs in a sandbox; pass `permissionMode` here to override that.
    agent: claudeCode("claude-opus-4-8"),
    // No skills mount: skills come from `.claude/skills` in the repo, which is
    // already bind-mounted as the workspace.
    sandbox: docker(),
  });
}

main().catch((err) => {
  console.error("Failed to start interactive Claude session:", err);
  process.exit(1);
});
