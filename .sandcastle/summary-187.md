# Slice #6c — The app says how to fix a blocked projection (issue 187)

## Overview

Building on #186 (which reports *where and why* a projection stopped), this slice says whether the
money exists somewhere else — distinguishing an authoring/funding-configuration problem from a real
lack of eligible funding, and telling the household how to fix it. It adds the engine-owned
eligibility seam, classifies a blocked funding draw into one of two `FundingFailure` shapes, surfaces
the distinction through the blocked-projection warning, and demotes the authoring-time affordability
gate from a refusal to a reporter so an unaffordable purchase is authored and reported as blocked
rather than refused (design §5, §6, §9, §13).

## Key Decisions & Why

- **`getEligibleFundingSources(treatment, accounts)` is the sole eligibility rule.** Both current
  treatments (`expense`, `asset-acquisition`) admit liquid asset accounts only — retirement is
  illiquid and excluded; credit cards (eligible for `expense`) are a later slice. The switch spells
  out both cases so #191's credit branch has an obvious home. The UI never re-implements eligibility;
  it asks here.
- **`classifyFundingFailure` prices the whole eligible pool through the same
  `resolveOrderedFundingDraw` the simulator and affordability reporter share.** If the eligible pool
  covers the required amount net of tax → `funding-configuration`, carrying advisory
  `alternativeSources` (eligible-but-unselected accounts, each at its own net-of-tax available).
  Otherwise → `no-eligible-source-suffices`. Neither is insolvency. Every figure is net of the
  capital-gains tax liquidating the sources owes, so an appreciated brokerage delivers less than its
  balance.
- **The engine recommends, never chooses (AC6).** The classifier only reports; the actual draw still
  resolves in its named order and fell short. Nothing is reordered, substituted, or liquidated.
- **Classification happens at block detection**, over the pre-blocked-draw taxable base, and rides on
  `BlockedObligation.fundingFailure` so the app reads it straight off the series.
- **The warning branches on `fundingFailure.kind`.** `funding-configuration` names the eligible
  accounts that could cover it and their net-of-tax available, and tells the user to re-point the
  funding. `no-eligible-source-suffices` states the eligibility fact and explicitly withholds any
  affordability verdict — a household with ample retirement wealth lands here.
- **Affordability stops being a refusal (§9, §13).** The home-purchase down-payment hard block is
  removed; an unaffordable purchase is authored and surfaces as a blocked projection. The shared
  availability calculation survives as `fundingLookup.availabilityAt`, still exposed through
  `Projection.funding()` and used by the picker's advisory — a reporter, not a gate. Only structural
  faults (missing source, out-of-range down payment) still refuse.

## Changes Made

- **`packages/engine/src/projection/fundingEligibility.ts`** (new) — `getEligibleFundingSources`,
  `FundingTreatment`, `EligibilityCandidate`.
- **`packages/engine/src/projection/fundingFailure.ts`** (new) — `FundingFailure`,
  `classifyFundingFailure`, `EligibleAccountState`.
- **`fundingDrawStep.ts`** — classifies the block, attaches `FundingBlock.fundingFailure`.
- **`simulate.ts` / `simulate.types.ts`** — `BlockedObligation.fundingFailure` (required); mapped
  from the block.
- **`index.ts`** — exports `FundingFailure`, `getEligibleFundingSources`, `FundingTreatment`,
  `EligibilityCandidate`.
- **`ledger/eventHandlers.ts`** — home-purchase `check` no longer refuses on a funding shortfall
  (removed the §4.5 hard block and its now-dead dollar formatter).
- **`ledger/addEvent.ts` / `ledger/interpretState.ts`** — doc updated: `fundingAvailabilityAt` is now
  the injected reporter, gating nothing.
- **App** — `ledgerView.ts` (`BlockedWarningView` discriminated union; `blockedWarning` resolves
  alternative-account labels via `funding.sourcesAt`), `components/blockedWarning/blockedWarning.tsx`
  (branching copy), `main.tsx` (threads `funding`), `homePurchaseForm.tsx` (comment).

## RGR Verification Details

Each seam was driven test-first (RED → GREEN):
- `fundingEligibility.test.ts` — RED (no module) → eligibility filters liquid, excludes retirement.
- `fundingFailure.test.ts` — RED → both shapes, tax net of balance, alternatives, via a gain-taxing
  stub jurisdiction.
- `simulate.blocking.test.ts` — RED (`fundingFailure` undefined) → funding-configuration /
  no-eligible / "never reorders" through `simulateHousehold`.
- `ledgerView.test.ts` + `blockedWarning.test.tsx` — RED (no `kind`) → view branching, label
  resolution, distinct copy, no-insolvency-language guard.
- `scenarios.blockedPurchase.test.ts` — the end-to-end (AC7): two households built through the public
  `Projection` API render visibly different warnings; the configuration case names its alternative.
- Gate demotion: the home-purchase and facade gate-refusal tests were retargeted from `addEvent`/
  `buyHome` refusal to the surviving reporter (`availabilityAt`) and to accept-then-block behaviour;
  two "refused transaction" facade tests were re-pointed at a structural fault.

REPL/engine observation (`npx tsx` against `@finley/engine`) fixed the funding-configuration
scenario's exact figures before they were pinned.

## Verification & Testing

`npm run check` green: engine-purity ✓, typecheck ✓, **2005 tests passed** (45 todo). All eight
acceptance criteria are met.
