# Issue 201 — Engine prep for the facade migration

## Overview

Engine-only groundwork so the app migration can be one reviewable change rather than a
signature churn plus a behaviour change. Four independently-testable pieces landed on the
`Projection` root in `@finley/engine`:

1. **`run()` now surfaces the `Household` and the `SimulationReport`** beside the series — from
   a *single* simulation pass, preserving the property the app relies on (the debug report
   reuses the very series the chart draws, never a second run).
2. **`Projection.transact(state, jurisdiction, fn)`** — the transaction wrapper the app needs so
   it can hold a plain `ProjectionState` and build a momentary handle per write. Returns
   `{ state, result }`, so the id-returning methods keep handing their id straight back.
3. **`fromState` / `toState`** are now the primary round-trip names (the old `fromJSON` static is
   renamed to `fromState`); **`toJSON()` is kept as an alias** because it is the JS protocol name
   `JSON.stringify` invokes automatically.
4. **`Projection.fromScenario(scenario, startYear, jurisdiction)`** — the import counterpart that
   carries a pre-built timeline and floors the counter past it. **`create` now collapses to
   `fromScenario(scenarioOf(plan), startYear, jurisdiction)`**, so every construction path runs
   through the one flooring normalization.

No app consumer changes here — that is the follow-up migration.

## RGR Verification Details

Worked in four vertical slices, each red before green:

- **Slice 1 — `run()` output.** RED: a new test asserted `result.household.memberships` and
  `result.report` — failed with `Cannot read properties of undefined (reading 'memberships')`.
  GREEN: added `projectScenarioParts` to `retirementSolver` (keeps the household + sim input the
  pipeline already builds on the way to the series) and had `run()` summarize the report off that
  same series.
- **Slice 2 — `transact`.** RED: `Projection.transact is not a function`. GREEN: static wrapper
  over `fromState` returning `{ state, result }`.
- **Slice 3 — `fromState` / `toState` / `toJSON` alias.** RED: `p.toState is not a function`.
  GREEN: renamed `toJSON`→`toState`, made `toJSON` delegate to it, renamed `fromJSON`→`fromState`;
  updated the engine's own test references.
- **Slice 4 — `fromScenario`.** RED: `Projection.fromScenario is not a function`. GREEN: new
  static built on `withNormalizedCounters`; `create` re-expressed in terms of it.

## Key Decisions & Why

- **One simulate pass for `run()`.** Rather than re-run the simulator to answer the household and
  report questions, `projectScenarioParts` returns the `Household`, the `HouseholdSimInput`, and
  the `ProjectionSeries` that the pipeline already computes on the way to the series (they were
  simply discarded before). `run()` then calls `summarizeSimulation(simInput, series, …)` — the
  variant that takes an already-computed series — so the report is derived from the same run, not
  a second one. `projectScenario` is retained as a thin `.series` wrapper so the solver's binary
  search is untouched.
- **`run()`'s report `meta`** echoes `{ plan, jurisdictionId }`, mirroring what the app records
  today, so knobs the sim input compiles away — life expectancy, retirement age, health lines —
  survive into the debug output and download.
- **Single flooring path.** `fromScenario` (and therefore `create`) reuse the existing
  `withNormalizedCounters`, the same normalization `fromState` and `resetLedger` use. No
  "trusted vs defensive" split was introduced — `commit` re-floors after every write regardless,
  so a skip would save one walk and reopen the silent-collision hole.
- **`create` is now consistent with every other construction path.** Because the shared counter
  (`seqFloor`) floors ids *and* sequence numbers to one number, routing `create` through
  `fromScenario` means a fresh plan's empty ledger has its `nextSequenceNumber` lifted to the
  same floor. The visible consequence: after a construction, the first authored *event* takes the
  first sequence number, so the *next minted id* steps one past it (a harmless gap). This already
  held for `fromState` / `resetLedger`; old `create` was the lone special case. One incidental
  baseline assertion in an existing test (`job-1` → `job-2`) was updated to reflect the now-uniform
  behaviour — no collision, just a gap, exactly the kind a removal leaves.
- **`toJSON` kept, `fromJSON` removed.** `toJSON` is a JS protocol name (`JSON.stringify` calls
  it), so discarding it would be a real loss for persistence — it stays as an alias of `toState`.
  `fromJSON` has no such protocol justification, so it is simply renamed to `fromState`.
- **`projectScenarioParts` / `ScenarioProjection` stay out of the package barrel.** Their only
  caller is `Projection.run`, a sibling module that imports them directly from
  `./retirementSolver`, so publishing them buys nothing — and it would cost something real.
  `ScenarioProjection` names a `HouseholdSimInput`, the low-level simulator artifact this whole
  facade exists to stop handing out: `run()` consumes the sim input internally and returns the
  finished `SimulationReport` instead. Exporting the type would make that artifact part of the
  public contract and block ever withdrawing it. (`HouseholdSimInput` *is* still reachable today
  via `export * from "./projection/simulate"`, and `main.tsx` still calls
  `buildHouseholdSimInput` — retiring that block is the migration's job. The point here is that
  the new API does not *depend* on it.)

## Changes Made

- `packages/engine/src/retirementSolver.ts`
  - Added `ScenarioProjection` interface and `projectScenarioParts(scenario, ctx)`, returning the
    `household`, `simInput`, and `series` from one pass. Both are engine-internal — module-level
    exports for `Projection.run`'s sibling import, deliberately not re-exported by the barrel.
  - `projectScenario` now delegates to `projectScenarioParts(...).series`.
- `packages/engine/src/projectionRoot.ts`
  - `ProjectionResult` gains `household: Household` and `report: SimulationReport`.
  - `run()` builds both off the single pass via `projectScenarioParts` + `summarizeSimulation`.
  - New `static transact<R>(state, jurisdiction, fn) → { state, result }`.
  - New `static fromScenario(scenario, startYear, jurisdiction)`; `create` re-expressed via it.
  - `toJSON()`→`toState()` primary, `toJSON()` kept as an alias; `fromJSON()`→`fromState()`.
- `packages/engine/src/index.ts`
  - No new exports. The comment over the `retirementSolver` export block now records why
    `projectScenarioParts` is withheld, beside the existing note on why `projectScenario` and
    `planSurvives` are public.
- `packages/engine/src/projectionRoot.test.ts`
  - New tests for the `run()` output, `transact`, `fromState`/`toState`/`toJSON`, and
    `fromScenario`; `fromJSON` references renamed; one incidental id baseline updated to reflect
    the now-uniform flooring.

## Verification & Testing

- `npm run check:purity` — passed (no I/O, no app/rules imports in engine source).
- `npm run typecheck` — passed.
- `npm run test` — **1091 passed | 45 todo (1136)** across 86 files; `projectionRoot.test.ts`
  alone: **89 passed**.
- Public-surface probe: a scratch file in `packages/app/src` importing `ScenarioProjection` from
  `@finley/engine` fails typecheck with `TS2305: Module '"@finley/engine"' has no exported member
  'ScenarioProjection'`, and reflecting over the barrel shows `projectScenarioParts` absent while
  `projectScenario` remains. Withholding them broke nothing — the suite is unchanged either way.
