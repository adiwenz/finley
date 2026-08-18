# Summary — issue #160: Partner accounts and household funding

## Overview

Issue #160 asked for two things: (1) a partner's individually-owned accounts should
activate/deactivate with their household membership rather than existing for the whole
simulation, with reporting that preserves per-person net worth alongside the household total;
and (2) shared household costs should be split fairly between active partners by
income/assets rather than funded from whichever account happens to be first in a global
waterfall — while obligations that belong to one person alone (that person's own debt) stay
that person's to fund.

This was built across three commits:

- **Part A** (`99ed0b2`) — partner account lifecycle (mint/drain on join/separation) and
  per-person net worth reporting.
- **Part B** (`91a7ed0`) — the household funding waterfall: shared obligations split
  proportionally to income (or, when nobody has income, to eligible assets), funded from
  each person's own accounts first, with cross-partner coverage only when one person's own
  resources are exhausted.
- **Part C** (this commit) — the deferred final sentence of the issue: "Person-specific
  obligations should remain assigned entirely to that person." A partner's own liability
  payment (a car loan, a personal credit card) is now charged against their own take-home and
  their own accounts, never the other partner's, and never smoothed into the proportional
  shared split.

## RGR Verification Details

Part C added five tests, each written RED-first against the live engine (never a
reimplementation) and confirmed to fail for the right reason before the corresponding
implementation change:

1. `financialObligation.test.ts` — `buildObligations` carries a liability's `ownerId` onto
   its obligation (RED: `ownerId` didn't exist on `FinancialObligation`); an expense-series
   obligation's `ownerId` stays absent.
2. `waterfall.test.ts` — a personal obligation exceeding its owner's take-home becomes that
   person's shortfall alone, never drawn from the other partner's leftover (RED:
   `personalObligationCentsByPerson` didn't exist on `WaterfallInput`).
3. `withdrawal.test.ts` — end-to-end via `simulateHousehold`: a partner's own loan payment
   draws only their own brokerage (RED: the whole payment was still being split
   proportionally as a shared cost, drawing $0 from the owner's account).
4. Diagnosing why (3) still failed after wiring the obligation split surfaced a second,
   independent bug in `buildWithdrawalSources`'s existing per-person decumulation preference
   (built in Part B): it silently skipped its own person-aware liquidation pass whenever
   fewer than two people carried a *positive* share of the shortfall. A personal obligation
   routinely produces exactly one positive share (100% owed by one person), which is exactly
   the case that guard was skipping — it fell through to the ownership-blind pooled pass and
   drew the *other* partner's brokerage instead. Pinned with a new unit test at
   `withdrawal.ts`'s own seam before fixing.
5. Full regression suite (`npm run test`, `npm run typecheck`, `npm run check:purity`) confirms
   no existing behavior changed: 2044/2044 tests green (up from 2039 pre-Part-C), including
   every existing single-earner and two-earner shared-obligation test.

## Key Decisions & Why

- **Only liability payments carry a usable `ownerId`.** `FinancialObligation.ownerId` is
  populated exclusively from `SimLiability.ownerId` (always an authored household member).
  Expense-series obligations (budget lines, health, event-spawned streams) deliberately do
  NOT get one: every budget line compiles under `PRIMARY_PERSON_ID` regardless of who it's
  really for (no real per-person authoring surface exists yet — pre-existing, documented in
  `createProjectionBase`), and an event-spawned series' `ownerId` names who the expense is
  *for* (e.g. a child), not who owes it. Reading either as "charge this person's take-home
  first" would have been actively wrong — a child's cost would vanish from both the shared
  and personal pools since a child is not a funding-eligible household member.
- **A new waterfall step (2.5), not a rewrite of the existing shared split.** Personal
  obligations are charged against each person's own take-home in a small new
  `chargePersonalObligations` step between `computeTakeHome` and `splitSharedObligation`,
  rather than folded into `splitSharedObligation` itself. That function's cumulative-rounding
  and shortfall-flooring invariants are load-bearing (per Part B's handoff) and this keeps
  them untouched. The charge is floored at each person's own *positive* take-home, so it can
  never push someone already non-negative into the household's shared negative-take-home
  pool — the mechanism `splitSharedObligation` uses to let a partner's discretionary leftover
  cover a *shared* shortfall would otherwise silently leak into covering a *personal* one.
- **`obligations` threaded through instead of a scalar.** `planMonthAllocation`,
  `projectObligationShortfallCents` and `allocateMonth` now take the `FinancialObligation[]`
  list (already built once per month in `simulate.ts`) instead of the pre-summed
  `automaticFundingCents` scalar, and derive both the shared total and the
  per-person personal total from that one list. One source of truth — the shared/personal
  split can't drift from the obligations actually funded.
- **Fixed the decumulation preference's "≥2 positive shares" gate.** This was the one genuine
  regression risk: Part B's per-person liquidation preference in `buildWithdrawalSources` only
  activated with two or more positive entries, reasoning that a single-earner household's lone
  entry made the person-aware pass redundant with the pooled fallback. That reasoning holds for
  a single-*person* household (every account belongs to the one person either way) but not for
  a two-person household where only one person's share is positive — exactly what a personal
  obligation produces. Loosened to activate whenever any positive share exists; the
  single-earner case remains byte-identical (same account set, same order) since that was
  already mathematically guaranteed, confirmed by the unchanged regression suite.

## Changes Made

- `packages/engine/src/projection/financialObligation.ts` — `FinancialObligation.ownerId?:
  string`; `buildObligations` populates it from `liability.ownerId` for liability-sourced
  obligations only.
- `packages/engine/src/projection/waterfall.types.ts` — `WaterfallInput.
  personalObligationCentsByPerson?: (personId) => Cents`, a new optional seam.
- `packages/engine/src/projection/waterfall.ts` — new `chargePersonalObligations` (waterfall
  step 2.5), wired into `runWaterfall` between `computeTakeHome` and `splitSharedObligation`;
  merges the personal shortfall into `obligationShortfallCents` /
  `obligationShortfallByPersonCents` / `shortfallCents`.
- `packages/engine/src/projection/allocationStep.ts` — new `splitAutomaticObligations` helper;
  `planMonthAllocation`, `projectObligationShortfallCents`, `allocateMonth` now take the
  `obligations` list instead of a pre-summed `sharedObligationCents` scalar.
- `packages/engine/src/projection/simulate.ts` — the two call sites pass `obligations`
  instead of `automaticFundingCents`.
- `packages/engine/src/projection/withdrawal.ts` — `buildWithdrawalSources`'s per-person
  liquidation preference pass now activates whenever any person carries a positive share
  (was: only with two or more), so a personal obligation's single-person share still prefers
  that person's own accounts.
- Tests: `financialObligation.test.ts`, `waterfall.test.ts`, `withdrawal.test.ts` (2 new unit
  tests plus 1 new end-to-end `simulateHousehold` test).

## Verification & Testing

- `npm run typecheck` — clean.
- `npm run check:purity` — clean (no I/O/app/rules imports in engine source).
- `npm run test` — **2044 tests green** (147 test files), 45 todo (pre-existing, unrelated).
