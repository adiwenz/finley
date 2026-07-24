# Issue #110 — Report tax by category, not just a monthly total (§5.3)

## Overview

The tax seam returned a single number per person-month, so while **income** was
reported per category (`incomeByCategoryCents`) and the income chart could stack bands,
the new "Monthly tax paid" chart could only ever draw **one rust band** — the engine had
no per-category tax breakdown to give it.

This change **widens the §5.3 tax seam** so the jurisdiction can report the *same* tax
total broken out per `TaxCategory`, carries that breakdown through the projection
(`ProjectionMonthFlows` → `ReportMonth`), and **stacks the app tax chart by category** to
match the income chart. It follows the #94 boundary pattern exactly: the engine reports
the neutral shape, the **jurisdiction owns the decision** (how the total splits), and the
app synthesizes nothing.

The whole addition is **additive and optional**. The scalar `computeTaxCents` stays the
sole contract the withdrawal gross-up loop depends on; a jurisdiction that declines the
breakdown (the null jurisdiction, or any that doesn't implement the seam) yields no
breakdown and the chart falls back to a single band, exactly as before.

## Attribution method (documented) & its limitation

The US jurisdiction (`federalTax.ts`) attributes the total with a **regime-aware
proportional-to-taxable** method:

- The preferential **capital-gains** tax rides the `capitalGains` bucket alone, so the
  split respects that gains are taxed at their own 0/15/20% rates rather than an averaged
  blend (the interaction #100 turned on).
- The progressive **ordinary** tax is divided among `wages`, `ordinaryIncome`, and
  `governmentRetirementBenefit` in proportion to each one's ordinary-taxable weight (the
  benefit weighted by its **included** portion only), so the standard deduction and the
  bracket climb are shared pro-rata across the ordinary contributors.
- `taxExempt` never bears tax (it is never taxed, only counted for the benefit test).

Apportionment is **largest-remainder**, so every share is an integer cent and **Σ shares
=== the scalar total exactly** — the AC invariant "total still equals `computeTaxCents`".

⚠ **Limitation (stated, mirroring the withdrawal-seam monotonicity caveat):** this is an
average-rate attribution *within* the ordinary regime. It cannot perfectly capture that
the *last* dollar of one category sits in a higher bracket than the first, nor the
notch/inclusion effects (a marginal dollar of ordinary income can raise the taxable
benefit or push gains out of the 0% band). The split is **exact in total**, defensible
per bucket, and honest about not being a marginal-incidence decomposition.

## RGR Verification Details

Three RED→GREEN cycles, each written test-first and confirmed failing before the fix:

1. **Core attribution** (`federalTax.test.ts`) — added `federalAnnualTaxByCategoryCents`
   / `computeFederalTaxByCategoryCents` tests. RED: `TypeError: … is not a function`.
   GREEN: extracted a shared `federalTaxParts` core (so the scalar and the split can never
   drift), then `attributeFederalTax` + `apportionByWeight`.
2. **Engine plumbing** (`report.test.ts`) — a splitting mock jurisdiction must surface
   `taxByCategoryCents` on `ReportMonth` with Σ === `taxCents`, and the null jurisdiction
   must omit it (empty `columns.taxCategories`). RED before the waterfall/report wiring.
3. **App chart** (`taxesByMonth.test.ts`) — `buildTaxChartData` must expose the category
   union in stable order, keep per-month per-category cents, drop empty bands, and set
   `hasCategoryBreakdown=false` for a total-only series. RED before the build rewrite.

A panel test (`baseAdjustmentsPanel.test.tsx`) then asserts the full pipeline
(jurisdiction → engine → app) renders a stacked "Wages" band whose Σ equals the row total.

## Key Decisions & Why

- **New optional seam `computeTaxByCategoryCents?`** on `Jurisdiction`, rather than a
  richer return from `computeTaxCents`. Keeps the scalar seam byte-for-byte the contract
  the gross-up probe loop calls thousands of times; the breakdown is a separate, at-most-
  once-per-person-month reporting call. Nothing on the hot path changed.
- **`federalTaxParts` shared core.** `federalAnnualTaxCents` now returns
  `federalTaxParts(...).totalCents`, and the attribution reads the same intermediate
  ordinary/gains figures — so the split provably reconciles to the scalar. Behaviour of
  the existing scalar function is unchanged (all prior cent-pinned tests still pass).
- **Apportion the *monthly* total by *annual* weights** in the monthly seam, so
  Σ(breakdown) === `computeFederalTaxCents` for the same slice (ratios are identical
  monthly vs. annual; this avoids a second independent rounding disagreeing with the total
  the take-home already used).
- **Take-home still uses the scalar.** `computeTakeHome` charges the scalar total and
  additively accumulates the household breakdown only when the seam is present — the
  breakdown never affects the money math.
- **App chart mirrors the income chart** (stable category order, drop-empty-bands, hidden
  data mirror for tests), in a rust family so all bands read as "tax / money leaving".

## Changes Made

- `packages/engine/src/jurisdiction.ts` — new optional `computeTaxByCategoryCents?` seam,
  fully documented (contract: Σ === `computeTaxCents`; optional → single band).
- `packages/engine/src/projection/waterfall.ts` — `WaterfallInput.computeTaxByCategoryCents?`
  and `WaterfallResult.taxByCategoryCents?`; `computeTakeHome` accumulates the household
  breakdown when the seam is wired (take-home unchanged).
- `packages/engine/src/projection/simulate.ts` — wires the seam into `runWaterfall`,
  threads `taxByCategoryCents` out of `allocateMonth` into `buildFlows`.
- `packages/engine/src/projection/reportFlows.ts` / `simulate.types.ts` — `buildFlows`
  carries the optional breakdown onto `ProjectionMonthFlows.taxByCategoryCents`.
- `packages/engine/src/projection/report.ts` — `ReportMonth.taxByCategoryCents?` and
  `ReportColumns.taxCategories` (union for the stacked-chart column layout).
- `packages/rules/src/federalTax.ts` — `federalTaxParts` core, `attributeFederalTax`,
  `apportionByWeight`, and the two new exports `federalAnnualTaxByCategoryCents` /
  `computeFederalTaxByCategoryCents`.
- `packages/rules/src/index.ts` — `usJurisdiction.computeTaxByCategoryCents` wired.
- `packages/app/src/components/baseAdjustments/taxesByMonth.ts` — `buildTaxChartData` now
  emits per-category bands (`categories`, `hasCategoryBreakdown`, row `centsByCategory`);
  dropped the "total only, one band honestly" note.
- `packages/app/src/components/baseAdjustments/taxChart.tsx` — stacks by category (with a
  legend + tooltip) when a breakdown exists; single-band fallback otherwise.
- Tests: `federalTax.test.ts`, `index.test.ts`, `report.test.ts`, `taxesByMonth.test.ts`,
  `baseAdjustmentsPanel.test.tsx`.

## Verification & Testing

- `npm run check:purity` → engine purity passes (no app/rules imports in engine).
- `npm run typecheck` → clean.
- `npm run test` → **742 tests green** | 45 todo (60 files). Up from 741 pre-change
  (net new coverage: 6 federal-tax + 1 rules-index + 2 report + 5 taxesByMonth + 1 panel;
  the panel file went 36 → 37).

## Acceptance criteria

- [x] The jurisdiction can report tax per `TaxCategory`; total still equals `computeTaxCents`.
- [x] Attribution method is documented, with its limitation stated.
- [x] `ProjectionMonthFlows` / `ReportMonth` carry `taxByCategoryCents`; absent → one band.
- [x] The Monthly-tax chart stacks by category, matching the income chart.
- [x] Null jurisdiction and any jurisdiction that declines the breakdown still work (single band).
