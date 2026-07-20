// Parallel Agent Runner
// Execution: npx tsx .sandcastle/new_flow/main.ts [--sandbox <docker|cloud>] [--review <worktree|push>]
//   Sandbox defaults to docker (local); pass `--sandbox cloud` (or set
//   SANDCASTLE_SANDBOX=cloud) to run agents in Vercel cloud sandboxes instead.
//   Review handoff defaults to a local worktree, or `push` under CI; override
//   with `--review <worktree|push>` (or SANDCASTLE_REVIEW).
//
// Each iteration:
//   1. Plan   — an opus agent reads open GitHub issues labeled `Sandcastle`,
//               builds a dependency graph, and selects up to 3 unblocked,
//               non-overlapping issues that can be worked concurrently.
//   2. Execute — one implementer agent per issue runs in parallel, each in its
//               own sandbox on its own branch. Every agent verifies typecheck +
//               tests inside its sandbox, writes a summary file, and signals
//               done with <promise>COMPLETE</promise>.
//   3. Review  — for each completed issue we push the branch (off-machine backup)
//               and stand up a worktree so the commits can be reviewed and run.

import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { vercelProvider } from "./vercelProvider";
import { z } from "zod";
import { exec, execSync } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";

const execPromise = promisify(exec);

const planSchema = z.object({
  issues: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      branch: z.string(),
    }),
  ),
});

const MAX_OUTER_ITERATIONS = 10;

// ---------------------------------------------------------------------------
// Sandbox selection: Docker (local, default) vs. Vercel cloud.
//
// Choose with `--sandbox <docker|cloud>` (alias `vercel` = `cloud`), or the
// SANDCASTLE_SANDBOX env var; the CLI flag wins. Via npm the flag passes through
// after `--`:  npm run sandcastle -- --sandbox cloud
//
//   - docker (default): bind-mounts THIS working tree; commits land locally.
//   - cloud (vercel):   an ephemeral Firecracker microVM per run that CLONES the
//                        repo from its `origin` remote, so it needs a reachable
//                        remote plus VERCEL_TOKEN / VERCEL_TEAM_ID /
//                        VERCEL_PROJECT_ID in the env. Optionally set
//                        VERCEL_SANDBOX_IMAGE to a Vercel Container Registry
//                        image with the toolchain baked in (see
//                        .sandcastle/vercel.Dockerfile); without it the sandbox
//                        boots a stock runtime and installs the tools per run.
// ---------------------------------------------------------------------------
type SandboxKind = "docker" | "cloud";

// A VCR image ref to boot cloud sandboxes from (toolchain pre-baked). When unset,
// cloud falls back to a stock runtime + per-run tool installation (see `hooks`).
const CLOUD_IMAGE = process.env.VERCEL_SANDBOX_IMAGE?.trim() || undefined;

function resolveSandboxKind(): SandboxKind {
  const idx = process.argv.findIndex((a) => a === "--sandbox" || a.startsWith("--sandbox="));
  let raw: string | undefined;
  if (idx !== -1) {
    const arg = process.argv[idx];
    raw = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : process.argv[idx + 1];
  }
  raw = (raw ?? process.env.SANDCASTLE_SANDBOX ?? "docker").toLowerCase();
  if (raw === "docker" || raw === "local") return "docker";
  if (raw === "cloud" || raw === "vercel") return "cloud";
  throw new Error(`Unknown sandbox "${raw}". Use "docker" or "cloud".`);
}

// The origin URL the cloud sandbox clones. Fail loudly rather than spin up a
// sandbox against nothing when there's no remote to pull the code from.
function originRemoteUrl(): string {
  try {
    return execSync("git remote get-url origin", { encoding: "utf-8" }).trim();
  } catch {
    throw new Error(
      "Cloud sandbox needs a git 'origin' remote to clone from, but none was found. " +
        "Add one (git remote add origin <url>) or run with --sandbox docker.",
    );
  }
}

/**
 * The `owner/repo` slug from a git remote URL (https or ssh), or undefined.
 * Used to set `GH_REPO` so `gh` in the sandbox targets the repo directly instead
 * of resolving it from the cloned remote (which it may not recognize as GitHub).
 */
function githubRepoSlug(remoteUrl: string): string | undefined {
  return remoteUrl.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/)?.[1];
}

function makeSandbox(kind: SandboxKind) {
  if (kind === "docker") {
    console.log("🧱 Sandbox: docker (local bind-mount).");
    return docker();
  }
  const url = originRemoteUrl();

  // Vercel auth for a non-Vercel host (your laptop or a GitHub Actions runner):
  // an access token PLUS the team and project the sandbox is created under. All
  // three are required — a bare token can't tell the SDK which team/project to
  // bill the sandbox to. We read and pass them explicitly so the dependency is
  // visible here and a missing value fails fast with a clear message instead of
  // an opaque SDK auth error at sandbox-creation time.
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const missing = [
    ["VERCEL_TOKEN", token],
    ["VERCEL_TEAM_ID", teamId],
    ["VERCEL_PROJECT_ID", projectId],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`Cloud sandbox needs Vercel credentials — missing: ${missing.join(", ")}.`);
  }

  console.log(
    `☁️  Sandbox: vercel cloud (cloning ${url}; ${CLOUD_IMAGE ? `image ${CLOUD_IMAGE}` : "stock runtime + per-run install"}).`,
  );
  // A GH token lets the cloud sandbox clone a private origin over https
  // (x-access-token is GitHub's username convention for token auth).
  const auth = process.env.GH_TOKEN
    ? { username: "x-access-token", password: process.env.GH_TOKEN }
    : {};
  // The agent's tokens must reach the sandbox's commands. Sandcastle's own env
  // resolution reads `.sandcastle/.env` from the isolated worktree (where the
  // gitignored file isn't present), so it drops these — pass them straight from
  // the orchestrator's process.env and let the provider apply them per command.
  const sandboxEnv: Record<string, string> = {};
  for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "GH_TOKEN"]) {
    const value = process.env[key];
    if (value) sandboxEnv[key] = value;
  }
  // Target `gh` at the repo directly — the cloned remote isn't reliably resolved
  // as a "known GitHub host", so remote inference fails; GH_REPO bypasses it.
  const slug = githubRepoSlug(url);
  if (slug) sandboxEnv.GH_REPO = slug;
  // The Vercel image runs as root; Claude Code blocks --dangerously-skip-permissions
  // as root unless it knows it's sandboxed. It is (an isolated microVM), so say so.
  sandboxEnv.IS_SANDBOX = "1";
  return vercelProvider({
    ...(CLOUD_IMAGE ? { image: CLOUD_IMAGE } : {}),
    token,
    teamId,
    projectId,
    source: { type: "git", url, ...auth },
    env: sandboxEnv,
  });
}

// Resolved once at startup; the kind drives both the provider and how we seed
// each sandbox's dependencies. Reused across every planner/implementer run.
const SANDBOX_KIND = resolveSandboxKind();
const sandbox = makeSandbox(SANDBOX_KIND);

// Docker bind-mounts the host tree, so seeding the worktree with the host's
// already-installed `node_modules` saves a reinstall. A cloud sandbox instead
// copies these paths INTO a fresh Linux microVM — a macOS `node_modules` would
// be huge to ship and carry native binaries built for the wrong platform. So in
// cloud mode we send nothing and let the `onSandboxReady` `npm install` populate
// dependencies natively in the sandbox.
const copyToWorktree = SANDBOX_KIND === "cloud" ? [] : ["node_modules"];

// ---------------------------------------------------------------------------
// Sandbox startup provisioning (onSandboxReady runs inside the sandbox).
//
// The Docker image (.sandcastle/Dockerfile) — and a VERCEL_SANDBOX_IMAGE VCR
// image — bake in the agent's toolchain, so those only need `npm install`. A
// stock Vercel cloud runtime starts bare: it has git (it cloned the repo) and
// node, but NOT the GitHub CLI the prompts call (`gh issue list/view`) nor the
// `claude` binary Sandcastle invokes. So a stock-runtime cloud run installs
// those first, then installs deps.
//
// These target the Vercel node runtime; `gh` comes from the official release
// tarball (no package-manager assumptions) and `claude` from its installer,
// symlinked onto the system PATH so it resolves in every `sh -c` the agent runs.
// GH_TOKEN (from .sandcastle/.env) authenticates gh in the sandbox.
const GH_CLI_VERSION = "2.62.0";
const cloudProvisioning = [
  {
    command:
      "command -v gh >/dev/null 2>&1 || { " +
      'case "$(uname -m)" in aarch64|arm64) A=arm64;; *) A=amd64;; esac; ' +
      `V=${GH_CLI_VERSION}; ` +
      'curl -fsSL "https://github.com/cli/cli/releases/download/v${V}/gh_${V}_linux_${A}.tar.gz" | tar -xz -C /tmp && ' +
      '{ command -v sudo >/dev/null 2>&1 && S=sudo || S=; } && $S mv "/tmp/gh_${V}_linux_${A}/bin/gh" /usr/local/bin/gh; }',
    timeoutMs: 120_000,
  },
  {
    command:
      "command -v claude >/dev/null 2>&1 || { " +
      "curl -fsSL https://claude.ai/install.sh | bash && " +
      '{ command -v sudo >/dev/null 2>&1 && S=sudo || S=; } && $S ln -sf "$HOME/.local/bin/claude" /usr/local/bin/claude; }',
    timeoutMs: 180_000,
  },
  { command: "npm install", timeoutMs: 600_000 },
];

const npmInstallOnly = [{ command: "npm install", timeoutMs: 600_000 }];
const hooks = {
  sandbox: {
    onSandboxReady:
      // A prebuilt image (docker or a VCR image) already has the tools — just
      // install deps. Only a stock cloud runtime needs the tool provisioning.
      SANDBOX_KIND === "cloud" && !CLOUD_IMAGE ? cloudProvisioning : npmInstallOnly,
  },
};

// ---------------------------------------------------------------------------
// Review handoff mode: how a completed branch is surfaced for review.
//
//   - worktree: after each success, stand up a local git worktree checked out to
//               the branch (dev-machine default) so you can run/inspect it.
//   - push:     just push the branch to origin and stop; skip the worktree. This
//               is the default in CI, where the runner is ephemeral — any
//               worktree it builds is deleted when the job ends, so the pushed
//               branch IS the review artifact. Recreate a worktree locally later
//               with create-review-worktree.sh once you fetch the branch.
//
// Override with `--review <worktree|push>` or SANDCASTLE_REVIEW; otherwise it
// auto-selects `push` under CI (GitHub Actions sets CI/GITHUB_ACTIONS) and
// `worktree` on a dev machine.
// ---------------------------------------------------------------------------
type ReviewMode = "worktree" | "push";

function resolveReviewMode(): ReviewMode {
  const idx = process.argv.findIndex((a) => a === "--review" || a.startsWith("--review="));
  let raw: string | undefined;
  if (idx !== -1) {
    const arg = process.argv[idx];
    raw = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : process.argv[idx + 1];
  }
  const inCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
  raw = (raw ?? process.env.SANDCASTLE_REVIEW ?? (inCI ? "push" : "worktree")).toLowerCase();
  if (raw === "worktree" || raw === "push") return raw;
  throw new Error(`Unknown review mode "${raw}". Use "worktree" or "push".`);
}

const REVIEW_MODE = resolveReviewMode();
console.log(`🔎 Review handoff: ${REVIEW_MODE}.`);

// ---------------------------------------------------------------------------
// Helper: Stand up an isolated review worktree for a completed branch.
//
// The agent's sandbox worktree is torn down once its commits land, but the
// branch itself persists. create-review-worktree.sh recreates a fully
// functional worktree (git worktree add + npm install) so the branch can be run
// with a dev server. Each issue gets its own directory and port, so several can
// be reviewed concurrently. Tear it down later with remove-review-worktree.sh.
// ---------------------------------------------------------------------------
async function createReviewWorktree(issue: { id: string; branch: string }) {
  const script = path.join(process.cwd(), ".sandcastle/new_flow/create-review-worktree.sh");
  try {
    const { stdout, stderr } = await execPromise(`bash "${script}" "${issue.branch}" "${issue.id}"`);
    if (stdout.trim()) console.log(stdout.trim());
    if (stderr.trim()) console.error(stderr.trim());
  } catch (error: any) {
    console.error(
      `❌ [Issue #${issue.id}] Failed to create review worktree: ${error.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helper: Mark a completed issue as done without closing it.
//
// This is the planner's dedup signal: the planner only selects issues labeled
// `Sandcastle`, so swapping that label for `sandcastle-done` stops a finished
// issue from being re-selected (and re-colliding with its review worktree). The
// issue stays OPEN for human review. Non-fatal.
// ---------------------------------------------------------------------------
async function markIssueDone(issue: { id: string }) {
  try {
    // Ensure the label exists (harmless if it already does), then swap labels.
    await execPromise(
      `gh label create sandcastle-done --color 0E8A16 --description "Implemented by Sandcastle; open for review"`,
    ).catch(() => {});
    await execPromise(
      `gh issue edit ${issue.id} --remove-label "Sandcastle" --add-label "sandcastle-done"`,
    );
    console.log(`🏷️  [Issue #${issue.id}] Relabeled Sandcastle → sandcastle-done (issue left open for review).`);
  } catch (labelError: any) {
    console.warn(`⚠️ [Issue #${issue.id}] Could not update issue labels: ${labelError.message}`);
  }
}

// ---------------------------------------------------------------------------
// Helper: Run the implementer agent for one issue, then hand off for review.
//
// This runs concurrently with other issues, so it must never touch the shared
// host working tree (no `git checkout`). Each implementer verifies its own work
// inside an isolated sandbox; we trust that verification here. The only host git
// command we run is branch-scoped and working-tree-safe: `git push origin
// <branch>` for an off-machine backup.
//
// Provider-agnostic handoff: for BOTH docker and cloud, `issue.branch` exists
// locally with the commits once `run()` returns — the docker sandbox writes it
// through the bind-mount, and the cloud sandbox's commits are reconciled onto
// the host branch by Sandcastle (it format-patches them out of the microVM and
// applies them to a host worktree). So the push step below works the same either
// way; nothing here needs to fetch from the cloud.
//
// The review surface then depends on REVIEW_MODE: `worktree` stands up a local
// worktree to inspect in place; `push` (CI default) leaves the pushed branch as
// the artifact, since an ephemeral runner's worktree would be discarded anyway.
// ---------------------------------------------------------------------------
async function processSingleIssue(issue: { id: string; title: string; branch: string }) {
  const startTime = Date.now();
  console.log(`🚀 [Issue #${issue.id}] Running implementation agent...`);

  let success = false;
  // Set only when the agent's own host worktree survived the run (uncommitted
  // changes). When present we can review in place instead of creating a new one.
  let preservedWorktreePath: string | undefined;

  try {
    const result = await sandcastle.run({
      hooks,
      copyToWorktree,
      sandbox,
      branchStrategy: { type: "branch", branch: issue.branch },
      name: "implementer",
      // One run, but many iterations: the agent is re-prompted until it emits
      // the completion signal (default "<promise>COMPLETE</promise>") or hits
      // this cap. We can't detect completion via structured output (Output.*)
      // instead — that requires maxIterations: 1, and the implementer needs the
      // full red-green-refactor loop across many iterations.
      maxIterations: 80,
      agent: sandcastle.claudeCode("claude-opus-4-8"),
      promptFile: "./.sandcastle/new_flow/implement-prompt.md",
      promptArgs: {
        TASK_ID: issue.id,
        ISSUE_TITLE: issue.title,
        BRANCH: issue.branch,
      },
    });

    // The implementer runs typecheck + tests inside its own sandbox before
    // signaling done, so success is determined entirely from the sandbox
    // result — never from a host checkout, which would corrupt sibling agents
    // running concurrently on other branches.
    if (result.completionSignal !== undefined && result.commits.length > 0) {
      success = true;
      preservedWorktreePath = result.preservedWorktreePath;
      console.log(
        `✓ [Issue #${issue.id}] Implementer signaled COMPLETE with ${result.commits.length} commit(s).`,
      );
    } else if (result.completionSignal !== undefined) {
      console.warn(`⚠️ [Issue #${issue.id}] COMPLETE promise but no commits — nothing to review.`);
    } else {
      console.warn(`⚠️ [Issue #${issue.id}] Agent did not signal completion within the iteration limit.`);
    }
  } catch (error: any) {
    console.error(`[Issue #${issue.id}] Runner error:`, error);
  }

  // --- Push the branch and surface it for review (per REVIEW_MODE) ---
  if (success) {
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`✓ [Issue #${issue.id}] Task completed cleanly in ${elapsed}m.`);

    // Push the branch to origin. In `push` (CI) mode this is the ONLY durable
    // handoff — the runner is ephemeral — so a failure means the work could be
    // lost; in `worktree` mode it is an off-machine backup on top of the local
    // branch. Non-fatal either way so sibling issues still finish.
    let pushed = false;
    try {
      await execPromise(`git push origin ${issue.branch}`);
      pushed = true;
      console.log(`⬆️  [Issue #${issue.id}] Pushed ${issue.branch} to origin.`);
    } catch (pushError: any) {
      console.warn(`⚠️ [Issue #${issue.id}] Could not push branch: ${pushError.message}`);
    }

    // Take the issue out of the planner's queue so it is not re-selected, while
    // leaving it open for human review.
    await markIssueDone(issue);

    if (REVIEW_MODE === "push") {
      // Ephemeral/CI: no local worktree would survive the run, so the pushed
      // branch is the review artifact. Print how to review it locally later.
      console.log(`FINISHED: ${issue.branch}`);
      if (pushed) {
        console.log(`🔍 [Issue #${issue.id}] Review locally when you're back:`);
        console.log(`           git fetch origin ${issue.branch}`);
        console.log(`           .sandcastle/new_flow/create-review-worktree.sh ${issue.branch} ${issue.id}`);
      } else {
        console.error(
          `🚨 [Issue #${issue.id}] Branch is not on origin and no worktree survives — review artifact may be lost. See the push error above.`,
        );
      }
    } else if (preservedWorktreePath && fs.existsSync(preservedWorktreePath)) {
      // The agent's own worktree survived — review the commits in place.
      console.log(`FINISHED: ${preservedWorktreePath}`);
      console.log(`🔍 [Issue #${issue.id}] Review the commits in the preserved worktree:`);
      console.log(`           cd ${preservedWorktreePath} && git log --oneline ${issue.branch}`);
      console.log(`           Summary: ${preservedWorktreePath}/.sandcastle/summary-${issue.id}.md`);
    } else {
      // No surviving worktree — stand up a fresh one checked out to the branch.
      console.log(`FINISHED: ${issue.branch}`);
      await createReviewWorktree(issue);
    }
  } else {
    console.error(`🚨 [Issue #${issue.id}] Did not complete — no branch handed off for review.`);
  }
}

// ---------------------------------------------------------------------------
// Main Pipeline Loop
// ---------------------------------------------------------------------------
async function main() {
  for (let iteration = 1; iteration <= MAX_OUTER_ITERATIONS; iteration++) {
    console.log(`\n=== Pipeline Iteration ${iteration}/${MAX_OUTER_ITERATIONS} ===\n`);

    // Branches currently checked out in a worktree (e.g. review worktrees for
    // completed issues). The planner must not re-select these — git refuses to
    // check the same branch out twice, so re-running one would hard-fail.
    let checkedOutBranchesJson = "[]";
    try {
      const raw = execSync(`git worktree list --porcelain`, { encoding: "utf-8" });
      const branches = raw
        .split("\n")
        .filter((line) => line.startsWith("branch "))
        .map((line) => line.slice("branch ".length).replace("refs/heads/", "").trim())
        .filter(Boolean);
      checkedOutBranchesJson = JSON.stringify(branches);
    } catch (err) {
      console.warn("⚠️ Warning: Could not list git worktrees. Proceeding without checked-out-branch tracking.");
    }

    // 1. Run the Planning Phase
    console.log("Analyzing Sandcastle-labeled issues and building workspace queue...");
    const plan = await sandcastle.run({
      hooks,
      sandbox,
      name: "planner",
      maxIterations: 1,
      agent: sandcastle.claudeCode("claude-opus-4-8"),
      promptFile: "./.sandcastle/new_flow/plan-prompt.md",
      promptArgs: {
        CHECKED_OUT_BRANCHES_JSON: checkedOutBranchesJson,
      },
      output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
    });

    const issues = plan.output.issues;

    if (issues.length === 0) {
      console.log("Zero unblocked Sandcastle issues ready in the backlog. Work complete.");
      break;
    }

    console.log(`Planner selected ${issues.length} issue(s) to process. Spawning workers concurrently...`);

    // 2. Parallel Processing Phase (each issue runs completely independently)
    await Promise.allSettled(
      issues.map((issue) => processSingleIssue(issue))
    );

    console.log(`\n=== Iteration ${iteration} parallel batch resolved. ===`);
  }
}

main().catch((err) => {
  console.error("Critical orchestrator failure:", err);
  process.exit(1);
});
