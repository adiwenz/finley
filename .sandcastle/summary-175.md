# Issue #175 — Explicit obligations: migrate Home Purchase off `FundingDraw`

## Overview

Slice #4 brings the explicitly-funded branch into the obligation pipeline. The Home Purchase
down payment stops being a separate `FundingDraw` record and becomes an explicitly-funded
`asset-acquisition` `FinancialObligation`; explicit obligations resolve **before** automatic
decumulation, in event sequence; the affordability gate's marginal taxable base follows the new
resolution order so it prices a candidate on exactly the tax its own sale induces; and the now
field-for-field-duplicated funding types are deleted. The load-bearing invariant throughout is
**gate == sim**: a money-out event authored in a decumulation month predicts exactly the
shortfall the simulator produces.

## RGR Verification Details

- **Task 1** (down payment as an obligation): pinned by `financialObligation.test.ts` —
  `assetAcquisitionObligation` produces an `explicit` / `asset-acquisition` obligation that both
  named totals (`automaticFundingTotal`, `expenseReportingTotal`) exclude. Output identical to the
  prior `FundingDraw` path, isolating the representation change from behaviour.
- **Task 2** (reorder): `resolveFundingDraws` moved ahead of `buildWithdrawalSources` in the
  `simulate.ts` month loop. No existing capital-gains figure moved (no fixture combined a draw
  with appreciated-account decumulation in one month); the interaction is pinned by new tests.
- **Task 3** (gate base): the gate reads the pipeline seam "after explicit draws, before
  decumulation" on both tax base and per-account balances/basis. RED→green via
  `events.homePurchase.test.ts` "§4.5 gate == sim across a decumulation month".
- **Task 4** (siblings): sibling explicit draws resolve in event (push) order — each sees what
  its predecessors left. Pinned by "sibling explicit draws resolve in event sequence".
- **Task 5** (deletions): the `downpayment:brokerage` / `downpayment-tax:brokerage` band
  assertions and the gate==sim / sibling tests stayed green across the type deletion — proving
  band output is unchanged once bands key off the obligation's `sourceId` + `treatment` instead
  of the retired `FundingReason`→prefix table.

## Key Decisions & Why

- **`state.fundingDraws` now holds `FinancialObligation[]`, not `FundingDraw[]`.** `FundingDraw`
  was field-for-field the same record as an explicitly-funded obligation; keeping both meant every
  money-out event registered in two places that could drift. The obligation is now the sole
  record — built once at authoring in `homePurchase.apply`, resolved and reported straight off in
  `resolveFundingDraws`. The field name is kept so the sibling-ordering guarantee (which rides on
  push order into this array) is untouched.
- **Report bands key off the obligation, band output unchanged.** `sourceId` is the band
  namespace (`"downpayment"` → `downpayment:<account>` / `downpayment-tax:<account>`), chosen at
  the emission site; `treatment === "asset-acquisition"` is what marks the obligation a draw that
  books a gain band plus a net-neutral tax band. Both fields gate resolution in the loop, so the
  retired `REPORT_PREFIX` table is genuinely replaced rather than relocated.
- **The tax-aware `resolveOrderedFundingDraw` and the fixed-amount `AccountTransfer` both
  survive untouched.** The tax-blind `drainSources` helper (and its test) is deleted: dead
  production code only its own test imported, and a second subtly-wrong definition of "drain in
  order" if left in place.

## Changes Made

- `ledger/transfers.ts` — deleted `FundingDraw` and its `FundingReason` provenance tag.
- `ledger/funding.ts`, `ledger/funding.test.ts` — deleted (the tax-blind `drainSources` helper).
- `projection/fundingDrawStep.ts` — deleted `REPORT_PREFIX`; `resolveFundingDraws` now iterates
  the obligations directly, gating on `funding.kind === "explicit"` + `treatment`, and keys bands
  off `obligation.sourceId`.
- `projection/financialObligation.ts` — `assetAcquisitionObligation` takes explicit
  `{ sourceId, month, amountCents, orderedAccountIds }` and names its own bands.
- `ledger/eventHandlers.ts` — `homePurchase.apply` pushes the obligation (via
  `assetAcquisitionObligation`, `sourceId: "downpayment"`) instead of a `FundingDraw`.
- `ledger/interpretState.ts`, `ledger/household.ts`, `projection/runState.ts`,
  `projection/simulate.types.ts` — `fundingDraws` retyped to `FinancialObligation`.
- `ledger/addEvent.ts` — refreshed the `FundingDraw` doc reference.
- `projection/financialObligation.test.ts` — updated to the new constructor signature.

## Verification & Testing

- `npm run check` green — `check:purity` ✓, `typecheck` ✓, `test` ✓.
- **1515 tests passed** (45 todo) across 105 test files.
- No remaining references to `FundingDraw`, `FundingReason`, `drainSources`, or `REPORT_PREFIX`.
