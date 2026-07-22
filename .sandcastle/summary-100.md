# Issue #100 — Sweeping surplus to a brokerage made retirement WORSE

## Overview

Enabling `surplusSwept` made retirement **strictly worse** (earliest feasible age 77
swept vs 73 idle), even though the swept brokerage earned 7× the cash rate and held far
more wealth. The root cause lived in `buildWithdrawalSources` (the §7 decumulation
channel): it grossed up **only** the `ordinaryIncome` withdrawal path and injected every
other category (`capitalGains`, `taxExempt`) **one-for-one**, assuming zero marginal tax.

That assumption is false against the real US jurisdiction. As the issue's *sharpened
diagnosis* established, the draw itself is often taxed at 0% (preferential capital-gains
bracket) — but a capital-gains / tax-exempt draw counts toward **provisional income** and
pulls the Social Security benefit into taxability. So a draw sized to close the gap in
*gross* terms lands short by exactly the tax it **induces on income the household already
had**, every month. That permanent shortfall accrued to the §5.1 synthetic credit card
at 22% APR (minimum payment < interest), grinding upward until it hit the $50k limit and
tripped `isInsolvent` — with millions still sitting in the brokerage.

**The fix:** gross up **every** taxed withdrawal path, sizing the draw by differencing
`computeTaxCents` over the **whole return** (base vs base-plus-draw), not the draw's own
category rate. A per-category rate would multiply by 0% in the failing case and change
nothing; whole-return differencing captures the benefit-inclusion effect exactly, and
still nets one-for-one when the draw is genuinely untaxed (null jurisdiction).

## RGR Verification Details

**RED (engine).** Added two unit tests in `withdrawal.test.ts` driving
`buildWithdrawalSources` against a synthetic `provisional-trap` jurisdiction (benefit
taxed 0% alone, capital-gains taxed 0% alone, but their combination taxes the benefit).
With the old code the $1k net need drew exactly $1k, netting only **$2,750** of the
$3,000 obligation (short by the induced $250 tax); the flat-capital-gains case netted
**$1,600** of $2,000. Both failed the `>= need` assertion, as expected.

**GREEN.** Unified the two withdrawal branches into a single whole-return gross-up over
`account.taxProfile.withdrawalCategory`. Both engine tests pass; the swept default plan's
earliest feasible age drops from 77 → **68** (now earlier than idle's 73), and the
synthetic card's peak balance over the full horizon falls from ~$50k → **$20** (single-
pass residual only).

**REFACTOR.** Collapsed the duplicated gross-up arithmetic into one path, updated the
module and constant JSDoc to describe whole-return differencing, and added end-to-end
regression coverage in `retirementView.test.ts` against the real `usJurisdiction`.

## Key Decisions & Why

- **Difference the whole return, not the draw's own-category rate.** This is the crux of
  the sharpened diagnosis. The `ordinaryIncome` branch already did this correctly (hence
  it was unaffected); the fix generalizes the exact same technique to all categories by
  keying `withDraw` on the account's neutral `withdrawalCategory`. An own-category rate
  gross-up (`×0%`) would have been a no-op in the failing case.
- **One unified branch, not two.** The old code special-cased `ordinaryIncome`. Since the
  gross-up now works identically for any category (a category the jurisdiction never
  taxes yields `marginalRate = 0` → `gross = need`, preserving the one-for-one behavior),
  the `if/else` collapses to a single path — less surface area, no category is privileged.
- **No engine → rules dependency.** The engine cannot import `usJurisdiction`. The engine
  unit tests model the provisional-income trap with a small synthetic jurisdiction; the
  real-jurisdiction end-to-end proof lives in `packages/app` (which depends on both).
- **Single-pass gross-up retained.** The residual is now cents (self-corrects in the
  liquid buffer next month) instead of the entire induced tax, so the card never grows.
  The regression test pins the card peak `< $100` across the full horizon as the guard.

## Changes Made

- **`packages/engine/src/projection/withdrawal.ts`**
  - `buildWithdrawalSources`: merged the `ordinaryIncome`-only gross-up and the
    one-for-one else branch into a single whole-return gross-up keyed on each account's
    `withdrawalCategory`. Every taxed draw is now sized so its after-tax net covers the
    need; the owner's running taxable base accumulates across draws.
  - Updated the module doc, the `DEFAULT_LIQUIDATION_ORDER` doc, and inline comments to
    describe whole-return differencing (removing the stale "no gross-up / one-for-one in
    v1" contract invalidated by #53/#98 shipping real brackets + provisional income).
- **`packages/engine/src/projection/withdrawal.test.ts`** — new describe block
  *"Every taxed draw nets the need — whole-return gross-up (#100)"*: the provisional-trap
  0%-rate-draw-pulls-benefit case (AC5) and a flat-capital-gains gross-up (AC1), with a
  `householdNetCents` helper that computes after-tax income over the combined return.
- **`packages/app/src/retirementView.test.ts`** — new describe block
  *"surplus sweep does not make retirement worse (#100)"*: AC2 (swept feasible age ≤ idle,
  and strictly earlier) and AC3+AC4 (swept default plan retiring at its feasible age never
  reaches `isInsolvent`, the card peak stays `< $100`, and net worth survives the full
  horizon) against the real `usJurisdiction`.

## Acceptance Criteria

- [x] A capital-gains / tax-exempt withdrawal nets the amount it was sized to cover
- [x] `surplusSwept: true` does not produce a later retirement age than idle (77 → 68 vs 73)
- [x] A household with liquidatable assets does not reach `isInsolvent` on card interest
- [x] Regression test covering the swept default plan across the full horizon (661 months)
- [x] A 0%-rate draw that pulls a government benefit into taxability is sized to net the need

## Verification & Testing

- `npm run typecheck` — clean
- `npm run check:purity` — engine purity passed (no I/O, no app/rules imports)
- `npm run test` — **613 passed | 45 todo (658)**, 52 test files
- `withdrawal.test.ts` — 17 passed (2 new #100 tests)
- `retirementView.test.ts` — 20 passed (2 new #100 tests)
