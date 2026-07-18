// Parallel Agent Runner with Automated AI PR Summaries
// Execution: npx tsx .sandcastle/new_flow/main.ts
//
// Each iteration:
//   1. Plan   — an opus agent reads open GitHub issues labeled `Sandcastle`,
//               builds a dependency graph, and selects up to 3 unblocked,
//               non-overlapping issues that can be worked concurrently.
//   2. Execute — one implementer agent per issue runs in parallel, each in its
//               own sandbox on its own branch. Every agent verifies typecheck +
//               tests inside its sandbox, writes a PR-body summary file, and
//               signals done with <promise>COMPLETE</promise>.
//   3. Publish — for each completed issue we push the branch and open a draft PR
//               whose body is the agent-written summary.

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
const MAX_INNER_RETRY_LIMIT = 3;

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
// Helper: Process an individual issue, pull AI summary, and create Draft PR.
//
// This runs concurrently with other issues, so it must never touch the shared
// host working tree (no `git checkout`). Each implementer verifies its own work
// inside an isolated sandbox; we trust that verification here. The only host git
// commands we run are branch-scoped and working-tree-safe: `git show <branch>:…`,
// `git push origin <branch>`, and `gh pr create --head <branch>`.
// ---------------------------------------------------------------------------
async function processSingleIssue(issue: { id: string; title: string; branch: string }) {
  const startTime = Date.now();
  console.log(`🚀 [Issue #${issue.id}] Initializing implementation agent...`);

  let currentAttempt = 1;
  let success = false;
  let feedback = "";
  // Set only when the agent's own host worktree survived the run (uncommitted
  // changes). When present we can review in place instead of creating a new one.
  let preservedWorktreePath: string | undefined;

  while (currentAttempt <= MAX_INNER_RETRY_LIMIT && !success) {
    console.log(`⏳ [Issue #${issue.id}] Attempt ${currentAttempt}/${MAX_INNER_RETRY_LIMIT}...`);

    try {
      const result = await sandcastle.run({
        hooks,
        copyToWorktree,
        sandbox: docker(),
        branchStrategy: { type: "branch", branch: issue.branch },
        name: `implementer-attempt-${currentAttempt}`,
        maxIterations: 80,
        agent: sandcastle.claudeCode("claude-opus-4-8"),
        promptFile: "./.sandcastle/new_flow/implement-prompt.md",
        promptArgs: {
          TASK_ID: issue.id,
          ISSUE_TITLE: issue.title,
          BRANCH: issue.branch,
          FEEDBACK: feedback || "No previous attempts yet. This is your first try.",
        },
        // Structured output (Output.*) requires maxIterations: 1, but the
        // implementer needs many iterations. Instead we stop the loop early on
        // the agent's completion sentinel and read it from result.completionSignal.
        completionSignal: "<promise>COMPLETE</promise>",
      });

      // The implementer runs typecheck + tests inside its own sandbox before
      // signaling done, so success is determined entirely from the sandbox
      // result — never from a host checkout, which would corrupt sibling agents
      // running concurrently on other branches.
      const signaledComplete = result.completionSignal !== undefined;

      if (signaledComplete && result.commits.length > 0) {
        success = true;
        preservedWorktreePath = result.preservedWorktreePath;
        console.log(
          `✓ [Issue #${issue.id}] Implementer signaled COMPLETE with ${result.commits.length} commit(s) on attempt ${currentAttempt}.`,
        );
      } else if (signaledComplete) {
        feedback = `You output the COMPLETE promise but made 0 commits on branch ${issue.branch}. Implement the change, commit it on that branch, then signal completion again.`;
        console.warn(`⚠️ [Issue #${issue.id}] COMPLETE promise but no commits.`);
      } else {
        feedback = `You did not signal completion within the iteration limit. Finish the task, run typecheck and tests, commit your work, write the summary file, then output <promise>COMPLETE</promise>.`;
        console.warn(`⚠️ [Issue #${issue.id}] Completion criteria not met.`);
      }
    } catch (error: any) {
      // 1. Capture a clean message for the agent feedback loop
      const errorMessage = error instanceof Error ? error.message : String(error);
      feedback = `The Sandcastle runner encountered a system error during execution: ${errorMessage}`;

      // 2. Format a safe, visually isolated log block with the Issue ID prefix
      console.error(`\n[Issue #${issue.id}] 🚨 SYSTEM EXCEPTION (Attempt ${currentAttempt}) 🚨`);

      if (error instanceof Error) {
        // Safe print of the stack trace
        console.error(`[Issue #${issue.id}] Stack Trace:\n${error.stack || error.message}`);

        // Sandcastle run exceptions often wrap underlying process errors containing stdout/stderr
        if ("stdout" in error && error.stdout) {
          console.error(`[Issue #${issue.id}] Command stdout:\n${error.stdout}`);
        }
        if ("stderr" in error && error.stderr) {
          console.error(`[Issue #${issue.id}] Command stderr:\n${error.stderr}`);
        }
      } else {
        // Safe structural print for non-Error object exceptions
        try {
          console.error(`[Issue #${issue.id}] Raw Error Object:\n`, JSON.stringify(error, null, 2));
        } catch {
          console.error(`[Issue #${issue.id}] Raw Error Object:`, error);
        }
      }
      console.error(`[Issue #${issue.id}] -------------------------------------------\n`);
    }

    if (!success) {
      currentAttempt++;
    }
  }

  // --- Provide a worktree to review the draft commits (no PR is created) ---
  if (success) {
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`✓ [Issue #${issue.id}] Task completed cleanly in ${elapsed}m. No PR opened — review happens in a worktree.`);

    // Optional off-machine backup. The branch and its commits already exist in
    // the local repo, so review works without this; a push failure is non-fatal.
    try {
      await execPromise(`git push origin ${issue.branch}`);
      console.log(`⬆️  [Issue #${issue.id}] Pushed ${issue.branch} to origin (backup only — no PR).`);
    } catch (pushError: any) {
      console.warn(`⚠️ [Issue #${issue.id}] Could not push branch (review is still available locally): ${pushError.message}`);
    }

    if (preservedWorktreePath && fs.existsSync(preservedWorktreePath)) {
      // The agent's own worktree survived — review the draft commits in place.
      console.log(`FINISHED: ${preservedWorktreePath}`);
      console.log(`🔍 [Issue #${issue.id}] Review the draft commits in the preserved worktree:`);
      console.log(`           cd ${preservedWorktreePath} && git log --oneline ${issue.branch}`);
      console.log(`           Summary: ${preservedWorktreePath}/.sandcastle/summary-${issue.id}.md`);
    } else {
      // No surviving worktree — stand up a fresh one checked out to the branch.
      console.log(`FINISHED: ${issue.branch}`);
      await createReviewWorktree(issue);
    }
  } else {
    console.error(`🚨 [Issue #${issue.id}] Could not complete the task within the ${MAX_INNER_RETRY_LIMIT} attempt cap.`);
  }
}

// ---------------------------------------------------------------------------
// Main Pipeline Loop
// ---------------------------------------------------------------------------
async function main() {
  for (let iteration = 1; iteration <= MAX_OUTER_ITERATIONS; iteration++) {
    console.log(`\n=== Pipeline Iteration ${iteration}/${MAX_OUTER_ITERATIONS} ===\n`);

    let activePRsJson = "[]";
    try {
      activePRsJson = execSync(
        `gh pr list --state open --json headRefName --limit 100`,
        { encoding: "utf-8" }
      ).trim();
    } catch (err) {
      console.warn("⚠️ Warning: Could not fetch active PRs list. Proceeding with empty tracking state.");
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
      promptArgs: { ACTIVE_PRS_JSON: activePRsJson },
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
