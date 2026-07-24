# Issue #99 — Report income by source, not just tax category

## Overview

`ProjectionMonthFlows.incomeByCategoryCents` bucketed income by **tax category** (a
tax classification), so the income graph in the Base + Adjustments panel (#71) could
only draw tax buckets. Three distinct facts were lost:

1. **Sources collapsed into buckets** — two jobs shared one `wages` band; every pre-tax
   draw shared `ordinaryIncome`. You could not see *which* job ended or *which* account
   was being drained.
2. **Living off savings read as $0 income** — while the liquid buffer still covered the
   gap, `buildWithdrawalSources` created no withdrawal source at all (`need = gap −
   liquidBuffer; if (need <= 0) return []`), so the §5.1 cascade quietly charged spending
   against the savings balance and the graph showed a flat zero.
3. **An unexplained `capitalGains` band** — the `goal-emergency` fund being drawn down
   surfaced as anonymous "investment income".

This change makes the engine report income **by source** (source id + display label +
tax category), keeps `incomeByCategoryCents` as the convenience rollup, represents the
liquid-buffer drawdown as its own `savingsDrawdown` source, and reworks the income graph
to band by source with real labels.

## RGR Verification Details

Worked outside-in, one behaviour at a time. Representative RED → GREEN transitions:

- **Per-source rollup** — added a `buildFlows` test asserting two `wages` jobs stay
  distinct in `incomeSources` while `incomeByCategoryCents` collapses them. RED (field
  did not exist) → added `ProjectionIncomeSource` + the aggregation pass → GREEN.
- **Savings drawdown** — added a `buildWithdrawalSources` test asserting the whole gap is
  returned as `liquidDrawdownCents` (and nothing sold) when cash covers it, and is capped
  at the buffer otherwise. RED (function returned a bare array) → changed the return to
  `WithdrawalPlan { sources, liquidDrawdownCents }` → GREEN.
- **End-to-end** — added `projectionBase.test.ts` cases that project the sample plan and
  assert (a) working income bands by its `job:` source, (b) a retirement-gap month is a
  `savingsDrawdown` band, not zero income, and (c) the retained "Emergency fund" goal
  draw is named by the goal. RED (source ids were lost across ledger replay) → threaded
  `sourceId` through `HouseholdSeries` → `interpret` → `buildHouseholdInput` → GREEN.
- **Graph (AC4)** — rewrote `incomeByCategory.test.ts` for the source API and flipped the
  panel test from `/No income from Year/` to `/living off savings/i`. RED → reworked
  `buildIncomeChartData` / `describeIncomeGap` / `IncomeChart` → GREEN.

Final: `npm run check` (purity + typecheck + tests) fully green.

## Key Decisions & Why

- **`incomeSources` is additive; `incomeByCategoryCents` is retained unchanged.** The
  category rollup stays the taxable-income view (same figures, backward-compatible), the
  way `expensesCents` coexists with `lineMonthlyCents` after #71. Existing consumers
  (report layer, solver, tests) keep working untouched.
- **The savings drawdown is reporting-only, never a waterfall source.** The buffer cash is
  already in the account and the §5.1 cascade spends it directly; injecting it as an
  `IncomeSourceMonth` would double-count it and mis-tax it. So `buildWithdrawalSources`
  returns `liquidDrawdownCents` separately (`min(gap, liquidBuffer)`, the same value in
  both early-return branches), and `buildFlows` appends it as a `savingsDrawdown` source
  that is deliberately **absent from the category rollup and the total** — a drawdown is
  spending an asset, not income.
- **`category: TaxCategory | "savingsDrawdown"`.** A genuine source carries its own tax
  category (the AC's "its tax category"); the one extra member tags the drawdown, which
  has no tax category because it is not taxable income.
- **Labels live where the knowledge is.** `SimAccount` gained an optional `label`, set by
  `buildPlanAccounts` ("Cash savings", "Brokerage", each goal's own name), so a
  decumulation draw reports as *which* account/goal it drained. Jobs already carried a
  label; a stable `sourceId` (`job:<id>`) was added and threaded through the ledger.
- **AC3 was already satisfied; added a guard.** The savings account already carried
  `CASH_INTEREST_TAX_PROFILE` (fixed under #94: tax-free withdrawal *because* its interest
  is taxed at accrual), not `CAPITAL_GAINS_TAX_PROFILE`. Added an explicit regression test
  pinning it to a non-capital-gains, `taxExempt`-withdrawal, `interest`-return profile.
- **Graph order.** Sources are ordered by provenance (wages → withdrawals by tax friction
  → benefit → savings drawdown last), and the drawdown gets a distinct muted colour so it
  reads as "not income". The hedged `CATEGORY_LABELS` map ("Pre-tax withdrawals" etc.) is
  gone — each band now uses the engine's real source label.

## Changes Made

**Engine**

- `projection/simulate.types.ts` — new `ProjectionIncomeSource` + `IncomeSourceCategory`
  types; `ProjectionMonthFlows.incomeSources`; `SimOwnedSeries.sourceId`.
- `projection/waterfall.ts` — `IncomeSourceMonth` gained optional reporting-only
  `sourceId` / `label` (ignored by allocation & tax math).
- `projection/withdrawal.ts` — returns `WithdrawalPlan { sources, liquidDrawdownCents }`;
  each draw is tagged with its account's id + label.
- `projection/reportFlows.ts` — `buildFlows` builds `incomeSources` (aggregated by source,
  zero-gross omitted) and appends the `savingsDrawdown` source; exports
  `SAVINGS_DRAWDOWN_SOURCE_ID`.
- `projection/simulate.ts` — wires source ids/labels into the wage / interest builders,
  destructures the withdrawal plan, and passes the drawdown into `buildFlows`.
- `projection/governmentBenefit.ts`, `projection/rmd.ts` — tag benefit / RMD sources.
- `compilePerson.ts` — each job's income series carries `sourceId: job:<id>`.
- `ledger/household.ts`, `ledger/interpret.ts`, `projection/buildHouseholdInput.ts` —
  thread `sourceId` from base series through replay to the sim.
- `simAccount.ts` — optional `label` on `SimAccount` (+ constructor / clone).
- `projectionBase.ts` — names savings / retirement / brokerage / goal-fund accounts.

**App**

- `baseAdjustments/incomeByCategory.ts` — bands by source (`IncomeSourceBand`,
  `centsBySource`), `firstSavingsDrawdownMonth`; `describeIncomeGap` now names the
  living-off-savings period; module doc updated to record the fix.
- `baseAdjustments/incomeChart.tsx` — one `<Area>` per source with its engine label;
  distinct colour for the savings drawdown.

**Tests** — `reportFlows.test.ts`, `withdrawal.test.ts`, `projectionBase.test.ts`,
`incomeByCategory.test.ts`, `baseAdjustmentsPanel.test.tsx`, plus the mechanical
`buildWithdrawalSources` destructure in `withdrawal.test.ts` / `retirementView.test.ts`.

## Verification & Testing

- `npm run typecheck` — clean.
- `npm run check:purity` — clean.
- `npm run test` — **705 passed | 45 todo (750)** across 58 files.
  - engine: 433 passed | 45 todo
  - new/changed coverage: `reportFlows` (11), `withdrawal` (28 incl. drawdown block),
    `projectionBase` (15 incl. #99 + AC3 guard), app `incomeByCategory` (8),
    `baseAdjustmentsPanel` (35).

## Notes for the next iteration

- The report layer (`ReportMonth`) still exposes only `incomeByCategoryCents`; surfacing
  `incomeSources` there too is a small, optional follow-up if a table view wants it.
- Event-caused (override) income series fall back to `income:<owner>` as their source id
  (they carry no `sourceId`); base job series carry `job:<id>`. Fine today since the panel
  reads compiled job series, but worth a stable id if per-source event income is reported.
