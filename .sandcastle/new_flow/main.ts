// Parallel Agent Runner with Automated AI PR Summaries
// Execution: npx tsx .sandcastle/main.ts

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
// Helper: Process an individual issue, pull AI summary, and create Draft PR
// ---------------------------------------------------------------------------
async function processSingleIssue(issue: { id: string; title: string; branch: string }) {
  const startTime = Date.now();
  console.log(`🚀 [Issue #${issue.id}] Initializing implementation agent...`);

  let currentAttempt = 1;
  let success = false;
  let feedback = "";

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
        promptFile: "./.sandcastle/implement-prompt.md",
        promptArgs: {
          TASK_ID: issue.id,
          ISSUE_TITLE: issue.title,
          BRANCH: issue.branch,
          FEEDBACK: feedback || "No previous attempts yet. This is your first try.",
        },
        output: sandcastle.Output.string({ tag: "promise" }), 
      });

      console.log(`🔍 [Issue #${issue.id}] Checking build/test suite status...`);
      
      try {
        // Run tests locally to verify correctness
        execSync(`git checkout ${issue.branch} && npm run test`, { encoding: "utf-8" });
        
        if (result.output === "COMPLETE" && result.commits.length > 0) {
          success = true;
          console.log(`✓ [Issue #${issue.id}] Code verified on attempt ${currentAttempt}!`);
        } else {
          feedback = `Your code compiled, but you either made 0 commits or forgot to output the word 'COMPLETE'. Current output tag value: ${result.output}`;
          console.warn(`⚠️ [Issue #${issue.id}] Output criteria not met.`);
        }
      } catch (validationError: any) {
        feedback = `The validation suite failed during attempt ${currentAttempt} with the following details:\n\n${validationError.stdout || validationError.message}`;
        console.warn(`❌ [Issue #${issue.id}] Build/test failure encountered on attempt ${currentAttempt}. Re-looping with errors.`);
      }

    } catch (error: any) {
      feedback = `The Sandcastle runner encountered an system error during execution: ${error.message}`;
      console.error(`❌ [Issue #${issue.id}] System exception on attempt ${currentAttempt}.`);
    }

    if (!success) {
      currentAttempt++;
    }
  }

  // --- Push changes and construct Draft PR with AI Summary ---
  if (success) {
    const tempPrBodyPath = path.join(process.cwd(), `.sandcastle/temp-pr-body-${issue.id}.md`);
    try {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      console.log(`✓ [Issue #${issue.id}] Task completed cleanly in ${elapsed}m. Constructing AI summary...`);

      // 1. Push work up to origin
      await execPromise(`git push origin ${issue.branch}`);

      // 2. Extract the AI-generated summary written by the agent from the branch
      let aiSummary = "";
      try {
        aiSummary = execSync(
          `git show ${issue.branch}:.sandcastle/summary-${issue.id}.md`,
          { encoding: "utf-8" }
        ).trim();
      } catch (err) {
        console.warn(`⚠️ [Issue #${issue.id}] Could not retrieve automated summary file. Falling back to default description.`);
        aiSummary = `*No detailed summary file was found. The agent completed the task successfully but did not write the summary markdown.*`;
      }

      // 3. Write PR Body to a temporary file (prevents bash shell quote-escaping issues)
      const prBodyContent = `## 🤖 Sandcastle Agent PR: #${issue.id}\n\n${aiSummary}\n\n---\n*Created automatically by Sandcastle in ${elapsed} minutes.*`;
      fs.writeFileSync(tempPrBodyPath, prBodyContent, "utf-8");

      // 4. Create the Draft PR using the temp body file
      await execPromise(
        `gh pr create --draft --title "WIP: #${issue.id} ${issue.title}" --body-file "${tempPrBodyPath}" --head "${issue.branch}"`
      );

      console.log(`🎉 [Issue #${issue.id}] Draft PR successfully opened!`);
    } catch (gitError: any) {
      console.error(`❌ [Issue #${issue.id}] Git or PR command failed:`, gitError.message);
    } finally {
      // Clean up the temporary file safely
      if (fs.existsSync(tempPrBodyPath)) {
        fs.unlinkSync(tempPrBodyPath);
      }
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
    console.log("Analyzing issues and building workspace queue...");
    const plan = await sandcastle.run({
      hooks,
      sandbox: docker(),
      name: "planner",
      maxIterations: 1,
      agent: sandcastle.claudeCode("claude-opus-4-8"),
      promptFile: "./.sandcastle/plan-prompt.md",
      promptArgs: { ACTIVE_PRS_JSON: activePRsJson },
      output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
    });

    const issues = plan.output.issues;

    if (issues.length === 0) {
      console.log("Zero unblocked issues ready in the backlog. Work complete.");
      break;
    }

    console.log(`Planner selected ${issues.length} issue(s) to process. Spawning workers concurrently...`);

    // 2. Parallel Processing Phase (Runs completely independently)
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
