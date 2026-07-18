// Parallel Agent Runner
// Execution: npx tsx .sandcastle/new_flow/main.ts
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
import { docker } from "@ai-hero/sandcastle/sandboxes/docker"; // Change to vercel() if using Vercel Sandbox
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

const hooks = {
  sandbox: { onSandboxReady: [{ command: "npm install" }] },
};
const copyToWorktree = ["node_modules"];

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
      sandbox: docker(),
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

  // --- Push an off-machine backup and provide a worktree to review the commits ---
  if (success) {
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`✓ [Issue #${issue.id}] Task completed cleanly in ${elapsed}m. Review happens in a worktree.`);

    // Optional off-machine backup. The branch and its commits already exist in
    // the local repo, so review works without this; a push failure is non-fatal.
    try {
      await execPromise(`git push origin ${issue.branch}`);
      console.log(`⬆️  [Issue #${issue.id}] Pushed ${issue.branch} to origin (backup only).`);
    } catch (pushError: any) {
      console.warn(`⚠️ [Issue #${issue.id}] Could not push branch (review is still available locally): ${pushError.message}`);
    }

    // Take the issue out of the planner's queue so it is not re-selected, while
    // leaving it open for human review.
    await markIssueDone(issue);

    if (preservedWorktreePath && fs.existsSync(preservedWorktreePath)) {
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
      sandbox: docker(),
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
