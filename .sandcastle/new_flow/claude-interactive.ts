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
// Runs from a git worktree as well as the main checkout — see repoRoot below.
// Both the image name and the env file have to be resolved against the main
// checkout, because Sandcastle resolves both against the working directory.

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { interactive, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

/**
 * The main checkout's root, even when the working directory is a worktree.
 *
 * `--git-common-dir` points at the main repo's `.git` from anywhere in the
 * repo — `.git` in the main checkout, an absolute path in a worktree.
 */
function repoRoot(): string {
  const commonDir = execSync("git rev-parse --git-common-dir", { encoding: "utf-8" }).trim();
  return path.dirname(path.resolve(commonDir));
}

/**
 * The sandbox image name, keyed to the main checkout rather than the current
 * directory.
 *
 * Sandcastle derives the tag from the directory basename, which is wrong in a
 * worktree: running from `finley-review-issue-138` asks for
 * `sandcastle:finley-review-issue-138`, an image nobody built. Review worktrees
 * are a normal place to want an interactive session.
 */
function sandboxImageName(root: string): string {
  const sanitized = path.basename(root).toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return `sandcastle:${sanitized}`;
}

/**
 * Tokens from the main checkout's `.sandcastle/.env`.
 *
 * Sandcastle reads that file itself, but relative to the working directory —
 * and it is gitignored, so it does not exist in a worktree. Without this the
 * container comes up unauthenticated ("Not logged in") when you run from one.
 * Empty values fall back to the host environment, matching Sandcastle's own
 * precedence.
 */
function sandcastleEnv(root: string): Record<string, string> {
  const envPath = path.join(root, ".sandcastle", ".env");
  if (!fs.existsSync(envPath)) return {};
  const parsed = dotenv.parse(fs.readFileSync(envPath));
  const resolved: Record<string, string> = {};
  for (const key of Object.keys(parsed)) {
    const value = parsed[key] || process.env[key];
    if (value) resolved[key] = value;
  }
  return resolved;
}

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
