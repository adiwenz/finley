# Summary — issue #185

Epic: Funding — Slice #6. **A stranded event now stops the projection instead of minting net
worth.** Design: `docs/projection-blocking-design.md` §3, §7, §8, §10.

## Overview

An explicitly-funded obligation (today: a home purchase's down payment) can become unfundable after
it was authored — an earlier edit drains the account it named. The simulator used to execute it
anyway: it created the $400k property and $320k mortgage even when the down payment could not be
resolved, minting the funding gap as permanent, compounding net worth. This branch makes the
simulator stop at the point it can no longer produce truthful results, rather than fabricate an
asset or invent financing.

The core invariant: **the engine stays completely truthful; the chart is allowed to communicate
more than the engine simulates.** Simulation state and presentation state are kept strictly apart —
the blocked marker is the only place the app draws something the engine never simulated, and it is
read off an engine-computed figure, never derived in the app.

Delivered in three commits (whole-issue split, no declared tasks):
1. `c6d3d15` — engine: pre-flight funding, block, truncate, suppress artifacts.
2. `3fe4231` — retirement solver: blocked as a third state; panel copy.
3. this commit — net-worth chart: terminal blocked marker; the engine marker figure.

## Key decisions & why

- **Pre-flight against a scratch copy** (`resolveFundingDraws`). Each draw is priced before any real
  balance moves, so the first shortfall is a *structural* block, not a partial mutation that depends
  on execution order. Draws before it apply; the blocking draw and any after it are omitted. The
  blocked month still runs its full pipeline (income, tax, cascade, compounding) — only the blocking
  obligation and its artifacts are dropped — so its net worth is a genuine end-of-month figure, and
  it is the last month emitted.
- **Artifact suppression keyed on the property, not the mortgage's own event.** A blocked purchase
  must originate neither the property nor its mortgage. Matched via `SimProperty.causedByEventId`
  (the purchase event) and the property's `mortgageLiabilityId` — because the mortgage liability's
  own `causedByEventId` is the `LoanEvent` id (`<propertyId>-mortgage`), not the purchase id.
- **Blocked ≠ insolvent, and blocked precedes insolvency.** Insolvency has a real continuation (a
  card at an APR) so it keeps simulating with net worth nulled — unchanged. A block has no
  continuation. A month that is both reports **blocked**, because draws are pre-flighted before the
  shortfall cascade runs.
- **`planSurvives` was a live bug the instant truncation shipped** (§8): `Array.every` over a
  truncated series is vacuously `true`, so a blocked plan would report as *surviving*. Introduced
  `planOutcome(): "survives" | "fails" | "blocked"`, checked before the vacuous `every`.
- **Blocked is a third retirement state, never `null`.** `null` means "no age works — retire later";
  blocked means "the projection stopped — fund the obligation differently." The two demand opposite
  user actions, so collapsing them destroys the only useful information. `solveRetirement` probes at
  life expectancy (the best-funded case) only when no age was found, so a feasible plan pays nothing.
- **`computeOnTrackFraction` horizon derives from the plan**, not `series.months.length - 1`, which
  collapses to the blocked month on a truncated run. Identical for untruncated runs.
- **The chart marker is engine-computed, app-read.** `netWorthChartData.ts` is guarded against cents
  arithmetic (it makes no financial claims — the insolvency counterfactual is read, not computed).
  So the "shortfall below final net worth" figure (`BlockedObligation.markerNetWorthCents`) is
  computed once in the engine and read by the chart, exactly like the insolvency
  `debtFundedNetWorthNominalCents`.

## RGR verification details

Each behaviour was driven RED → GREEN:
- **Block core** (`simulate.blocking.test.ts`, new): a $50k source against an $80k down payment —
  RED asserted `status === "blocked"`, no property/mortgage originated, cash retained, genuine net
  worth, marker figure; the simulator returned `{opening, months}` with no such fields until the
  pre-flight + truncation landed.
- **E2E regression** (`events.homePurchase.test.ts`): an affordable purchase stranded by a later
  cash purchase — proved through `interpretLedger` → `buildProjection` that no fictional equity is
  created (neither property nor mortgage), while the affordable purchase still executes.
- **Retirement** (`retirementSolver.test.ts`): RED pinned `planSurvives(blockedSeries) === false`
  (the vacuous-`every` bug) and `solveRetirement(...).blocked` distinct from a genuinely-null plan.
- **View/panel** (`retirementView.test.ts`, `retirementPanel.test.tsx`): RED for
  `RetirementView.blocked`/`blockedAtAge` and the "Can't compute a retirement age … blocked at age
  N" copy replacing the headline/on-track lines.
- **Chart** (`blockedMarker.test.ts`, new): RED for `NetWorthChartData.blocked` — marker at the
  blocked month, obligation/required/available/shortfall, y read off `markerNetWorthCents`, no point
  past the block, none for a plan that ran to horizon.

## Changes made

**Engine**
- `projection/simulate.types.ts` — `ProjectionSeries` gains `status`, `simulatedThroughMonth`,
  `blockedAtMonth?`, `blockingObligation?`; new `BlockedObligation` (required/available/shortfall +
  `markerNetWorthCents`); `SimProperty` gains `causedByEventId` + `mortgageLiabilityId`.
- `projection/fundingDrawStep.ts` — `resolveFundingDraws` pre-flights against a scratch copy and
  reports a `FundingBlock`.
- `projection/simulate.ts` — detects the block, suppresses the blocked event's property/mortgage,
  truncates, computes the marker figure, sets the new fields; never throws.
- `projection/{assetSteps,liabilitySteps}.ts` — `advanceProperties`/`advanceLiabilities` accept a
  suppressed-id set. `projection/financialObligation.ts` + `ledger/eventHandlers.ts` — the
  down-payment obligation carries its `sourceEventId`. `projection/buildHouseholdInput.ts` — plumbs
  the property linkage. `index.ts` — exports `BlockedObligation`.
- `retirementTypes.ts` — `RetirementEvaluation` and `RetirementSolution` gain `blocked` +
  `blockedAtMonth`. `retirementSolver.ts` — `planOutcome`/block-aware `planSurvives`, `evaluateSeries`,
  plan-derived `computeOnTrackFraction` horizon, `solveRetirement` block detection.

**App**
- `retirementView.ts` — `RetirementView` gains `blocked` + `blockedAtAge`.
- `components/retirementPanel/retirementPanel.tsx` — blocked copy, suppressing headline/on-track.
- `components/netWorthChart/netWorthChartData.ts` — `BlockedMarker` + `blocked` on the chart data
  (all reads, no arithmetic). `components/netWorthChart/netWorthChart.tsx` — draws the marker and its
  tooltip in the same failure-red language as the insolvency "runs out" marker.

## Verification & testing

- Engine: **935 passed** (45 todo), 55 files.
- App: **565 passed**, 49 files.
- `npm run check` (purity + typecheck + tests) green.

## Deferred (explicitly out of scope — #186 / later slices)

- Chart hatching, warning copy, and recovery suggestions (issue: "those belong in #186").
- The full §5 `FundingFailure` union (`funding-configuration` vs `no-eligible-source-suffices`,
  `alternativeSources`) and the per-obligation `ObligationOutcome` map — the ACs need only
  required/available/shortfall + the blocking identity, which `BlockedObligation` carries.
- The §9 authoring/preview pipeline (`previewPlanChange`, `PlanChangeImpact`, soft warnings).
