# Slice 9 (#72) — Migrate app off `incomeCents` + delete scalar `Plan` authoring

## Overview

Issue #72 is the **single hinge** of the Jobs & Household redesign: the one breaking
commit that flips the additively-built `Job` model on and deletes the scalar income path
that slices 1–8 kept alive. This branch:

- Deletes the scalar earned-income authoring from the engine — `Plan.incomeCents`,
  `careerStartAge`, `retirementDeferralPct`, `surplusSwept`, the `JobChangeEvent`
  life-event, and the scalar income branch of `createProjectionBase`.
- Makes the first-class **`Job`** the sole source of truth for earned income, the
  pre-tax 401(k) deferral (§11), and when a career began (the job's `startYear`, §4.6).
- Closes the **income-row honesty bug** (#71): editing the income row in *Base +
  Adjustments* now writes for real — a `fromHereForward` edit is a **raise** on the
  person's job (moving the income graph *and* net worth); a `thisMonthOnly` edit posts a
  **real one-off ledger transaction** for the delta. The panel's local `incomeOverrides`
  state is gone.
- Folds the authoring roster onto the standing **`Person`** type: the app holds/edits
  `Person`s, `SimPerson` is derived at the sim boundary via a new `compilePerson`, and
  `SimPerson` is no longer a public engine export.

Delivered as two review commits (squash-merge intended):

1. `e89c53e` — core scalar→Job migration + income-row writes + `JobChangeEvent` removal.
2. `caaf76a` — `Person` roster retype + `SimPerson` de-export.

## RGR Verification Details

The migration is a large, type-driven refactor, so the existing suite (692 tests) was
the regression harness, tightened at each step:

- **RED→GREEN, engine core:** after removing the scalar fields from `Plan` and the scalar
  branch from `createProjectionBase`, `tsc` flagged every call site (≈15 files). Each was
  migrated to the `Job` model; the headline guard is `job.test.ts` — a single open-ended
  `realGrowthPct: 0` career job reproduces the old scalar income series **byte-for-byte**,
  so the default plan's projection did not move.
- **RED (real bug found):** converting the default plan from scalar income to a career job
  turned the retirement headline **infeasible** (`fullRetirementAge` → null while the plan
  demonstrably survives at 73). Root cause: `ceaseAllJobsAtAge` resolved a `null`-end
  career job to the *original* `retirementAge` instead of the full-retirement **candidate
  age**, so the career job never ran past 65. Fixed → GREEN (retirementView #37 + barista
  solver tests all pass).
- **GREEN, income row:** `baseAdjustmentsPanel.test.tsx` — a `fromHereForward` income edit
  to $9,000 now shows $9,000 at the edited month *read off the re-projected plan* (the
  raise is a real `plan.jobs` split), and a `thisMonthOnly` edit routes a ledger
  transaction for the +$800 delta.
- **GREEN, roster retype:** the `Person` roster recomputes the same `priorEarningsCents`
  at the same `startYear`, so no numbers moved — verified by re-running the
  retirement/projection/job suites (49 tests) plus the full suite.

Final: **692 tests pass** (647 pass + 45 todo), `tsc` clean, engine purity clean.

## Key Decisions & Why

- **Kept the scalar EXPENSE fallback (`expenseCents`/`expenseOverrides`).** The issue's
  ACs enumerate only the *income/deferral/surplus* scalars for removal; `expenseCents`
  is owned by the #67/#71 budget-line work. Keeping it as the engine-native fixture
  fallback (a plan with no `budgetLines`) dramatically narrowed the blast radius without
  violating any AC. `budgetLines` stays optional; `jobs` became **required**.
- **A raise = splitting the career job.** Jobs key by calendar year (§2) and carry one
  salary trajectory (multi-segment salaries are a documented backlog item). A
  `fromHereForward` income edit therefore ends the current career segment at the raise
  year and starts a fresh open-ended segment at the new (real-flat) salary — which the
  simulator anchors so the typed figure is exactly what it pays that month. This keeps
  ≤1 open-ended job per person and moves the graph + net worth for real.
- **One-off income = a one-month ledger series.** There is no generic "cash event"
  primitive, so `thisMonthOnly` records a `BudgetItemStartEvent` (income for a bonus,
  expense for a missed paycheck) plus a `BudgetItemEndEvent` the next month, wired through
  `main.tsx` (which owns the ledger). The panel takes an optional `onIncomeTransaction`
  callback so it still renders the route in isolated tests.
- **Surplus idles; the sweep lever is gone.** `surplusSwept` is deleted and leftover cash
  idles; investing surplus is now expressed as a brokerage contribution budget line (the
  §12/§15 model), not a scalar toggle.
- **`SimPerson` boundary moved down to the sim input.** The roster holds authoring
  `Person`s; `buildHouseholdSimInput` compiles each to a `SimPerson` via `compilePerson`.
  `HouseholdSimInput.persons` stays `SimPerson`, so the sim core / governmentBenefit / rmd
  are untouched. De-export is surgical: `projection/simulate` re-exports its public types
  explicitly, omitting `SimPerson`; internal code imports it from `./simulate.types`.
- **Latent solver bug fixed in scope.** The `ceaseAllJobsAtAge` fix is a genuine
  correctness improvement the scalar default had masked, not a test-fitting hack: full
  retirement ("work-optional age") legitimately lets the career job run to the candidate
  age.

## Changes Made

**Engine**
- `plan.ts` — removed `incomeCents`, `careerStartAge`, `retirementDeferralPct`,
  `surplusSwept`; `jobs` now required.
- `projectionBase.ts` — `createProjectionBase` always compiles the primary member's jobs
  (deleted the scalar income branch, `seedPriorEarnings`, `careerEarningsCents`,
  `fullCareerEarningsCents`); surplus → idle; `initialPersons` now holds an authoring
  `Person`.
- `retirementSolver.ts` — `ceaseAllJobsAtAge` resolves a `null`-end job to the candidate
  full-retirement age.
- `ledger/eventTypes.ts`, `eventHandlers.ts`, `eventValidation.ts` — deleted
  `JobChangeEvent` (interface, handler, validation case, union member).
- `compilePerson.ts` — new `compilePerson(person, nowYear, inflationRate): SimPerson`.
- `projection/buildHouseholdInput.ts` — compiles the roster `Person`s → `SimPerson` at the
  sim boundary.
- `ledger/{household,interpretState,ledgerBase}.ts`, `projection/snapshot.ts` — roster and
  `membersAt`/`HouseholdSnapshot.persons` retyped to `Person`.
- `projection/simulate.ts` — explicit type re-export omitting `SimPerson`.
- `projectionRoot.ts` — `marry` mints a `Person`; `MarryInput` gains
  `retirementTargetAge?`/`jobs?`, drops `priorEarningsCents`.
- `testing/samplePlan.ts` — `careerJob()` helper; `samplePlan`/`baristaPlan` on the Job
  model.

**App**
- `planPeople.ts` (new) — read/write helpers over the primary **career job**
  (`monthlyIncomeCents`, `careerDeferralFraction`, `careerStartAge`, `setMonthlyIncome`,
  `setCareerDeferralFraction`, `setCareerStartAge`, `applyIncomeRaise`).
- `planDefaults.ts` — default plan ships one open-ended career job + the prepopulated Base
  budget template.
- `deferralLimit.ts` — reads salary + deferral off the career job.
- `budgetEditor.tsx` — income / career-start / 401(k) controls drive the career job;
  removed the surplus-destination control.
- `debugPanel.tsx` — config rows read the career job; leftover-cash row shows "idle".
- `components/baseAdjustments/baseAdjustmentsPanel.tsx` — income row reads the projection;
  `fromHereForward` → `applyIncomeRaise`, `thisMonthOnly` → `onIncomeTransaction`;
  deleted `incomeOverrides`.
- `main.tsx` — `recordIncomeTransaction` wires the one-off income delta to the ledger.
- `ledgerView.ts`, `addEventForm/addEventForm.tsx` — dropped `JobChangeEvent`;
  `jobForm.tsx` deleted.
- `addEventForm/formControls.tsx`, `relationshipForm.tsx` — owner-picker + partner
  authoring on `Person`.
- Tests across engine + app updated to the Job/Person model.

## Verification & Testing

```
tsc --noEmit             → 0 errors
vitest run               → Test Files 56 passed (56)
                            Tests 647 passed | 45 todo (692)
check:purity             → ✓ no I/O and no app/rules imports in engine source
```

Residual `incomeCents` / `retirementDeferralPct` / `surplusSwept` string matches are all
historical doc comments; no live references remain in engine or app, and no `SimPerson`
references remain in the app.

## Notes for the Next Iteration

- **`main.tsx` full Projection-facade migration is deferred.** The scalar authoring is
  deleted (the substantive half of that AC) and the *Base + Adjustments* panel already
  projects through the `Projection` facade. `main.tsx` still wires the low-level barrel
  (`createProjectionBase` → `interpretLedger` → `buildHouseholdSimInput` →
  `simulateHousehold`) because it also needs the `Household` (snapshot + owner-picker) and
  the `SimulationReport`, which `Projection.run()` does not yet expose. Extending the
  facade to surface those and switching `main.tsx` over (updating `mainState.test`'s
  memoization spy) is the clean follow-up.
- **Partner income is not yet authorable.** A married partner joins with `jobs: []` (no
  earned income / benefit basis of their own), matching today's app behaviour; authoring
  partner jobs is a UI follow-up.
- **Household aggregate fold (issue-72 comment).** Folding `Household` (ledger aggregate)
  and `StandingHousehold`/`AccountHousehold` into one authoring household was flagged in
  the issue discussion; the roster is now `Person`-based, which is the groundwork, but the
  two aggregates are not yet unified.
