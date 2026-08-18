# Summary — issue 303: Pre-tax retirement accounts drawn at any age with no early-withdrawal penalty

## Overview

Decumulation and explicitly-funded draws (a home down payment, a one-time spend) both treated a
pre-tax retirement account as an ordinary liquidation source at any age — ordinary income tax
only, no 10% early-withdrawal penalty, and no seam through which a jurisdiction could charge one.
This branch adds that seam to the engine, implements it in `rules` as the flat statutory 10%
before 59½, and wires it through both liquidation paths: the recurring decumulation cascade that
funds ordinary living costs, and the explicit funding-draw primitive that resolves a named,
one-time obligation.

## RGR Verification Details

Both parts followed red → green at the unit level, then a real-simulation integration test to
confirm the wiring, not just the primitive:

- **`earlyWithdrawalPenaltyCents` (rules):** `packages/rules/src/earlyWithdrawalPenalty.test.ts` —
  written against a not-yet-existing module (import failure = RED), then implemented to green (6
  tests): flat 10% on the taxable amount, gated on `category === "ordinaryIncome"` and `age <
  59.5`.
- **Decumulation (`buildWithdrawalSources`):** `packages/engine/src/projection/withdrawal.test.ts`
  — a new describe block asserted penalty-adjusted `taxCents`/`netDeliveredCents` and the
  cross-account make-up behavior before the seam existed on `Jurisdiction` (RED: runtime penalty
  always 0), then wired to green (4 new tests, 40 total in the file).
- **Explicit funding draws (`resolveOrderedFundingDraw`):**
  `packages/engine/src/projection/fundingDrawStep.test.ts` — RED against the not-yet-`age`-aware
  primitive, then green (3 new tests: nets the penalty and pulls the shortfall from the next
  source; reports a real block when no other source can cover it; charges nothing with no age).
- **Real-simulation confirmation:** a new test in
  `packages/engine/src/ledger/events.oneTimeSpend.test.ts` runs an actual `OneTimeSpendEvent`
  through `addEvent` → `interpretLedger` → `buildProjection` twice (with and without the penalty
  jurisdiction) and asserts the simulated month's account balances and net worth — not just the
  primitive's return value — differ by exactly the penalty. This is the test that proves the
  `state.personsById` → `age` threading in `fundingDrawStep.ts` is actually live, not just
  type-correct.
- Full gate: `npm run check` (purity + typecheck + whole-repo suite) green at both commits —
  2039 tests after part 1, 2043 after part 2 (147 files, 45 pre-existing todo).

## Key Decisions & Why

- **New seam, mirroring the RMD precedent.** `Jurisdiction.earlyWithdrawalPenaltyCents?(basis:
  WithdrawalTaxBasis, ctx: WithdrawalContext): Cents` and `WithdrawalContext extends
  JurisdictionContext { age: number }` — the sibling of `RmdContext` at the other end of life, as
  the issue itself proposed. Priced off the same `WithdrawalTaxBasis` as
  `taxableWithdrawalCents`, so a jurisdiction gates on `category` the same way it decides what
  portion of a draw is taxable at all.
- **Charged IMMEDIATELY, not deferred to annual settlement — the central design call the issue
  left open.** Ordinary income tax on a draw's gain is never netted from the draw itself; it
  settles once, annually, because a bracket-based liability isn't fully known until the year's
  income is. The early-withdrawal penalty is different: it's a flat rate on an amount already
  fully known the moment the draw is priced, so it can — and, to avoid materially underpricing
  the very risk this issue is about, should — be charged the same month. This sidesteps entirely
  the December-recursion problem `taxYearSettlement.ts` documents (selling to pay a bill that
  grows because it was sold): that problem is specific to a liability that isn't knowable until
  the year closes, which the penalty never was.
- **Net-vs-gross, not gross-up.** The engine still sells exactly the requested amount from an
  account (balance and basis move by the full `gross`, income-tax treatment of the sale is
  completely untouched) — but only `net = gross − penalty` counts toward covering the caller's
  need. Concretely: `need -= net` in `buildWithdrawalSources` (decumulation) and `remaining -=
  net` in `resolveOrderedFundingDraw` (explicit draws), each in place of `-= gross`. The existing
  sequential-account loop then naturally pulls the shortfall from the NEXT account in line — the
  same mechanism that already handles a balance running out mid-draw — so no fixed-point solve
  was needed, and a household that can't make up the difference gets a real, measured shortfall
  (decumulation) or a real block (an explicit draw whose named sources can't cover the penalty
  too) rather than a silently-absorbed cost.
- **Flat 10%, no exceptions — the issue's own "right first cut."** Rule of 55, SEPP/72(t),
  disability, and other statutory carve-outs are unmodelled by design; every early pre-tax draw is
  priced at the statutory worst case. Disclosed via `EARLY_WITHDRAWAL_PENALTY_ASSUMPTIONS`, the
  same `modelAssumptions` seam every other US simplification uses.
- **Age is a whole calendar year (`ctx.year − birthYear`), so 59½ can't be seen exactly.** The
  access-age constant is written as `59.5` and compared directly against the integer age, which
  resolves to "charge every age up to and including 59" — the conservative side of the rounding
  (the household's real half-birthday may already have passed for part of that calendar year, but
  never before it), rather than silently under-pricing the risk again.
- **Two call sites wired, one deliberately not.** Both liquidation paths that actually move a
  household's real money — the recurring decumulation cascade (`buildWithdrawalSources`) and the
  real simulated funding draw (`fundingDrawStep.ts`'s `resolveFundingDraws`, plus its
  year-start forecast counterpart in `taxYearProjection.ts`) — are wired. The ledger's
  AUTHORING-TIME affordability preview (`addEvent.ts`'s `availabilityAt`/`failureAt`, used by the
  picker UI to show "can I afford this") is NOT — it doesn't currently read birth years at all,
  and wiring it would be new plumbing for a UI hint, not the simulation this issue is about. It
  degrades safely: `AccountFundingSource.age` is optional, and an absent age is the documented
  "no penalty" fallback everywhere, so the preview simply doesn't yet reflect this cost. Flagged
  for a future issue if the picker's precision here starts to matter.

## Changes Made

- `packages/engine/src/jurisdiction/jurisdiction.ts` — added `WithdrawalContext` and
  `Jurisdiction.earlyWithdrawalPenaltyCents?`.
- `packages/engine/src/index.ts` — exported `WithdrawalContext`.
- `packages/engine/src/projection/withdrawal.ts` — `WithdrawalState.personsById` (optional);
  `buildWithdrawalSources` prices and nets the penalty per account draw, decrementing `need` by
  net delivered; `DecumulationDrawResult.taxCents`/`netDeliveredCents` now carry the penalty
  instead of being hardcoded 0/gross.
- `packages/engine/src/projection/fundingDrawStep.ts` — `AccountFundingSource.age` (optional);
  `resolveOrderedFundingDraw` prices and nets the penalty per account source, decrementing
  `remaining` by net delivered; `resolveFundingDraws` threads `age` from `state.personsById` at
  both places it builds sources (the real draw and the block-diagnosis account pool).
- `packages/engine/src/projection/taxYearProjection.ts` — the explicit-draw forecast section
  threads the same `age` lookup, so the year-start tax-pacing estimate prices a forecast pre-tax
  draw consistently with the real month.
- `packages/rules/src/earlyWithdrawalPenalty.ts` (new) — the US-2026 implementation: flat 10%,
  gated on category and age, plus its `modelAssumptions` disclosure.
- `packages/rules/src/index.ts` — wired `earlyWithdrawalPenaltyCents` and its assumptions into
  `usJurisdiction`.
- Tests: `packages/rules/src/earlyWithdrawalPenalty.test.ts` (new),
  `packages/rules/src/index.test.ts`, `packages/engine/src/projection/withdrawal.test.ts`,
  `packages/engine/src/projection/fundingDrawStep.test.ts`,
  `packages/engine/src/ledger/events.oneTimeSpend.test.ts`.
- Deleted `.sandcastle/handoff-303.md` (superseded by this document).

## Verification & Testing

- `npm run check` (engine purity + `tsc --noEmit` + full Vitest suite): green — **147 test files,
  2043 tests passed, 45 pre-existing todo, 0 failures.**
- Both repros from the issue are now priced: a household drawing pre-tax between age 55 and 59½
  to fund ordinary living costs pays the 10% penalty on that draw, charged the same month; a
  100%-deferral paycheck that round-trips through a 401(k) each month now leaks 10% of the draw
  back out as a real cost instead of netting to $0. An explicitly-funded pre-tax draw (a home
  down payment) is priced the same way, confirmed end to end in
  `events.oneTimeSpend.test.ts`.
