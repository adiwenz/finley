# ISSUES

Open GitHub issues labeled `ready-for-agent` are provided at the start of context. Each issue includes its number, title, and body. Parse them to understand the open work.

These are the AFK issues — fully specified and safe to work on autonomously. Issues without the `ready-for-agent` label require a human in the loop and are never passed to you, so you never work on them.

You can also inspect any issue yourself with `gh`, e.g. `gh issue view <number>`.

You've also been passed a file containing the last few commits. Review these to understand what work has been done.

If there are no open `ready-for-agent` issues, output <promise>NO MORE TASKS</promise>.

# ASSIGNMENT

If the Issues block above contains exactly ONE issue, that issue is your assignment. Skip TASK SELECTION entirely: do NOT run `gh issue list`, do NOT weigh priorities, and do NOT switch to any other issue. Work only on the assigned issue. (Still run the COMPLETION CHECK below — if it is already done, output <promise>NO MORE TASKS</promise>.)

Only when the block contains multiple issues, or none, should you use the TASK SELECTION priorities below to choose what to work on.

# TASK SELECTION

Pick the next task. Prioritize tasks in this order:

1. Critical bugfixes
2. Development infrastructure

Getting development infrastructure like tests and types and dev scripts ready is an important precursor to building features.

3. Tracer bullets for new features

Tracer bullets are small slices of functionality that go through all layers of the system, allowing you to test and validate your approach early. This helps in identifying potential issues and ensures that the overall architecture is sound before investing significant time in development.

TL;DR - build a tiny, end-to-end slice of the feature first, then expand it out.

4. Polish and quick wins
5. Refactors

# COMPLETION CHECK

Before exploring the repo, decide whether the task you picked is already done. Use only cheap signals: the issue body, the recent commits you were passed, and a quick `gh issue view <number>` (a closed issue, or a recent commit that already references it, means it's done).

If the task is already complete, output <promise>NO MORE TASKS</promise> and STOP IMMEDIATELY. Do NOT explore the repo, run tests, or make any changes.

# EXPLORATION

Explore the repo.

# SANDBOX ENVIRONMENT

You run in a Docker sandbox whose workspace is a virtiofs mount, and writing native binaries onto it corrupts them — so a bare `npm install` breaks the toolchain (esbuild/rollup). If the task needs a new or changed dependency, run `ralph/nm-install.sh <npm install args…>` instead of `npm install` (e.g. `ralph/nm-install.sh -D some-dep`). It installs on the native filesystem and copies the result back intact, updating package.json / package-lock.json for your commit. Non-install npm commands (`npm run test`, `npm run check`, …) are fine to run directly.

# IMPLEMENTATION

Use /tdd to complete the task.

# FEEDBACK LOOPS

Before committing, run the repo's canonical gate and make sure it is fully green:

- `npm run check` — runs the engine-purity check (`check:purity`), the type checker, and the tests, in that order.

If any part fails, fix it BEFORE committing. Never commit a red tree.

# COMMIT

Make a git commit — but only once `npm run check` is green (see FEEDBACK LOOPS). Never commit a red tree.

If the issue defines a rollout or commit sequence, follow it: make ONE green commit for the next step in that sequence and leave the remaining steps for later iterations, rather than collapsing the whole sequence into a single commit. Use the "Previous commits" context to see which steps are already done.

The commit message must:

1. Include key decisions made
2. Include files changed
3. Blockers or notes for next iteration
4. Whether the issue is now complete

DO NOT CREATE A PR
ONLY WORK ON A SINGLE TASK.
