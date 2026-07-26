# Issue #138 — Split oversized engine/rules files into focused modules

## Overview

A readability/navigability refactor: five oversized files in the `engine` and `rules`
packages were split along the seams that already existed in the code, following the
repository's one-focused-module-per-concern convention. **No behaviour changed anywhere** —
every move is behaviour-preserving, the public barrels (`packages/engine/src/index.ts`,
`packages/rules/src/index.ts`) were **not touched**, and the full test suite passes
**unchanged** (900 passed | 45 todo, identical to the pre-refactor baseline).

Files split (before → after line count of the original file):

| Original | Before | After | New modules carved out |
|---|---:|---:|---|
| `projection/simulate.ts` | 982 | 218 | `runState`, `monthSnapshot`, `liabilitySteps`, `assetSteps`, `allocationStep`, `goalSteps` |
| `projection/waterfall.ts` | 720 | 459 | `waterfall.types`, `waterfallInvariants`, `taxAttribution` |
| `rules/federalTax.ts` | 508 | 257 | `federalTaxTables`, `federalTaxAttribution` |
| `projection/simulate.test.ts` | 1459 | 171 | `simulate.testSupport` + `simulate.{liabilities,allocation,savingsInterest}.test.ts` |
| `events.test.ts` | 1407 | 125 | `events.testSupport` + `events.{mechanics,relationships,budgetItems,loans,homePurchase}.test.ts` |

## RGR Verification Details

This is a pure, behaviour-preserving refactor, so — per the issue's Testing Decisions —
**no new tests were added**; the existing suite (which exercises external behaviour only,
through the public entry points `simulateHousehold`, `runWaterfall`, and the exported
federal-tax functions) *is* the safety net. The red→green loop for each of the 17 commits was:

- **RED:** an incomplete move breaks the per-commit gate — deleting a function from its
  origin file before wiring the import back fails `npm run typecheck` (surfacing every
  now-unused import via `noUnusedLocals`), and any behaviour drift would fail the suite.
- **GREEN:** the completed move (new module + re-pointed imports, unused imports pruned)
  restores `npm run check` (engine-purity + typecheck + full Vitest) to green.

The gate was run after **every** commit and stayed at **900 passed | 45 todo** throughout —
the count never moved, confirming no test was lost, duplicated, or altered in meaning.

## Key Decisions & Why

- **`SimState` is now an engine-INTERNAL exported type** (in `runState.ts`) so the six
  extracted step modules can share the exact shape, but it is deliberately kept **off** the
  public engine barrel — exactly like `SimPerson` since the #72 hinge. The barrel only
  re-exports `./simulate` and `./waterfall`, and `simulate.ts` imports `SimState` with
  `import type`, so it never rides the public surface.
- **Grouping principle: by the slice of `SimState` a helper reads/mutates.** Liability-map
  helpers cluster in `liabilitySteps`; asset/basis/property helpers in `assetSteps`; the
  income-assembly + `runWaterfall`-driving glue in `allocationStep`; goal disposition in
  `goalSteps`; the month snapshot in `monthSnapshot` (named to avoid colliding with the
  existing scrubber `snapshot.ts`).
- **Public surface preserved via re-exports.** Where a type or function physically moved but
  was publicly reachable, the original file re-exports it so external importers and the
  barrels resolve unchanged: `waterfall.ts` re-exports its six types + the two reconciliation
  invariants; `federalTax.ts` re-exports the tables/constants names and the two per-category
  attribution seams.
- **`taxAttribution.ts` also owns `TaxableByCategory` + `SourceTaxable`** (not just
  `attributeTaxToSources`/`addCategory`) so the split is a clean one-way import
  (`waterfall → taxAttribution`) with **no cycle**.
- **`federalTax ↔ federalTaxAttribution` cycle is intentional and safe.** The attribution
  module reads the core `federalTaxParts`/`FederalTaxParts` (now exported), and `federalTax.ts`
  re-exports the two public seams + imports `annualizeByCategory` back. Every cross-reference
  is a hoisted function invoked only at call time (never at module-eval), so the cycle can't
  deadlock — and it keeps the rules barrel and `federalTax.test.ts` resolving both seams
  through `./federalTax` unchanged (the issue explicitly forbids test-side edits here).
- **Test partition kept green at every step** by splitting **one sibling file per commit** and
  extracting the shared builders first (`*.testSupport.ts`, mirroring `engine/src/testing/`).
  The savings-interest describes — though nested inside the §5.0 allocation describe — were
  verified self-contained (no reference to the enclosing `person`/`retirementAccount`/`goalFund`
  scope) before being lifted to top-level in their own file.
- **Optional cleanups (commit 7 re-export tidy, commit 8 `accountsById` de-dup) were dropped**
  per the issue's guidance: the type re-export block already resolves the public types from
  `simulate.types.ts` (the new modules own functions/`SimState`, not public types), and
  centralising `accountsById` would change `SimState`'s shape / add coupling (out of scope).

## Changes Made

**Phase A — `simulate.ts`** (`simulateHousehold` remains as a thin §5-ordered orchestrator):
- `runState.ts` — `SimState` interface (all doc comments) + `initSimState`.
- `monthSnapshot.ts` — `snapshotMonth` + private `toRealCents`.
- `liabilitySteps.ts` — `computeLiabilityPayments`, `buildLiabilityPaymentRecords`, `applyShortfallCascade`, `advanceLiabilities`.
- `assetSteps.ts` — `applyAssetTransfers`, `compoundAssets`, `advanceProperties`.
- `allocationStep.ts` — `buildIncomeSources`, `buildInterestAccrualSources`, `allocateMonth`, `unwindUnfundedContributions`.
- `goalSteps.ts` — `fireGoalDispositions`.

**Phase B — `waterfall.ts`** (`runWaterfall` + the four phase helpers stay):
- `waterfall.types.ts` — `PlanDescriptor`, `IncomeSourceMonth`, `SharedContributionScheme`, `SurplusDestination`, `WaterfallInput`, `WaterfallResult` (re-exported from `waterfall.ts`).
- `waterfallInvariants.ts` — `assertTaxAttributionReconciles`, `assertPersonTaxBreakdownReconciles` (re-exported; `waterfall.test.ts` re-pointed to import them directly).
- `taxAttribution.ts` — `attributeTaxToSources`, `addCategory`, `TaxableByCategory`, `SourceTaxable`.

**Phase C — `rules/federalTax.ts`** (the core bracket math stays):
- `federalTaxTables.ts` — base-year constants, brackets, SS thresholds/shares, LTCG rates, indexing knobs, `indexForward`, `federalTaxTables`, `OrdinaryBracket`/`FederalTaxTables`, `FEDERAL_TAX_ASSUMPTIONS`.
- `federalTaxAttribution.ts` — `apportionByWeight`, `attributeFederalTax`, `federalAnnualTaxByCategoryCents`, `annualizeByCategory`, `computeFederalTaxByCategoryCents`.

**Phase D — the two biggest test files** (helpers extracted first, then partitioned by subject, one sibling file per commit):
- `simulate.testSupport.ts` + `simulate.test.ts` (base) / `simulate.liabilities.test.ts` / `simulate.allocation.test.ts` / `simulate.savingsInterest.test.ts`.
- `events.testSupport.ts` + `events.test.ts` (ledger replay/validation) / `events.mechanics.test.ts` / `events.relationships.test.ts` / `events.budgetItems.test.ts` / `events.loans.test.ts` / `events.homePurchase.test.ts`.

**Unchanged:** both package barrels (`index.ts`), all already-split subsystems
(`withdrawal`, `rmd`, `governmentBenefit`, `reportFlows`, `spendingItems`, `snapshot`), and
`waterfall.test.ts` / `withdrawal.test.ts` (left for a follow-up per Out of Scope).

## Verification & Testing

Final `npm run check` (engine-purity → typecheck → full Vitest suite), run after every one of
the 17 commits and green throughout:

```
Test Files  75 passed (75)
     Tests  900 passed | 45 todo (945)
```

- `npm run check:purity` — green (the one-way `app → rules → engine` boundary holds; all new
  engine modules import only engine internals, all new tax modules stay within `rules`).
- `npm run typecheck` — green (0 errors; every extracted import pruned to exactly what it uses).
- Public barrels diffed against `main`: **0 changes** — external importers see no difference.
- Baseline before the refactor was also 900 passed | 45 todo → coverage is byte-for-byte
  preserved.
