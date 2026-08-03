# Handoff — issue 185

Whole-issue mode (no declared tasks). I split it into three coherent parts:

**My breakdown:**
1. **Engine truncation & blocking** — DONE (commit c6d3d15).
2. **Retirement solver blocked state + panel copy** — DONE (this commit).
3. **UI: net-worth chart — no months after `blockedAtMonth` + terminal blocked marker** — REMAINING.

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

## Live constraints (Part 3 must honour)

- **`simulatedThroughMonth === months.length - 1` always**, and `=== blockedAtMonth` when blocked.
  The blocked month IS emitted (it's the last entry of `months`). Do not treat blocked as "the
  month wasn't run."
- **Blocked ≠ insolvent, and they can co-occur.** A blocked month may also have `isInsolvent`;
  status is still `"blocked"` (block is pre-flighted before the cascade — see
  `simulate.blocking.test.ts` "reports blocked even when the same month has also exhausted its
  credit"). Insolvency behaviour is unchanged: `netWorth == null`, `isInsolvent`, sim continues,
  status stays `"ran-to-horizon"`.
- **Part 2 done — how blocked propagates (Part 3 reads these).** `ProjectionSeries.status` /
  `blockedAtMonth` / `blockingObligation` (Part 1). `RetirementSolution.blocked` +
  `blockedAtMonth`, `RetirementEvaluation.blocked` + `blockedAtMonth` (`retirementTypes.ts`).
  `planOutcome()` (new, exported) is the block-aware survival read; `planSurvives` now goes through
  it. `RetirementView.blocked` + `blockedAtAge` (app `retirementView.ts`). The panel renders the
  blocked copy and suppresses the headline/on-track lines when `view.blocked`.
- **Part 3 — chart (§10).** Render no simulated month after `blockedAtMonth` (the series already
  omits them — the chart just needs to draw the terminal marker and not assume a full horizon). Add
  a terminal blocked marker in the same visual language as insolvency (see how the chart already
  handles the insolvent/`netWorth == null` tail — reuse that language). The marker must identify
  the blocking obligation and show required / available / shortfall (all on
  `series.blockingObligation`: `label`, `requiredCents`, `availableCents`, `shortfallCents`,
  `month`). The marker is presentation-only — NEVER a simulation month, never compounds, never
  enters retirement solving, never an engine input. It MAY be drawn below the final simulated net
  worth by the shortfall amount (design's optional visual — the "$450k − $30k = displayed $420k"
  example in the issue). Chart entry points: `packages/app/src/components/netWorthChart/`
  (`netWorthChart.tsx`, `netWorthChartData.ts`, `netWorthBreakdown.ts`). The insolvency-marker
  test at `insolventMonthNetWorth.test.ts` is the closest existing pattern.

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
