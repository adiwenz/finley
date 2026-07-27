// Interactive Claude session in a sandbox
// Execution: npx tsx .sandcastle/new_flow/claude-interactive.ts
//
// Drops you into Claude Code's TUI inside the same Docker sandbox `main.ts`
// uses, on the current branch. When you exit, Sandcastle collects any commits.
//
// The image (.sandcastle/Dockerfile) pre-accepts Claude Code's first-run
// onboarding — without that the TUI runs an OAuth login flow on every fresh
// container, because onboarding ignores CLAUDE_CODE_OAUTH_TOKEN. Skills come
// from `.claude/skills` in the repo, which is already bind-mounted as the
// workspace, so no skills mount is needed.
//
// Runs from a review worktree as well as the main checkout. Note this passes
// `env` rather than pointing Sandcastle at the main checkout with `cwd`: `cwd`
// also decides which tree the agent works in, and working in the worktree is
// the entire point of launching from one. See repoPaths.

import { interactive, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { repoRoot, sandboxImageName, sandcastleEnv } from "./repoPaths";

async function main() {
  const root = repoRoot();
  const imageName = sandboxImageName(root);
  if (root !== process.cwd()) {
    console.log(`🌳 Worktree run — image and env resolved from ${root}`);
  }
  console.log(`🧱 Sandbox image: ${imageName}`);

  await interactive({
    // Sandcastle passes --dangerously-skip-permissions automatically whenever the
    // agent runs in a sandbox; pass `permissionMode` here to override that.
    agent: claudeCode("claude-opus-4-8"),
    sandbox: docker({ imageName }),
    env: sandcastleEnv(root),
  });
}

main().catch((err) => {
  console.error("Failed to start interactive Claude session:", err);
  process.exit(1);
});
