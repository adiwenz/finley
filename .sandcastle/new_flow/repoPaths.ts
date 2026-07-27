// Resolving repo-anchored paths when the working directory may be a git worktree.
//
// Sandcastle resolves the sandbox image name, `.sandcastle/.env`,
// `.sandcastle/worktrees/`, and `.sandcastle/logs/` against the *working
// directory*. Run anything from a review worktree (`finley-review-issue-138`)
// and all of those land somewhere that does not exist: an image nobody built,
// a gitignored env file that was never checked out. These helpers resolve them
// against the main checkout instead.

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

/**
 * The main checkout's root, even when the working directory is a worktree.
 *
 * `git rev-parse --git-common-dir` points at the main repo's `.git` from
 * anywhere in the repo — `.git` in the main checkout, an absolute path in a
 * worktree — so its parent is the main checkout either way.
 */
export function repoRoot(): string {
  const commonDir = execSync("git rev-parse --git-common-dir", { encoding: "utf-8" }).trim();
  return path.dirname(path.resolve(commonDir));
}

/**
 * The Docker sandbox image name, keyed to the main checkout.
 *
 * Mirrors Sandcastle's own `sandcastle:<dir>` scheme and sanitising, but anchored
 * so a worktree does not ask for `sandcastle:finley-review-issue-138`. Derived
 * rather than hardcoded so it survives a rename of the checkout directory.
 */
export function sandboxImageName(root: string): string {
  const sanitized = path.basename(root).toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return `sandcastle:${sanitized}`;
}

/**
 * Tokens from the main checkout's `.sandcastle/.env`.
 *
 * For callers that cannot simply point Sandcastle at the main checkout with the
 * `cwd` option — `interactive()` uses `cwd` to decide which tree the agent works
 * in, and the whole point there is to work in the worktree. Empty values fall
 * back to the host environment, matching Sandcastle's own precedence.
 */
export function sandcastleEnv(root: string): Record<string, string> {
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
