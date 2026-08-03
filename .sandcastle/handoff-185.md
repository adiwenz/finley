# Handoff — issue 185

Whole-issue mode (no declared tasks). I split it into three coherent parts:

**My breakdown:**
1. **Engine truncation & blocking** — DONE (this commit).
2. **Retirement solver blocked state** — REMAINING.
3. **UI: chart blocked marker + retirement panel copy** — REMAINING.

Design source of truth: `docs/projection-blocking-design.md` (§3 blocking semantics, §7 simulator,
§8 retirement solve, §10 UI). The issue body scopes it down — follow the issue's acceptance
criteria list, not every design-doc extra (the full `FundingFailure` union / `ObligationOutcome`
map are design-doc detail, deliberately NOT built; see Deferred).

## Part 1 — what landed (see this commit's diff)

`ProjectionSeries` now carries `status` (`"ran-to-horizon" | "blocked"`), `simulatedThroughMonth`,
`blockedAtMonth?`, `blockingObligation?: BlockedObligation` (all in
`packages/engine/src/projection/simulate.types.ts`). `simulateHousehold` pre-flights each month's
funding draws against a scratch copy, and on the first shortfall completes the month with the draw
+ its property/mortgage suppressed, emits that month, and stops. `BlockedObligation` is exported
from the engine barrel.

## Live constraints (Parts 2 & 3 must honour)

- **`simulatedThroughMonth === months.length - 1` always**, and `=== blockedAtMonth` when blocked.
  The blocked month IS emitted (it's the last entry of `months`). Do not treat blocked as "the
  month wasn't run."
- **Blocked ≠ insolvent, and they can co-occur.** A blocked month may also have `isInsolvent`;
  status is still `"blocked"` (block is pre-flighted before the cascade — see
  `simulate.blocking.test.ts` "reports blocked even when the same month has also exhausted its
  credit"). Insolvency behaviour is unchanged: `netWorth == null`, `isInsolvent`, sim continues,
  status stays `"ran-to-horizon"`.
- **Part 2 — the live `planSurvives` bug (§8).** `retirementSolver.ts:93` is
  `series.months.every(monthSurvives)`; `Array.every` over a TRUNCATED series returns `true`, so a
  blocked plan currently reports as *surviving*. This is the first thing to test (fails in the
  "everything is fine" direction). Blocked must become a third solver state distinct from `null`
  (`null` = "no age works, retire later"; blocked = "projection stopped, fund the purchase
  differently"). Touch: `RetirementSolution`, `RetirementEvaluation` (`retirementTypes.ts`),
  `planSurvives` + `evaluateAtAge`/`evaluateFullRetirementAtAge` + `earliestSurvivingAge`
  (`retirementSolver.ts`), `computeOnTrackFraction` (its `horizon = series.months.length - 1`
  collapses to the blocked month — §8), and app `retirementView.ts` / the retirement panel. Panel
  copy required: *"Can't compute a retirement age — your projection is blocked at age 40."*
  (age = `plan.currentAge + blockedAtMonth/12`).
- **Part 3 — chart (§10).** Render no simulated month after `blockedAtMonth` (the series already
  omits them). Add a terminal blocked marker in the same visual language as insolvency; it must
  identify the blocking obligation and show required / available / shortfall (all on
  `series.blockingObligation`). The marker is presentation-only — never a simulation month, never
  compounds, never enters retirement solving. It MAY be drawn below the final net worth by the
  shortfall amount (design's optional visual). Chart entry points:
  `packages/app/src/components/netWorthChart/`.

## Dead ends (do not re-propose)

- **Synthetic funding-deficit liability** (issue #177) to continue past the gap — rejected; it
  fabricates a loan from nobody. Truncate the honest curve instead.
- **Skip the obligation and simulate on without it** — rejected; presents one hypothetical as *the*
  projection. Only the single blocked month omits the obligation.
- Suppression is matched via `SimProperty.causedByEventId` (= purchase event id) and the property's
  `mortgageLiabilityId`, NOT via the liability's own `causedByEventId` (that equals the LoanEvent
  id `<propertyId>-mortgage`, not the purchase id). Keep this linkage if you touch it.

## Deferred (explicitly out of scope for #185 — belong to #186 / later slices)

- No hatching, warning copy, or recovery suggestions on the chart (issue: "those belong in #186").
- Full `FundingFailure` discriminated union (`funding-configuration` vs
  `no-eligible-source-suffices`, `alternativeSources`) and per-obligation `ObligationOutcome` map —
  the issue's ACs only need required/available/shortfall + blocking identity, which
  `BlockedObligation` carries. Don't build the larger design-doc types unless a Part needs them.
- The §9 authoring/preview pipeline (`previewPlanChange`, `PlanChangeImpact`, soft warnings) is a
  separate slice, not #185.
