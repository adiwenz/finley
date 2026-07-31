# Issue 96 — No payroll tax (FICA): the 7.65% employee share is never withheld

## Overview

The model charged income tax but **no payroll tax**. The 7.65% employee FICA share
(6.2% OASDI + 1.45% Medicare) was never withheld from earned income. On the default plan
($60k/yr single filer) that missing withholding — ~$4,590/yr — was essentially the plan's
**entire** savings surplus, so the projection compounded a surplus that shouldn't exist.

This branch adds employee payroll-tax withholding as a **separate seam** from income tax,
charged on wages only, on the full pre-deferral gross, and stopping automatically at
retirement. Two things the original issue flagged as blockers had already been resolved on
`main` by the time this landed and made the fix clean:

- **Jobs already book income as `wages`** (`packages/engine/src/compilePerson.ts`), not the
  ambiguous `ordinaryIncome`. So FICA charges `wages` and never touches the `ordinaryIncome`
  a 401(k)/IRA/RMD withdrawal produces — the withdrawal-collision trap is avoided with no
  workaround.
- **The payroll-tax rate/threshold tables already existed** (`packages/rules/src/payrollTax.ts`,
  the separately-tracked tables issue): OASDI 6.2% to a wage-indexed cap, Medicare 1.45%
  uncapped, the 0.9% Additional Medicare surtax over $200k, and `PAYROLL_TAX_ASSUMPTIONS`.
  This issue wires them into a live engine seam.

The work was done in two commits on this branch: **Part A** — the engine payroll seam inside
the allocation waterfall; **Part B** — the end-to-end wiring, the US jurisdiction method, and
the downstream test migration.

## RGR Verification Details

- **Part A (waterfall seam), RED:** four cases in `waterfall.test.ts` asserting a
  `computePayrollTaxCents` seam removes tax from take-home, charges the FULL gross (a 401(k)
  deferral does not shrink it), charges only the year-to-date DIFFERENCE (so a cap binds on
  cumulative earnings), and ignores non-wage income. All failed to compile/assert → GREEN
  after adding the seam to the waterfall.
- **Part B (end-to-end), RED:** `report.test.ts` — a synthetic capped-FICA jurisdiction whose
  charge on the default plan is $300/mo for months 0–3 then $0 once year-to-date wages hit the
  cap (proving the seam is fed CUMULATIVE, not annualized-monthly, earnings), plus a
  wages-only seam that leaves `ordinaryIncome` untouched. `index.test.ts` (rules) — the US
  seam charges 7.65% on $60k of wages and $0 on `ordinaryIncome`, and discloses its
  simplifications. Failed on the missing `payrollTaxCents` field/seam → GREEN after wiring.
- **Behavioural confirmation on the real default plan:** $4,590/yr (7.65% of $60k) withheld
  during working years, growing with the salary; **$0 from retirement (age 65) onward**; and
  **$0 on every retirement-account withdrawal** — exactly the issue's specification.

## Key Decisions & Why

- **A separate seam, not an extension of `computeTaxCents`.** Payroll tax's base
  (pre-deferral gross) and category set (earned income only) both differ from income tax, and
  keeping it separate leaves the income-tax attribution invariants (`assertTaxAttributionReconciles`)
  untouched. It surfaces as its own `payrollTaxCents` line on every `ReportMonth`, so
  after-tax gross is `totalIncome − taxCents − payrollTaxCents`. This also answers the issue's
  open question "should FICA go in expenses or taxes?": neither an expense nor folded into
  income tax — a distinct tax line.
- **Accumulate, then charge the difference.** The rules function states the correct
  WHOLE-YEAR figure; the OASDI cap binds on cumulative earnings, not on a single month
  annualized. The engine keeps a per-person, per-calendar-year `earnedByPersonYear`
  accumulator (mirroring the existing deferral accumulator) and charges
  `seam(year-to-date after) − seam(year-to-date before)` each month. The seam is monotone
  non-decreasing in earnings, so the difference is never a credit. For a level earner this
  equals annualizing; for a lumpy one (a bonus) or a high earner near the cap it is exact.
- **The engine stays jurisdiction-neutral.** It accumulates pre-deferral gross by category and
  hands the whole map to the seam; the US rule picks out `wages` and routes it to the existing
  tables. The engine never names `wages` — which categories are "earned" is the jurisdiction's
  call, so a retirement withdrawal (`ordinaryIncome`) is never payroll-taxed.
- **FICA stops at retirement for free.** Because it applies to earned income only and wages
  cease when work stops, no special-casing is needed — verified $0 from age 65.

## Scope decisions (deferred, out of v1)

- **Self-employment tax (15.3%).** Jobs are W-2 wages; SE income is a different shape. Out.
- **Per-source FICA attribution.** FICA is reported as one household line, not split per job,
  so `buildFlows`'s per-source `netCashFlowCents` does not haircut wages for FICA. Acceptable
  for v1; the household take-home and the whole projection are correct.
- **Withholding vs. year-end reconciliation (#55).** FICA is exact by paycheck with no
  reconciliation, so it does not wait on that work.

## Changes Made

**Engine**
- `jurisdiction.ts` — new optional `Jurisdiction.computePayrollTaxCents(annualEarnedByCategory, ctx)`.
- `projection/waterfall.types.ts` — `WaterfallInput.computePayrollTaxCents` + `priorEarnedByPersonCents`;
  `WaterfallResult.payrollTaxCents` + `earnedThisMonthByPersonCents`.
- `projection/waterfall.ts` — accumulate pre-deferral earned gross by category; compute
  per-person payroll tax as the cumulative-after-minus-before difference; subtract it from
  take-home.
- `projection/runState.ts` — `earnedByPersonYear` accumulator (keyed `${personId}|${year}`).
- `projection/allocationStep.ts` — pass the seam + prior-earnings into the waterfall, fold the
  month's earnings into the accumulator, return `payrollTaxCents`.
- `projection/simulate.ts`, `reportFlows.ts`, `simulate.types.ts`, `report.ts` — thread
  `payrollTaxCents` through to `ProjectionMonthFlows` and `ReportMonth`.

**Rules**
- `index.ts` — `usJurisdiction.computePayrollTaxCents` routes `wages` to `payrollTaxCents`;
  `PAYROLL_TAX_ASSUMPTIONS` appended to `modelAssumptions`.

**App tests migrated to the corrected reality** (the default plan no longer builds wealth it
never should have):
- `presets.test.ts` — the default plan's real net worth now *erodes* across the working years
  (FICA is the whole surplus) yet stays solvent to retirement; paycheck-to-paycheck now tips
  into mid-career insolvency.
- `retirementView.test.ts`, `retirementPanel.test.tsx` — feasible-retirement floor moves out
  (default plan pinned at 65 → nearest feasible 78; the $7k-income fixture retires at 63).
- `goalsPanel.test.tsx` — the Funded-badge fixture now uses a $6,500 wage so a goal actually
  funds off a real surplus.
- `components/addEventForm/fundingSourcePicker.test.tsx` — re-fixtured onto two documented
  minimal salary variants (a $6,500 working-year pool at month 48; a $5,500 plan that
  decumulates for the drain tests), since the default plan no longer accumulates a
  multi-account pool. Every asserted balance is read off the real projection; no structural
  assertion was weakened.

## Verification & Testing

- `npm run check` (engine purity + typecheck + full suite): **1297 tests passing**, 45 todo,
  98 files.
- Engine + rules alone: 881 passing.
- Default-plan behaviour spot-checked: 7.65% of gross withheld while working, $0 in retirement,
  $0 on retirement-account withdrawals.
