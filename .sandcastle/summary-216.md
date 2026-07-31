# Issue #216 — Narrow the `@finley/engine` barrel to the Projection facade

## Overview

`packages/engine/src/index.ts` was a wide barrel re-exporting ~40 internal modules — the
simulator, the ledger, the waterfall, the snapshot/report pipeline, and the authoring transforms —
most with no importer. The engine is open-core: its only public surface should be the `Projection`
facade in `projectionRoot.ts`, plus the types a consumer names and the `Jurisdiction` seam the
`rules` package implements against.

This branch collapses `index.ts` to exactly `export * from "./projectionRoot"`, makes
`projectionRoot.ts` the complete public surface (104 exported symbols), adds a guard test that
ratchets the barrel shut, and moves every app/rules test and the shared test helpers onto the
public API so no test reaches past the facade. Engine-internal tests now import their internals by
relative module path rather than through the barrel.

## RGR Verification Details

- **RED:** Added `packages/engine/src/index.guard.test.ts`, which reads `index.ts` as source text
  (comments stripped) and asserts it has exactly one statement — `export * from "./projectionRoot"` —
  and names no other module. With the wide barrel in place it failed on both assertions (dozens of
  extra export statements and module specifiers).
- **GREEN:** Widened `projectionRoot.ts` to cover the full public surface, collapsed `index.ts`,
  and migrated every test off the removed internals. The guard test, the pre-existing app-side
  `planWrites.guard.test.ts`, and the whole suite went green together.
- **Verification:** `npm run check` (purity → typecheck → all tests) passes: **93 test files, 1221
  tests green, 45 todo, 0 failures**; engine purity clean; both guard tests pass.

## Key Decisions & Why

- **The facade is the whole surface; the barrel is one re-export.** `index.ts` re-exports
  `./projectionRoot` and nothing else. Every legitimately-public symbol is re-exported *from*
  `projectionRoot.ts`, beside a justification, so widening the surface is a deliberate edit where
  the surface lives. The 11 seam context/param types the `Jurisdiction` interface references
  (`RmdContext`, `DeferralLimitContext`, `GovernmentBenefitContext`, `HealthCostContext`,
  `GovernmentBenefitClaim`, `WithdrawalTaxBasis`, `ReturnTaxTreatment`, `TaxCategory`,
  `ModelAssumption`, `AccountReturnKind`, `EarningsRecord`) plus `JurisdictionContext` and the
  `nullJurisdiction` value were added — a `rules` implementation cannot type its arguments
  otherwise. `ProjectionIncomeSource` (a `ProjectionSeries` member a reader names) was added too.
- **Ground-truth was re-derived, not cherry-picked from the prior attempt.** The real production
  import set (65 symbols across `app`/`rules` non-test code) was computed from the current tree; all
  65 are present on the facade. Nothing on the surface writes — the authoring transforms
  (`withPayChange`, `addEvent`, …) stay internal, enforced by `planWrites.guard.test.ts`.
- **Tests observe through the public API.** App tests build via `Projection.fromInput`/`fromState`
  and the harness, author via the typed facade methods (`marry`, `haveChild`, `buyHome`,
  `setJobMonthlyIncome`, `addBudgetLineOverride`, `reorderGoal`, …), and read via `run()` /
  `retirement()` / `funding()` / `accountDescriptors()` / `ProjectionResult` fields — never a
  simulator, ledger, or transform internal. The shared harness builds its `ProjectionState` from a
  literal of the public `Scenario`/`Ledger` shapes handed to `Projection.fromState` (the app's real
  restore door), and the plan-fixture builders route their adjustments through `Projection.transact`.
- **Engine-internal tests import by relative path.** With the barrel no longer re-exporting them,
  the 15 engine test files (plus `events.testSupport.ts`, `playground.ts`, `repl.ts`) now import
  each internal from its defining module (`./ledger/addEvent`, `./projection/snapshot`, …).
- **Rules tests exercise the interface, not the simulator.** Where a `rules` test drove a full
  household simulation (`simulateHousehold`, `SimAccount`, `*_TAX_PROFILE`) to observe an effect the
  engine already covers, that white-box duplication was dropped in favour of direct
  `Jurisdiction`-method contract assertions (`taxableWithdrawalCents`, `returnTaxTreatment`,
  `requiredMinimumDistributionCents`, `governmentBenefitBaseMonthlyCents`,
  `healthCostBenchmarkMonthlyCents`, `retirementDeferralLimitCents`) using the public context types.
- **No engine symbol was left existing only for tests.** Every internal the app tests used to reach
  (`createProjectionBase`, `goalFundAccountId`, `firstInsolventMonth`, `simulateHousehold`,
  `interpretLedger`, `replayLedger`, …) still has genuine engine production/test uses, so none was
  orphaned; the barrel collapse itself removes app tests' access to them. One irreducible white-box
  gap — a cent-exact withdrawal gross-up under the *real* jurisdiction, which the facade exposes no
  primitive for — was documented with a `TODO(facade):` note in `retirementView.test.ts` rather than
  silently dropped; the same arithmetic is covered engine-side in `projection/withdrawal.test.ts`.

## Changes Made

- `packages/engine/src/index.ts` — collapsed to `export * from "./projectionRoot"` (plus doc).
- `packages/engine/src/index.guard.test.ts` — new; the barrel ratchet.
- `packages/engine/src/projectionRoot.ts` — added the jurisdiction seam (interface + context/param
  types), `nullJurisdiction`, `TaxCategory`, `ModelAssumption`, `AccountReturnKind`,
  `EarningsRecord`, `ProjectionIncomeSource` to the facade vocabulary.
- `packages/app/src/testing/projectionHarness.tsx`, `testing/planFixtures.ts` — route through the
  public API (public `Ledger` literal + `Projection.fromState`/`transact`) instead of engine
  internals (`emptyLedger`, `scenarioOf`, `withLedger`, `mapJob`, `with*`).
- 14 app test files + 2 rules test files — migrated onto the public `Projection` API / `Jurisdiction`
  interface; no engine-internal import remains.
- 15 engine test files + `events.testSupport.ts` — repointed internal imports to real relative
  modules.
- `playground.ts`, `repl.ts` — dev scratch scripts moved off the removed `emptyLedger` export.

## Verification & Testing

- `npm run check` green: engine purity clean, `tsc --noEmit` clean, **1221 tests passing** (45 todo)
  across **93 test files**, 0 failures.
- `index.guard.test.ts` and `planWrites.guard.test.ts` both pass — the facade is held to a single
  re-export, and the app is held to the facade surface.
