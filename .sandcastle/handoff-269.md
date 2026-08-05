# Handoff — issue 269

**Done so far:** Task 1 (exploration rule in `AGENTS.md`), Task 2 (make the REPL the obvious
place to explore), Task 3 (mirror the exploration rule into the implement prompt + guard both),
Task 4 (reimplement `planFixtures.ts` over `replaceJob` / `replacePartnerJob`), Task 5 (move
`projectionFacade.test.ts` off the six doomed facade members).
Tasks 6–20 remain — see the issue body.

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
- **`planFixtures.ts` no longer names any of the six doomed facade members** (task 4). Its three
  salary/deferral builders route through `replaceJob` / `replacePartnerJob` via a private
  `replacingJob(id, edit)` helper that finds the job on either plane and spreads it. It deliberately
  **inlines** the `with*` transforms (the `deferral <= 0 → drop the key` asymmetry and the
  `RETIREMENT_ID` default), precisely so the `with*` helpers become orphaned and deletable by
  task 8. Do not "simplify" the fixture by re-importing them.
- **`projectionFacade.test.ts` no longer names any of the six doomed members** (task 5). Every edit
  that used `updateJob` / `updatePartnerJob` / the setters now reads the job back through `p.plan`
  (or `partnerEvent(p).person.jobs` on the partner plane) and spreads it into
  `replaceJob` / `replacePartnerJob`. Spreading `...job` is safe: `replaceProjectionJob` re-stamps
  `id`/`ownerId` off the prior record via `resolveJobInput`, so the input's copies are ignored.

## Traps
- The six facade members (`updateJob`, `updatePartnerJob`, `setJobMonthlyIncome`,
  `setJobStartingMonthlyIncome`, `setJobCurrentMonthlyIncome`, `setJobDeferralFraction`) and the
  `with*` transforms in `job.ts` **still exist** on the branch — tasks 4 and 5 only moved *callers*
  off them. Remaining owners of the deletions:
  - **Task 6** — `packages/engine/src/authoringInputs.guard.test.ts` still calls `updateJob` once;
    re-express that guard through `replaceJob`, keeping its failure mode (an input cannot smuggle an
    `ownerId`). This is the last remaining call to any of the six.
  - **Task 7** — delete the `setProjectionJob{MonthlyIncome,CurrentMonthlyIncome,DeferralFraction}`
    delegates in `authoring/jobs.ts`. Note `authoring/jobs.test.ts` still exercises them, so that
    suite is part of the same task.
  - **Task 8** — delete `withMonthlyIncome` / `withCurrentMonthlyIncome` / `withDeferralFraction`
    from `job.ts` once orphaned.
- **Test-count change:** task 5 deleted the two `setJobDeferralFraction`-asymmetry `it`s
  (`projectionFacade.test.ts` went 176 → 174 `it`s; full suite 1810 → 1808 passing). Per the issue,
  this and `allocations.test.ts` are the *only* intended drops in total test count across the whole
  issue — if a later task's suite count falls unexpectedly, treat it as a regression, not a cleanup.

## Dead ends
- (none)

## Deferred
- (none — everything from task 6 on is owned by its declared task)
