# Issue #82 — Generalize Social Security into a jurisdiction-neutral government-benefit seam

## Overview

This epic renames the engine-facing Social Security vocabulary to jurisdiction-neutral
**government-benefit** terms, fixes a real engine↔`rules` boundary violation, and lands two
`rules`-side correctness upgrades — **without** building a speculative multi-program
abstraction. The engine keeps its existing `Jurisdiction` socket; after this work the engine
no longer knows the eligibility age (62), the 62→claim COLA bridge, the COLA formula, or what
counts as covered earnings — all of those are `rules` facts now. The engine still owns the
neutral earnings *accumulator*, scheduling, an *opaque* cached base, and the plan-level COLA
*rate*.

All six planned phases (0–6) plus a doc-cleanup follow-up landed as separate green,
RALPH-formatted commits. The jobs-derived earnings source (#83), the Retirement Earnings Test
(#81), and ≤85% benefit tax inclusion were explicitly kept out of scope.

## RGR Verification Details

Each phase followed Red → Green → Refactor:

- **Phase 2 (isCoveredEarnings):** RED — added engine tests asserting the seam predicate
  decides covered earnings and that the fallback is `wages`-only; they failed while the engine
  still hardcoded `wages || ordinaryIncome`. GREEN — added `isCoveredEarnings` to the seam +
  `usJurisdiction`, routed the accumulator through it.
- **Phase 3 (seam split + COLA):** RED — reworked stubs to the split seam; GREEN — base +
  `colaAdjustedBenefitCents`. Added a **parity test** sweeping claimingAge 62–70 × 0–25
  post-claim years, asserting the collapsed single COLA factor matches the old two-step
  bridge+forward computation to **≤ 1¢** (guardrail: > 1¢ = real regression, do not accept).
- **Phase 4 (eligibility gate):** RED — `< 40 credits → 0` and partial-credit tests failed
  (no gate). GREEN — credits-from-annual-totals inside the base function, gate at 40. Verified
  a full 35-year career still clears the gate ($3,794.80 base) so nothing is silently zeroed.
- **Phase 5 (recompute):** RED — claim-and-keep-working bump + retire-then-claim-flat tests
  failed under "cache forever". GREEN — `lastComputedThroughYear` marker drives recompute on
  completed-year covered-earnings growth. Two capture-once stub tests were updated because the
  seam is now legitimately re-invoked on recompute.
- **Phase 6 (benefitColaRate):** RED — a decoupled-COLA test failed to typecheck (unknown
  input field). GREEN — optional `benefitColaRate` threaded Plan → base → input → `ctx.colaRate`
  with the coupling default (`?? annualInflationRate`) in the engine.

Final state: `npm run check` (purity + typecheck + tests) all green.

## Key Decisions & Why

- **No `GovernmentBenefitProgram` abstraction.** A second jurisdiction is hypothetical, not
  named; freezing an interface against one implementation is speculative generality. The epic
  keeps the existing `Jurisdiction` socket and makes the vocabulary truthful instead.
- **Seam split (Option B COLA collapse).** The old engine grew the benefit in two rounded
  steps — an age-62→claim eligibility *bridge* then a post-claim *forward* COLA. Because
  `currentAge = claimingAge + yearsSinceClaim`, both fold algebraically into one factor
  `(1 + colaRate)^(currentAge − 62)`. The engine holds the base as an **opaque** number and
  calls `colaAdjustedBenefitCents` once per year; it never sees the formula or the eligibility
  age. Exact for the modelled 62–70 range; the only divergence from the old engine is a dropped
  intermediate rounding, bounded to ≤ 1¢ by the parity test.
- **`GovernmentBenefitClaim` moved to `jurisdiction.ts`** (the seam it feeds), re-exported from
  `socialSecurityBenefit.ts` to keep a single import site. `GovernmentBenefitContext` reshaped
  to `{ year, currentAge, colaRate }` (the COLA seam's context).
- **Eligibility gate lives *inside* the base function** (no new engine seam): credits from
  annual totals `min(4, floor(wages / quarterOfCoverage))`, gate at 40. `QUARTER_OF_COVERAGE_CENTS`
  (SSA 2026 ≈ $1,890) and `MAX_CREDITS_PER_YEAR = 4` are AWI-indexed via the same growth
  mechanism the bend points use — disclaimed estimates consistent with the file's other constants.
  US credits are annual-earnings-based (since 1978), so no quarter/month granularity.
- **Recompute signal** is a per-person `lastComputedThroughYear` marker read straight off the
  earnings accumulator (no per-month record rebuild). `currentAge` advances on recompute so
  `rules` re-indexes the grown record to the same age-60 year. A `NOTE → #81` records that this
  models only the upside of working past claim; the Retirement Earnings Test withholding is
  deliberately out of scope.
- **`benefitColaRate` defaults in the engine** in decimal units (`?? annualInflationRate`), so
  an unset plan keeps the benefit COLA coupled to general CPI and setting it decouples the two.
  Optional at every layer; UI control deferred (optional per the epic).

## Changes Made

- **`packages/engine/src/jurisdiction.ts`** — added `GovernmentBenefitClaim`; reshaped
  `GovernmentBenefitContext` to `{ year, currentAge, colaRate }`; added `isCoveredEarnings`,
  `governmentBenefitBaseMonthlyCents`, `colaAdjustedBenefitCents`; removed
  `socialSecurityMonthlyBenefitCents`.
- **`packages/engine/src/socialSecurityBenefit.ts`** — re-export `GovernmentBenefitClaim`;
  `priceGovernmentBenefitBaseMonthlyCents` (clamps ≥ 0, calls the base seam); deleted the dead
  `priceSocialSecurityAnnualRealCents`.
- **`packages/engine/src/projection/socialSecurity.ts`** — `coversEarnings` fallback (`wages`
  only); engine loop now caches an opaque base, recomputes on completed-year earnings growth,
  and grows the base via the COLA seam; removed `SS_ELIGIBILITY_AGE` and the bridge.
- **`packages/engine/src/projection/simulate.ts` / `simulate.types.ts`** — `accumulateEarnings`
  takes the jurisdiction; added `lastComputedThroughYear` sim-state map; `benefitColaRate` on
  `HouseholdSimInput`, threaded to the COLA seam with the CPI default; refreshed the stale
  "held nominal-flat" comment.
- **`packages/engine/src/{plan.ts, ledger/ledgerBase.ts, projectionBase.ts,
  projection/buildHouseholdInput.ts}`** — `benefitClaimingAge` rename; optional
  `benefitColaRate` threaded Plan → base → input.
- **`packages/engine/src/{person.ts, projection/report.ts, testing/samplePlan.ts,
  earningsRecord.ts}`** — `benefitClaimingAge` rename + doc refreshes.
- **`packages/rules/src/socialSecurity.ts`** — `isCoveredEarnings`;
  `governmentBenefitBaseMonthlyCents(claim)` with the 40-credit eligibility gate and new QOC
  constants; `colaAdjustedBenefitCents(base, ctx)` with `SS_ELIGIBILITY_AGE`.
- **`packages/rules/src/index.ts`** — export + wire the three new seam functions into
  `usJurisdiction`; dropped `socialSecurityMonthlyBenefitCents`.
- **`packages/app/src/{planDefaults.ts, components/budgetEditor, components/debugPanel}`** —
  `benefitClaimingAge` rename.
- **Tests** — engine `socialSecurity.test.ts` (predicate, split seam, COLA, recompute,
  benefitColaRate), `socialSecurityBenefit.test.ts`, `projectionBase.test.ts`, and rules
  `socialSecurity.test.ts` (claim-shaped formula, COLA seam, parity ≤ 1¢, eligibility gate,
  covered-earnings predicate).

## Verification & Testing

```
npm run check   →   ✓ Engine purity check passed
                    ✓ tsc --noEmit (typecheck clean)
                    Test Files  38 passed (38)
                    Tests  438 passed | 45 todo (483)
```

- Baseline before the epic: 425 tests green.
- Net −3 from deleting the dead `priceSocialSecurityAnnualRealCents` tests (Phase 1), +16 new
  tests across Phases 2–6 → **438 green**.
- Parity guardrail (Phase 3): max drift across the 62–70 × 0–25 sweep is **≤ 1¢**.
- Engine purity intact — no `rules`/app imports leaked into the engine.
