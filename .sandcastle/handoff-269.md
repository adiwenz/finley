# Handoff — issue 269

**Done so far:** Task 1 (exploration rule in `AGENTS.md`), Task 2 (make the REPL the obvious
place to explore), Task 3 (mirror the exploration rule into the implement prompt + guard both),
Task 4 (reimplement `planFixtures.ts` over `replaceJob` / `replacePartnerJob`).
Tasks 5–20 remain — see the issue body.

## Live constraints
- **Exploration rule** now lives in two docs and is pinned by
  `packages/engine/src/comments.guard.test.ts`:
  - `AGENTS.md`, `## Testing & exploration` section.
  - `.sandcastle/new_flow/implement-prompt.md`, a bullet under `### 🛠️ Required Skills`.
  The guard asserts **both** docs match `/through the REPL/i` and `/pin what you observed/i`. If a
  later task rewords either place, keep those two phrases (or update the guard's patterns in the
  same commit) — otherwise the guard fails.
- `repl.ts` carries three read-only formatters over a `ProjectionResult` — `dumpMonths`,
  `waterfall`, `balances`. **Invariant:** they read a run, never call `run()`.
- `comments.guard.test.ts` only scans `*.ts(x)` under `packages/`, so it does not police
  `AGENTS.md`, root `repl.ts`/`playground.ts`, or the implement prompt for issue/PR numbers. Keep
  those files free of issue/PR numbers regardless.
- `npm run repl` and `npm run playground` exist in the root `package.json`.
- **`planFixtures.ts` no longer names any of the six doomed facade members.** Its three salary/
  deferral builders now route through `replaceJob` / `replacePartnerJob` via a private
  `replacingJob(id, edit)` helper that finds the job on either plane and spreads it. Exported
  signatures are unchanged; all 11 call sites across the 7 app test files are untouched. This
  unblocks:
  - **Task 7** (delete the `setProjectionJob{MonthlyIncome,CurrentMonthlyIncome,DeferralFraction}`
    delegates in `authoring/jobs.ts`) — no app caller left once task 5/6 clear the engine tests.
  - **Task 8** (delete `withMonthlyIncome` / `withCurrentMonthlyIncome` / `withDeferralFraction`
    from `job.ts`) — `planFixtures` deliberately **inlines** those transforms rather than importing
    them (the `deferral <= 0 → drop the key` asymmetry and the `RETIREMENT_ID` default are inlined
    too), precisely so the `with*` helpers become orphaned and deletable. Do not "simplify" the
    fixture by re-importing them — that would re-couple it to code task 8 deletes.

## Traps
- The six facade members (`updateJob`, `updatePartnerJob`, `setJobMonthlyIncome`,
  `setJobStartingMonthlyIncome`, `setJobCurrentMonthlyIncome`, `setJobDeferralFraction`) and the
  `with*` transforms **still exist** on the branch — task 4 only moved the *app* fixtures off them.
  Task 5 still owns rewriting `projectionFacade.test.ts` off the members and deleting the two
  deferral-asymmetry tests (the only test-count drop besides `allocations.test.ts`); tasks 6–8 own
  the deletions.

## Dead ends
- (none)

## Deferred
- (none — everything from task 5 on is owned by its declared task)
