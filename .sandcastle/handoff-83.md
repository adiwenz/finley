# Handoff — issue 83

**Done so far:** every task the issue declares is complete (trace in `.sandcastle/summary-83.md`).
Two commits: `4872479` built the covered-earnings record from actual job compensation; `2e9718c`
then reworked the month-0 seam after review, and `53b5aac` fixed the Jobs-panel label that
followed from it. PR #227. `npm run check` green at 1306 tests.

Remaining work is NOT in the issue's task list — see Deferred.

## Live constraints

- **`SalaryTrajectory` has two required anchors and neither derives from the other.**
  `startingSalaryCents` feeds the historical reconstruction only; `currentSalaryCents` is the
  month-0 anchor and is authoritative for everything forward. A step between the reconstructed
  month −1 salary and the current salary is the authored truth — **do not reconcile it.** Full
  rationale in the `SalaryTrajectory` doc, `packages/engine/src/job.ts`.
- **The sign of `JobPayChange.month` alone decides which side owns it.** `< 0` →
  `reconstructHistoricalCompensation`; `>= 0` → `compileJobIncome`. There is no scope flag, and
  one was explicitly rejected (see Dead ends).
- **Keep `salaryGrowthMode` / `applyPayChanges` / `applyIncomeOverrides` shared** between the two
  halves in `compilePerson.ts`. Composition rules for raises and bonuses must not fork; the only
  thing the halves deliberately do not share is a baseline.
- **The forward series' `anchorMonth` stays `naturalStart`.** It is the growth *clock*, separate
  from the salary *amount* the anchor sets. Setting it to 0 would restart every job's raise
  anniversary. Pinned by the month-11/month-12 assertions in `job.test.ts`.
- **Wage-base caps and benefit rules stay in `@finley/rules`.** The engine records uncapped
  combined per-year earnings; capping is one downstream per-person-per-year step.
- `monthlyIncomeCentsOf` reads *current* pay and `withMonthlyIncome` sets *both* anchors. Two
  derived-gross consumers were re-based to match and must stay that way:
  `personDeferralFractionOf` (`packages/engine/src/authoring/jobs.ts`) and the forward scan in
  `packages/app/src/deferralLimit.ts`.

## Dead ends

- **Do not "fix" the month-0 discontinuity by carrying the historical series across the
  boundary.** That was the obvious reading of the original bug report and it is wrong: the
  authored current salary already reflects historical raises, so continuing the series reapplies
  them. This was tried in the first pass, reviewed, and replaced by the anchor design. A future
  agent seeing a salary step at month 0 will be tempted to close it — it is intentional.
- **An `untilNow` / `fromHereForward` scope field on `JobPayChange` was specified, then dropped.**
  It is redundant: a historical change that was later undone is already expressible as two dated
  changes. Month sign carries the distinction.
- Deriving `startingSalaryCents` by de-growing `currentSalaryCents` (or vice versa) was considered
  for the one-field Jobs form and rejected — it couples two independent authored facts and breaks
  as soon as a job has historical pay changes.

## Deferred

- **Historical compensation is not authorable through the UI.** Two gaps: the pay-change editor
  works off the Base + Adjustments panel's selected month, which only spans month 0 onward
  (`packages/app/src/components/baseAdjustments/payChangeEditor.tsx`), and the Jobs form has a
  single salary field that sets both anchors (`packages/app/src/planPeople.ts`). So the
  distinct-anchor scenarios the engine now supports are reachable only via the `Projection` API
  or `npx tsx repl.ts`. Needs pre-"now" month scrubbing plus a second salary input — worth its
  own issue, out of scope for #83.
- The partial-first-year calendar discrepancy (**#34**) is unchanged and still documented at
  `compilePersonPriorEarnings` in `packages/engine/src/compilePerson.ts`.

## Traps

- **Run vitest from the repo root** (`npx vitest run packages/engine/src/foo.test.ts`). The
  workspace config resolves its root to `packages/engine` while the `include` glob is written from
  the repo root, so running inside the package reports "No test files found" rather than failing
  loudly.
- `projectionFacade.test.ts` (~line 545) asserts `toEqual` on the **whole** `salary` object, so any
  new `SalaryTrajectory` field fails there and nowhere else. ~45 other fixtures build `salary`
  literals; typecheck catches those, but a literal split across a comment line will slip a
  mechanical regex — that one did.
