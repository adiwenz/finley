# Handoff — issue 96 (No payroll tax / FICA)

This issue is being done **whole-issue mode, split into two parts by me:**

- **Part A — engine payroll-tax seam in the waterfall — DONE (this commit).**
- **Part B — wire it end-to-end (accumulate per person/year → simulate → report) and give US a `computePayrollTaxCents` — REMAINING.**

## Key finding that reshaped the issue
The issue body predates two things that have since landed:
- **Jobs already book income as `wages`** (see `packages/engine/src/compilePerson.ts:114`), not `ordinaryIncome`. So the "earned income is not distinguishable" blocker is GONE — FICA charges on `wages` and never touches `ordinaryIncome` (401k/RMD withdrawals, interest). No withdrawal-collision workaround needed.
- **The payroll-tax TABLES already exist** in `packages/rules/src/payrollTax.ts` (the "split out" issue). `payrollTaxCents(annualEarnedCents, year)` and `PAYROLL_TAX_ASSUMPTIONS` are ready; they are NOT yet on `usJurisdiction`. That file's own doc says accumulation is the engine's job and the function gives the whole-year answer.

## Live constraints (Part B must honor)
- **Accumulate, don't annualize.** payrollTax.ts is a WHOLE-YEAR function; the OASDI cap binds on cumulative earnings. The waterfall already implements the accumulate-and-difference mechanic: it charges `seam(YTD-after) − seam(YTD-before)`. Part B must feed `priorEarnedByPersonCents` from a per-person-per-year accumulator and fold `WaterfallResult.earnedThisMonthByPersonCents` back into it each month (mirror `state.deferredByPersonYear` in `allocationStep.ts` / `runState.ts`).
- **FICA is a SEPARATE line from income tax.** It is NOT in `taxCents`/`taxByCategoryCents`/`taxBySourceCents`, so the income-tax attribution invariants (`assertTaxAttributionReconciles`) stay untouched. Thread `WaterfallResult.payrollTaxCents` up as its own field: allocateMonth → simulate → `buildFlows` → `ProjectionMonthFlows.payrollTaxCents` → `ReportMonth.payrollTaxCents`.
- **Base is pre-deferral gross.** The waterfall already builds `earnedGrossByPerson` from `taxableCents ?? waterfallInflowCents` BEFORE the deferral haircut — do not re-derive from the post-deferral taxable map.
- **The rules seam filters categories, engine stays neutral.** Add to `usJurisdiction`: `computePayrollTaxCents: (byCat, ctx) => payrollTaxCents(byCat.wages ?? 0, ctx.year)`. Only `wages`. Also append `PAYROLL_TAX_ASSUMPTIONS` to `usJurisdiction.modelAssumptions`.
- Seam is OPTIONAL on `WaterfallInput` (absent → 0). The `Jurisdiction` interface still needs a `computePayrollTaxCents?` method added (engine side) so the rules object type-checks and allocateMonth can pass it through, like the other optional seams.

## Interface introduced by Part A (Part B consumes)
- `WaterfallInput.computePayrollTaxCents?(annualEarnedByCategory)` and `.priorEarnedByPersonCents?(personId)` — see `waterfall.types.ts`.
- `WaterfallResult.payrollTaxCents` and `.earnedThisMonthByPersonCents` (per-person pre-deferral earned gross by category).
- Tests: `packages/engine/src/projection/waterfall.test.ts` "employee payroll tax (FICA) seam" block.

## Deferred (out of scope for v1 — note in summary, do NOT implement)
- **Self-employment tax (15.3%).** Jobs are W-2; SE is a separate income shape. Out.
- **Per-source FICA attribution.** FICA reported as a single household line, not split per job. The per-source `netCashFlowCents` in `buildFlows` therefore does not haircut wages for FICA — acceptable for v1.
- Withholding/year-end reconciliation (#55) — FICA is exact-by-paycheck, no reconciliation needed.

## Remaining tests to add (Part B)
- Integration on the default plan (`usJurisdiction`): FICA ≈ 7.65% of $60k/yr is withheld; a pre-tax deferral does NOT shrink it; a retirement withdrawal (`ordinaryIncome`) is NOT charged. The default plan is far under the wage cap, so a separate high-earner/cap test is optional but nice.
