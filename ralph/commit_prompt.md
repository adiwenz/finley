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

# IMPLEMENTATION

Use /tdd to complete the task.

# FEEDBACK LOOPS

Before committing, run the feedback loops:

- `npm run test` to run the tests
- `npm run typecheck` to run the type checker

# COMMIT

Make a git commit. The commit message must:

1. Include key decisions made
2. Include files changed
3. Blockers or notes for next iteration
4. Whether the issue is now complete

DO NOT CREATE A PR
ONLY WORK ON A SINGLE TASK.
