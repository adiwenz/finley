# Summary — issue 303: Pre-tax retirement accounts drawn at any age with no early-withdrawal penalty

## Overview

Decumulation and explicitly-funded draws (a home down payment, a one-time spend) both treated a
pre-tax retirement account as an ordinary liquidation source at any age — ordinary income tax
only, no 10% early-withdrawal penalty, and no seam through which a jurisdiction could charge one.
This branch adds that seam to the engine, implements it in `rules` as the flat statutory 10%
before 59½, and wires it through both liquidation paths: the recurring decumulation cascade that
funds ordinary living costs, and the explicit funding-draw primitive that resolves a named,
one-time obligation. A later, broader rework of how federal tax reaches the household's cash (real
paycheck withholding, replacing the branch's original forecast-and-true-up model) changed *when*
the penalty settles, but not the seam itself or the two call sites — see "Key Decisions" below for
what superseded what.

## RGR Verification Details

The two liquidation paths were built test-first, then the settlement timing was revisited twice
more as later work changed how tax reaches the household's cash:

- **`earlyWithdrawalPenaltyCents` (rules):** `packages/rules/src/earlyWithdrawalPenalty.test.ts` —
  written against a not-yet-existing module (import failure = RED), then implemented to green:
  flat 10% on the taxable amount, gated on `category === "ordinaryIncome"` and `age < 59.5`.
- **Decumulation (`buildWithdrawalSources`):** `packages/engine/src/projection/withdrawal.test.ts`
  ("Early-withdrawal penalty on a pre-tax draw") — RED before the seam existed on `Jurisdiction`
  (runtime penalty always 0), then wired to green.
- **Explicit funding draws (`resolveOrderedFundingDraw`):**
  `packages/engine/src/projection/fundingDrawStep.test.ts` — RED against the not-yet-`age`-aware
  primitive, then green.
- **The year-start forecast** (`fundingForecast.ts`'s `forecastFundingDraws`, the estimator behind
  Repro A's own retired-decumulation scenario) was missed by the first pass and caught in review:
  it never gained an `age` field, so a decumulating household under 59½ under-sold from later
  taxable accounts by exactly the penalty leakage. Fixed with new `forecastFundingDraws` tests
  pinning the leakage/make-up arithmetic (`fundingForecast.test.ts`).
- **Real-simulation confirmation, both paths:** `events.oneTimeSpend.test.ts` ("an early-withdrawal
  penalty on a pre-tax source") and `taxWithholding.test.ts` ("6. An early-withdrawal penalty is
  never netted from the proceeds, and settles with the tax") each run a real household through
  `simulate`/`buildProjection`, with and without a penalty-charging jurisdiction, and assert the
  simulated month's balances, net worth, and settlement charge — not just a primitive's return
  value.
- **Full gate, current HEAD:** `npm run check` (engine purity + `tsc --noEmit` + full Vitest
  suite) green — **148 test files, 2010 tests passed, 45 pre-existing todo, 0 failures.**

Note: `taxYearProjection.ts` and the original `fundingForecast.ts` module named above were later
deleted wholesale (see below) when the forecast-based tax-pacing model they belonged to was
removed; the leakage they were patched to avoid no longer exists in the current design, but the
regression tests that proved the patch worked at the time remain informative history, preserved
here since `git log` on this branch does not read as a single story otherwise.

## Key Decisions & Why

- **New seam, mirroring the RMD precedent.** `Jurisdiction.earlyWithdrawalPenaltyCents?(basis:
  WithdrawalTaxBasis, ctx: WithdrawalContext): Cents` and `WithdrawalContext extends
  JurisdictionContext { age: number }` — the sibling of `RmdContext` at the other end of life, as
  the issue itself proposed. Priced off the same `WithdrawalTaxBasis` as
  `taxableWithdrawalCents`, so a jurisdiction gates on `category` the same way it decides what
  portion of a draw is taxable at all. **This seam and its two call sites (decumulation,
  explicit funding draws) are the part of this design that has not changed since; only the
  settlement timing below did.**
- **Net-vs-gross, not gross-up, at both call sites — unchanged.** The engine still sells exactly
  the requested amount from an account (balance and basis move by the full `gross`, income-tax
  treatment of the sale is untouched); the penalty never reduces what a draw *delivers*. What
  changed is what "delivers" nets against (below).
- **Settlement timing — SUPERSEDED once, by a later architectural change, and this is the part
  worth reading carefully.** The issue's own open question ("its own band, or folded into the
  December settlement?") was originally answered "charge it the same month, immediately netted
  out of the draw" (`need -= net` / `remaining -= net`), reasoned from the fact that a flat-rate
  penalty is fully known the instant the draw is priced, unlike a bracket-based income-tax
  liability that isn't known until the year closes. A later, unrelated rework replaced the
  engine's whole federal-tax-timing model — first removing the forecast-and-true-up mechanism
  entirely in favor of a single April lump settled off the year's actual income (eliminating the
  December-recursion problem outright, more directly than the per-penalty carve-out did), then
  replacing THAT with real per-paycheck withholding trued up the following April. Under both of
  those later models, "nets out of the draw's proceeds this month" would sit awkwardly beside "no
  cash for this category moves until it settles" for every other tax dollar the draw generates —
  so the penalty was moved to match: it is now priced at draw time (same seam, same call sites,
  same gate), reported per source/owner, but **never subtracted from what the draw delivers**
  (`remaining -= gross`, not `remaining -= net`), and settles the following April as a flat
  top-up added on top of the bracket-priced income-tax liability
  (`taxYearSettlement.ts`'s `finalizeTaxYear`, `earlyWithdrawalPenaltyByPersonYear`). A draw that
  needs $1,000 now delivers the full $1,000; the $100 penalty is real and reported the same
  month, but lands as cash the following April, attributed to its own `earlyWithdrawalPenalty`
  source key rather than any account's. This is a deliberate, tested design — not an
  in-progress migration — confirmed by `taxWithholding.test.ts`'s dedicated describe block.
- **Flat 10%, no exceptions — the issue's own "right first cut."** Rule of 55, SEPP/72(t),
  disability, and other statutory carve-outs remain unmodelled by design; every early pre-tax draw
  is priced at the statutory worst case. Disclosed via `EARLY_WITHDRAWAL_PENALTY_ASSUMPTIONS`, the
  same `modelAssumptions` seam every other US simplification uses.
- **Age is a whole calendar year (`ctx.year − birthYear`), so 59½ can't be seen exactly.** The
  access-age constant is written as `59.5` and compared directly against the integer age, which
  resolves to "charge every age up to and including 59" — the conservative side of the rounding
  (the household's real half-birthday may already have passed for part of that calendar year, but
  never before it), rather than silently under-pricing the risk again.
- **Two call sites wired, one deliberately not.** Both liquidation paths that actually move a
  household's real money — the recurring decumulation cascade (`buildWithdrawalSources`) and the
  real simulated funding draw (`fundingDrawStep.ts`'s `resolveFundingDraws`) — are wired. The
  ledger's authoring-time affordability preview (`addEvent.ts`'s `availabilityAt`/`failureAt`,
  used by the picker UI to show "can I afford this") is NOT — it doesn't currently read birth
  years at all, and wiring it would be new plumbing for a UI hint, not the simulation this issue
  is about. It degrades safely: `AccountFundingSource.age` is optional, and an absent age is the
  documented "no penalty" fallback everywhere. Flagged for a future issue if the picker's
  precision here starts to matter.

## Changes Made

- `packages/engine/src/jurisdiction/jurisdiction.ts` — `WithdrawalContext` and
  `Jurisdiction.earlyWithdrawalPenaltyCents?`.
- `packages/engine/src/index.ts` — exports `WithdrawalContext`.
- `packages/engine/src/projection/withdrawal.ts` — `WithdrawalState.personsById` (optional);
  `buildWithdrawalSources` prices the penalty per account draw, reports it per owner via
  `earlyWithdrawalPenaltyByOwnerCents`, and nets `need` against gross sold (never against the
  penalty).
- `packages/engine/src/projection/fundingDrawStep.ts` — `AccountFundingSource.age` (optional);
  `resolveOrderedFundingDraw` prices the penalty per source and reports it (`taxCents`,
  `ResolvedFundingSource`); `resolveFundingDraws` threads `age` from `state.personsById` and
  aggregates `earlyWithdrawalPenaltyByOwnerCents` on the report; `remaining`/`netDeliveredCents`
  track gross, never net-of-penalty.
- `packages/engine/src/projection/runState.ts` — `SimState.earlyWithdrawalPenaltyByPersonYear`,
  the accumulator the year-end settlement reads.
- `packages/engine/src/projection/simulate.ts` — folds both call sites'
  `earlyWithdrawalPenaltyByOwnerCents` into `state.earlyWithdrawalPenaltyByPersonYear` each month.
- `packages/engine/src/projection/taxYearSettlement.ts` — `finalizeTaxYear` adds the
  accumulated penalty as a flat top-up on top of the bracket-priced income-tax liability, banded
  to its own `earlyWithdrawalPenalty` source key.
- `packages/rules/src/earlyWithdrawalPenalty.ts` (new) — the US-2026 implementation: flat 10%,
  gated on category and age, plus its `modelAssumptions` disclosure.
- `packages/rules/src/index.ts` — wires `earlyWithdrawalPenaltyCents` and its assumptions into
  `usJurisdiction`.
- Tests: `packages/rules/src/earlyWithdrawalPenalty.test.ts`,
  `packages/rules/src/index.test.ts`, `packages/engine/src/projection/withdrawal.test.ts`,
  `packages/engine/src/projection/fundingDrawStep.test.ts`,
  `packages/engine/src/ledger/events.oneTimeSpend.test.ts`,
  `packages/engine/src/projection/taxWithholding.test.ts`,
  `packages/engine/src/projection/taxCausality.test.ts`.
- The forecast-based tax-pacing model this work originally also touched
  (`taxYearProjection.ts`, the original `fundingForecast.ts`) was deleted wholesale by later,
  broader tax-timing work (see "Key Decisions"); nothing about the penalty seam itself needed to
  move as a result beyond the settlement-timing change already described.

## Verification & Testing

- `npm run check` (engine purity + `tsc --noEmit` + full Vitest suite), current HEAD: green —
  **148 test files, 2010 tests passed, 45 pre-existing todo, 0 failures.**
- Both repros from the issue are now priced: a household drawing pre-tax between age 55 and 59½
  to fund ordinary living costs (Repro A) has the 10% penalty priced and reported the month it
  draws, settled the following April; a 100%-deferral paycheck that round-trips through a 401(k)
  each month (Repro B) leaks 10% of the draw back out as a real cost at settlement instead of
  netting to $0. An explicitly-funded pre-tax draw (a home down payment) is priced the same way,
  confirmed end to end in `events.oneTimeSpend.test.ts`.
