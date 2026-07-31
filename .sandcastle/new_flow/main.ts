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
import { repoRoot, sandboxImageName } from "./repoPaths";
import { z } from "zod";
import { exec, execSync } from "child_process";
import { promisify, format } from "util";
import * as fs from "fs";
import * as path from "path";

const execPromise = promisify(exec);

// Make every console line hit the CI console immediately and in order.
//
// On GitHub Actions stdout is a pipe, not a TTY, so Node writes it
// ASYNCHRONOUSLY — the bytes are queued and only flushed when the event loop
// turns. This orchestrator prints its first milestones (Sandbox / Review handoff
// / Pipeline Iteration) during a synchronous startup burst (module init, docker
// provider setup, execSync) that runs before the first `await`, so those early
// lines sit unflushed until the loop frees up — the step looks like it started
// with no output. The previous fix, `process.stdout._handle.setBlocking(true)`,
// is a silent no-op here: under `tsx`'s child process on Node 20 the handle
// doesn't honor it, so nothing changed.
//
// Routing console.* through fs.writeSync(fd) is the version-independent cure: it
// writes straight to the file descriptor synchronously, at call time, bypassing
// the stream buffer — so a line is on the wire before the next statement runs,
// regardless of event-loop state. (Only the orchestrator's own milestones go to
// stdout; each agent's tool-by-tool thought process is streamed by
// `sandcastle.run()` into per-run .sandcastle/logs/*.log files — tail -f locally.)
const writeLine = (fd: number, args: unknown[]) => {
  try {
    fs.writeSync(fd, format(...(args as [unknown])) + "\n");
  } catch {
    // Never let a logging hiccup (e.g. EAGAIN on a momentarily full pipe) crash
    // a 5-hour run; fall back to the async stream.
    (fd === 2 ? process.stderr : process.stdout).write(format(...(args as [unknown])) + "\n");
  }
};
console.log = (...args: unknown[]) => writeLine(1, args);
console.info = (...args: unknown[]) => writeLine(1, args);
console.warn = (...args: unknown[]) => writeLine(2, args);
console.error = (...args: unknown[]) => writeLine(2, args);

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

// Fresh agents one unit of work may burn — a declared task, or the whole issue
// when none are declared. An agent stopped by the iteration ceiling loses its
// working tree but not its commits, so a successor carries on from the branch
// and the handoff note. Each continuation must be paid for by at least one green
// commit from its predecessor (see processSingleIssue), which is what stops a
// stuck agent from spinning through all three.
//
// Deliberately small, and not the ceiling on how much work an issue may get. An
// exhausted unit leaves its commits pushed and the issue queued, so the next
// planner iteration resumes it. The bound matters because a green commit proves
// activity, not convergence, and the run awaits its whole batch (Promise.
// allSettled below) — so one issue that never converges would stall the pipeline
// rather than just itself.
const CONTINUATION_ATTEMPTS = 3;

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
    // No skills mount: agents load skills from `.claude/skills` in the checked-out
    // repo, which rides along in the workspace bind-mount. That is the only source
    // that also reaches a CI runner and a cloud sandbox, neither of which has a
    // host ~/.claude to mount.
    //
    // The image name is pinned to the main checkout rather than left to
    // Sandcastle's directory-basename default, which would ask for
    // `sandcastle:finley-review-issue-138` if this were ever run from a worktree.
    // Identical to the default from the main checkout and on CI.
    return docker({ imageName: sandboxImageName(REPO_ROOT) });
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
  // The custom VCR image runs as a non-root `agent` user, but the no-image stock
  // runtime still boots as root, and Claude Code blocks
  // --dangerously-skip-permissions as root unless it knows it's sandboxed. It is
  // (an isolated microVM) in both cases, so declare it and keep both paths working.
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

// The main checkout, which is where `.sandcastle/.env`, `.sandcastle/worktrees/`
// and `.sandcastle/logs/` live. Sandcastle anchors all three at the working
// directory, so every run below passes `cwd: REPO_ROOT` to keep them put if the
// orchestrator is ever launched from a worktree. Equal to process.cwd() from the
// main checkout and on CI, so this is a no-op there.
const REPO_ROOT = repoRoot();

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
// Issue tasks: the unit an implementer agent actually runs on.
//
// An issue may declare a `## Tasks` section whose `###` subheadings are worked
// one at a time, each by a FRESH agent. That is the whole point: a single agent
// grinding an 80-iteration loop fills its context window and degrades on the
// later steps, where a per-task agent starts clean and only has to hold one
// task's worth of detail. The cost is a sandbox spin-up per task and a hard
// amnesia boundary between them — which is why the prompt makes each agent read
// the branch's commit log, and why RALPH's "notes for the next iteration" line
// stops being decorative.
//
// An issue with no `## Tasks` section runs exactly as before: one agent, whole
// issue. Most of the backlog is that shape, and forcing tasks onto it would
// mean rewriting every open issue before the next run.
// ---------------------------------------------------------------------------
interface IssueTask {
  /** 1-based, as presented to the agent ("Task 2 of 5"). */
  readonly index: number;
  readonly title: string;
  /** Everything under the task's heading — its detail, acceptance notes, snippets. */
  readonly body: string;
}

async function fetchIssueTasks(issueId: string): Promise<IssueTask[]> {
  let body: string;
  try {
    const { stdout } = await execPromise(`gh issue view ${issueId} --json body --jq .body`);
    body = stdout;
  } catch (error: any) {
    // A read failure must not sink the issue — fall back to whole-issue mode,
    // which is the same behaviour as an issue that declares no tasks.
    console.warn(`⚠️ [Issue #${issueId}] Could not read issue body for tasks: ${error.message}`);
    return [];
  }

  const lines = body.split("\n");
  const start = lines.findIndex((line) => /^##\s+Tasks\s*$/i.test(line.trim()));
  if (start === -1) return [];

  // The section ends at the next H2. `^##\s` cannot match an H3, since `###` has
  // no whitespace at offset 2 — so subheadings inside the section survive.
  const section: string[] = [];
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    section.push(lines[i]);
  }

  const tasks: IssueTask[] = [];
  let current: { title: string; body: string[] } | null = null;
  for (const line of section) {
    const heading = /^###\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      if (current) tasks.push({ index: tasks.length + 1, title: current.title, body: current.body.join("\n").trim() });
      // Strip a leading ordinal ("1. ", "2) ") — the index is authoritative, and
      // a hand-numbered heading drifts the moment a task is inserted.
      current = { title: heading[1].replace(/^\d+[.)]\s*/, ""), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) tasks.push({ index: tasks.length + 1, title: current.title, body: current.body.join("\n").trim() });

  return tasks;
}

// How many tasks a previous run already landed on this branch.
//
// Resume support, and the reason task commits carry a `[task N/M]` marker: a
// run that dies mid-issue (CI timeout, cancelled workflow, a task that never
// signals) leaves finished tasks committed and pushed. Re-running must pick up
// where it stopped rather than reimplementing task 1 on top of itself — the
// branch is deterministic precisely so progress accumulates across runs.
//
// Returns 0 when the branch is absent (a first run) or carries no markers (an
// older run, or whole-issue mode), which correctly means "start at the top".
async function completedTaskCount(branch: string): Promise<number> {
  // A CI runner clones fresh, so the branch may exist only as a remote ref.
  for (const ref of [branch, `origin/${branch}`]) {
    try {
      const { stdout } = await execPromise(`git log --format=%s origin/main..${ref}`);
      let highest = 0;
      for (const subject of stdout.split("\n")) {
        const marker = /\[task (\d+)\/\d+\]/.exec(subject);
        if (marker) highest = Math.max(highest, Number(marker[1]));
      }
      return highest;
    } catch {
      // Ref doesn't resolve — try the remote form, then give up.
    }
  }
  return 0;
}

// Commits this branch carries beyond `main`, from any earlier run.
//
// Whole-issue mode has no `[task N/M]` ledger, so this is the only way to tell
// the two zero-commit completions apart. An agent that signals done having
// committed nothing has either found the issue already finished by a previous
// run — real work is on the branch, and redoing it would be the bug — or done
// nothing at all, on a branch level with `main`. The first is success; the
// second is the failure the signal was supposed to catch.
//
// Returns 0 when the branch does not resolve, which reads as the failure case —
// the safe direction, since it leaves the issue queued rather than marking an
// empty branch done.
async function remoteBranchExists(branch: string): Promise<boolean> {
  try {
    const { stdout } = await execPromise(`git ls-remote --heads origin ${branch}`);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function branchCommitCount(branch: string): Promise<number> {
  for (const ref of [branch, `origin/${branch}`]) {
    try {
      const { stdout } = await execPromise(`git rev-list --count origin/main..${ref}`);
      return Number(stdout.trim()) || 0;
    } catch {
      // Ref doesn't resolve — try the remote form, then give up.
    }
  }
  return 0;
}

// One implementer agent, on one branch. Called once per task, or once for the
// whole issue when the issue declares none.
async function runImplementer(args: {
  issue: { id: string; title: string; branch: string };
  task?: IssueTask;
  taskTotal: number;
  /** Titles of the tasks already committed on this branch, for the handoff. */
  priorTasks: readonly string[];
}) {
  const { issue, task, taskTotal, priorTasks } = args;
  return sandcastle.run({
    hooks,
    copyToWorktree,
    sandbox,
    cwd: REPO_ROOT,
    branchStrategy: { type: "branch", branch: issue.branch },
    name: task ? `implementer-task-${task.index}` : "implementer",
    // Re-prompted until it emits the completion signal (default
    // "<promise>COMPLETE</promise>") or hits this cap. Completion can't be
    // detected via structured output (Output.*) instead — that requires
    // maxIterations: 1, and an implementer needs the full red-green-refactor
    // loop across many turns. A single task needs far fewer of those than a
    // whole issue, and the lower cap surfaces a stuck task rather than letting
    // it eat the run's budget.
    maxIterations: task ? 40 : 80,
    agent: sandcastle.claudeCode("claude-opus-4-8"),
    promptFile: "./.sandcastle/new_flow/implement-prompt.md",
    promptArgs: {
      TASK_ID: issue.id,
      ISSUE_TITLE: issue.title,
      BRANCH: issue.branch,
      // Whole-issue mode leaves these empty; the prompt branches on TASK_TITLE.
      TASK_NUMBER: task ? String(task.index) : "",
      TASK_TOTAL: task ? String(taskTotal) : "",
      TASK_TITLE: task ? task.title : "",
      TASK_BODY: task ? task.body : "",
      PRIOR_TASKS: priorTasks.length > 0 ? priorTasks.map((t, i) => `${i + 1}. ${t}`).join("\n") : "(none — this is the first task)",
    },
  });
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
  // Commits landed on the branch this run. Read after the try block so a partial
  // run still gets pushed — see the push step below.
  let totalCommits = 0;
  // Set only when the agent's own host worktree survived the run (uncommitted
  // changes). When present we can review in place instead of creating a new one.
  let preservedWorktreePath: string | undefined;

  try {
    const tasks = await fetchIssueTasks(issue.id);
    console.log(
      tasks.length > 0
        ? `📋 [Issue #${issue.id}] ${tasks.length} task(s) declared — one fresh agent per task.`
        : `📋 [Issue #${issue.id}] No "## Tasks" section — one agent for the whole issue.`,
    );

    // Whole-issue mode is modelled as a single undefined task so there is ONE
    // loop rather than two code paths that drift apart as this evolves. Both
    // modes then agree on what a unit of work is: a declared task, or the issue.
    // Continuation is per unit, tracked by the loop below, not by extra entries
    // here — an attempt is another go at the same work, not more of it.
    const runs: (IssueTask | undefined)[] = tasks.length > 0 ? tasks : [undefined];

    // Resume: skip tasks a previous run already committed, but keep their titles
    // so the next agent's handoff context still lists everything done so far.
    const alreadyDone = tasks.length > 0 ? await completedTaskCount(issue.branch) : 0;
    if (alreadyDone > 0) {
      console.log(`⏭️  [Issue #${issue.id}] Resuming — tasks 1-${alreadyDone} already on ${issue.branch}.`);
    }
    const doneTasks: string[] = tasks.slice(0, alreadyDone).map((t) => t.title);
    let allCompleted = true;
    // Whole-issue mode has no per-task ledger to infer completion from, so the
    // one agent that signalled done is recorded here.
    let wholeIssueDone = false;
    // Agents spent so far, across all units — reported when the run gives up.
    let agentsSpent = 0;

    for (let unit = 0; unit < runs.length; unit++) {
      const task = runs[unit];
      if (task && task.index <= alreadyDone) continue;

      // Retries re-enter with the same `unit`, so this counts attempts on THIS
      // piece of work rather than on the issue.
      let attemptsOnUnit = 0;
      let unitDone = false;

      while (attemptsOnUnit < CONTINUATION_ATTEMPTS && !unitDone) {
        attemptsOnUnit += 1;
        agentsSpent += 1;
        const base = task ? `Task ${task.index}/${tasks.length} — ${task.title}` : "whole issue";
        // Only annotate retries; the first attempt is the ordinary case and
        // saying so on every line buries the ones that matter.
        const label = attemptsOnUnit > 1 ? `${base} (attempt ${attemptsOnUnit}/${CONTINUATION_ATTEMPTS})` : base;
        console.log(`🚀 [Issue #${issue.id}] Starting ${label}...`);

        const result = await runImplementer({ issue, task, taskTotal: tasks.length, priorTasks: doneTasks });

        // Count commits before judging the run, not on the success paths only. A
        // commit exists on the branch whether or not its author got to the end,
        // and the push below is gated on this count — so attributing them only to
        // successful runs is what would leave a cut-off agent's work unpushed.
        totalCommits += result.commits.length;
        if (result.commits.length > 0) preservedWorktreePath = result.preservedWorktreePath;

        // The implementer runs typecheck + tests inside its own sandbox before
        // signaling done, so success is determined entirely from the sandbox
        // result — never from a host checkout, which would corrupt sibling agents
        // running concurrently on other branches.
        if (result.completionSignal !== undefined && result.commits.length > 0) {
          if (task) doneTasks.push(task.title);
          else wholeIssueDone = true;
          console.log(`✓ [Issue #${issue.id}] ${label} COMPLETE (${result.commits.length} commit(s)).`);
          unitDone = true;
          break;
        }

        // Whole-issue mode, done signalled, nothing committed: the issue was
        // already finished by an earlier run — this agent oriented, found the work
        // on the branch, and correctly declined to redo it. Re-queuing that would
        // spend an agent per run forever on an issue that is finished.
        if (!task && result.completionSignal !== undefined && (await branchCommitCount(issue.branch)) > 0) {
          wholeIssueDone = true;
          console.log(`✓ [Issue #${issue.id}] ${label}: already complete on ${issue.branch}; nothing to do.`);
          unitDone = true;
          break;
        }

        // An agent that committed green work and then ran out of iterations made
        // progress; it just needed more room than one agent has. Its successor
        // orients from those commits and the handoff note it left, and carries on
        // with the same unit. One that committed nothing is stuck on something a
        // second identical agent would be stuck on too, so it falls through.
        //
        // This applies to a declared task as much as to a whole issue. Without it
        // a task too big for one agent fails identically on every future run,
        // since nothing about the retry differs.
        if (result.commits.length > 0 && attemptsOnUnit < CONTINUATION_ATTEMPTS) {
          console.warn(
            `⏳ [Issue #${issue.id}] ${label}: iteration limit reached with ${result.commits.length} commit(s). Handing the branch to a fresh agent.`,
          );
          continue;
        }

        allCompleted = false;
        console.warn(
          result.completionSignal !== undefined
            ? `⚠️ [Issue #${issue.id}] ${label}: COMPLETE promise but no commits.`
            : `⚠️ [Issue #${issue.id}] ${label}: no completion signal within the iteration limit.`,
        );
        break;
      }

      // Stop the chain. A later task builds on this one's code, so running it
      // against a half-finished base yields a branch nobody can review — and
      // buries the real failure under a second, derivative one.
      if (!unitDone) break;
    }

    if (tasks.length > 0) {
      // A resumed run that finds every task already committed does no work and
      // so produces no commits — but the issue IS finished (a previous run died
      // after the last task, before relabeling). Treat that as success or it can
      // never leave the queue.
      const nothingLeftToDo = alreadyDone >= tasks.length;
      success = allCompleted && (totalCommits > 0 || nothingLeftToDo);
    } else {
      // No such ledger without a task breakdown: commits prove work happened,
      // never that the issue is done, so only the completion signal counts.
      // Exhausting the continuation attempts is a failure even though every
      // attempt committed.
      success = wholeIssueDone;
    }
    if (!success && totalCommits > 0) {
      console.warn(
        tasks.length > 0
          ? `⚠️ [Issue #${issue.id}] Stopped after ${doneTasks.length}/${tasks.length} task(s), ${totalCommits} commit(s) this run on ${issue.branch}. Issue stays queued; the next run resumes from task ${doneTasks.length + 1}.`
          : `⚠️ [Issue #${issue.id}] Unfinished after ${agentsSpent} agent(s), ${totalCommits} commit(s) this run on ${issue.branch}. Issue stays queued; the next run picks up from those commits and the handoff note.`,
      );
    }
  } catch (error: any) {
    console.error(`[Issue #${issue.id}] Runner error:`, error);
  }

  // --- Push whatever landed, complete or not ---
  //
  // Deliberately OUTSIDE the success check. In `push` (CI) mode this is the ONLY
  // durable handoff — the runner is ephemeral — so an unpushed branch is lost
  // work, and a partial run is exactly the case worth preserving: the pushed
  // commits are what a re-run resumes from. In `worktree` mode it is an
  // off-machine backup on top of the local branch. Non-fatal either way so
  // sibling issues still finish.
  let pushed = false;
  if (totalCommits > 0) {
    try {
      await execPromise(`git push origin ${issue.branch}`);
      pushed = true;
      console.log(`⬆️  [Issue #${issue.id}] Pushed ${issue.branch} to origin (${totalCommits} commit(s) this run).`);
    } catch (pushError: any) {
      console.warn(`⚠️ [Issue #${issue.id}] Could not push branch: ${pushError.message}`);
    }
  }

  // --- Surface it for review (per REVIEW_MODE) ---
  if (success) {
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`✓ [Issue #${issue.id}] Issue completed cleanly in ${elapsed}m.`);

    // Take the issue out of the planner's queue so it is not re-selected, while
    // leaving it open for human review.
    await markIssueDone(issue);

    if (REVIEW_MODE === "push") {
      // Ephemeral/CI: no local worktree would survive the run, so the pushed
      // branch is the review artifact. Print how to review it locally later.
      console.log(`FINISHED: ${issue.branch}`);
      // Not `pushed`, which only records a push made by THIS run. An issue
      // finished by an earlier run has nothing new to push, and its branch is
      // already on origin — reviewable, and not the lost-work case below.
      if (pushed || (await remoteBranchExists(issue.branch))) {
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
    console.error(
      totalCommits > 0 && pushed
        ? `🚨 [Issue #${issue.id}] Did not complete. Partial work is on origin/${issue.branch} — re-run to resume.`
        : `🚨 [Issue #${issue.id}] Did not complete — no branch handed off for review.`,
    );
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
      cwd: REPO_ROOT,
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
