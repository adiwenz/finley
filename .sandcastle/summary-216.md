# Issue #216 — Narrow the `@finley/engine` surface to the Projection facade

## Overview

`packages/engine/src/index.ts` was a wide barrel re-exporting ~40 internal modules — the
simulator, the ledger, the waterfall, the snapshot/report pipeline, and the authoring transforms —
most with no importer. The engine is open-core: its only public surface should be the `Projection`
facade, plus the types a consumer names and the `Jurisdiction` seam the `rules` package implements
against.

Three commits, each a distinct move:

1. **Narrow the surface.** Collapse the barrel to a single curated module (104 exported symbols),
   ratchet it shut with a guard test, and move every app/rules test and the shared test helpers
   onto the public API so no test reaches past the facade.
2. **Split the facade from its state transformations.** `projectionRoot.ts` had grown to 2229
   lines holding both the public surface and every domain rule. Extract the rules into
   `authoring/*` as plain functions of `ProjectionState`, leaving `Projection`'s methods as
   delegators.
3. **Make `index.ts` the export map.** Delete the pass-through that was left over, and move the
   last two implementations (`run()`, `retirement()`) out of the facade.

The published surface is the same 104 names throughout — the branch changes where things live,
never what a consumer can name.

## RGR Verification Details

- **RED:** Added `packages/engine/src/index.guard.test.ts`, which reads `index.ts` as source text
  (comments stripped) and constrains its shape. Against the wide barrel it failed on every
  assertion — dozens of extra export statements and module specifiers.
- **GREEN:** Narrowed the surface, migrated every test off the removed internals, then extracted
  the implementation in two further passes. The guard test, the app-side
  `planWrites.guard.test.ts`, and the whole suite went green together at each step.
- **Verification:** `npm run check` (purity → typecheck → all tests) passes: **95 test files, 1240
  tests green, 45 todo, 0 failures**; engine purity clean; all four guard tests pass.

## Key Decisions & Why

### The surface

- **`index.ts` is the export map, and only a map.** Every line re-exports a name from the module
  that *defines* it — `Projection` from the facade, each authoring input from the module that
  applies it, each artifact from the function that builds it. There is no intermediate barrel to
  keep in step, and reading a line tells you where the thing lives. Widening the surface is an
  edit to this one file, with a justification beside it.
- **Named re-exports only, never `export *`.** Three guard tests read the surface as *text*:
  `index.guard.test.ts` constrains its shape, `planWrites.guard.test.ts` decides what the app may
  name, and `authoringInputs.guard.test.ts` finds every published input. A wildcard would blind
  all three at once and widen the surface silently.
- **The 12 jurisdiction seam types are public.** The `rules` package implements `Jurisdiction`
  against this engine, so every context and param type its methods name is part of the contract
  (`RmdContext`, `DeferralLimitContext`, `GovernmentBenefitContext`, `HealthCostContext`,
  `GovernmentBenefitClaim`, `WithdrawalTaxBasis`, `ReturnTaxTreatment`, `TaxCategory`,
  `ModelAssumption`, `AccountReturnKind`, `EarningsRecord`, `JurisdictionContext`) — a rule
  implementation cannot type its arguments otherwise. `nullJurisdiction` is a value on the surface
  so the engine runs standalone.
- **Nothing that writes is published, and nothing that writes may be added.** The entity
  transforms (`withPayChange`, `addEvent`, …) and the projection-level state functions
  (`addProjectionJob`, `applyMarriage`, …) stay internal — an app that could import one would have
  a second write path around the id counter, the goal-funding guard and the affordability gate.
  Both guard tests assert the list directly, so the rule cannot be satisfied by a map that quietly
  re-exports one.

### The split

- **Domain rules are plain functions of state, not methods.** Each takes a `ProjectionState` and
  returns the next one (plus a minted id, where there is one). The module that knows a domain owns
  its rules without owning the handle, so `Projection` never learns them.
- **`authoring/jobs.ts` owns the two-plane knowledge.** A household member's jobs live on one of
  two planes — the primary person's are standing `Plan.jobs` data, a partner's ride the
  `RelationshipEvent` that brought them in — and which one is a fact about the *member*, not the
  edit. One counter issues job ids across both, so a bare id names one job in the household or
  nothing, and `editJobAnywhere` resolves the plane. Nothing outside the module needs the
  distinction.
- **`reassignJob` became atomic.** It was two sequential commits; a throw on the second left a
  partial write on a handle callers were told to discard. As a pure derivation there is one value
  and it is never handed back — a strengthening of the documented contract, covered by a test.
- **Extraction split by concern, not by size:** `state` (the shape, its format version, the shared
  derivations), `mint` (one counter, both flooring shapes), `eventWrite` (the gated ledger
  primitives), `restore` (the three entry gates, in the one order that gives a usable answer),
  `revise`, `fromInput`, and one module per authored thing.
- **`fromInput` drives the public methods.** `authoring/fromInput.ts` type-imports `Projection`
  and takes an `open` callback, so each entry lands through the same write-time gate a live edit
  does — and the import cycle stays type-only.

### The facade

- **`Projection` owns exactly one thing:** the mutable `current`, and the discipline of only ever
  replacing it with a state a plain function derived. `write()` is that discipline, and it floors
  the id counter on adoption rather than inside each write, so a new authoring path cannot be
  added that forgets to.
- **Every method body is one line** except `write()` and `transact()`. The methods stay because a
  facade is the point — a caller holds one object, not a toolkit of state functions it has to
  sequence correctly. The bodies are one line because that is the only way the facade stays a
  *surface* rather than becoming the implementation again.
- **`run()` and `retirement()` were pure functions wearing a `this`.** They now live in
  `projectionRun.ts` and `retirementOutlook.ts`, each declaring the artifact it builds beside the
  function that builds it, so a caller holding state alone can project without constructing a
  handle first.
- **`projectionFunding` sits beside the writes, not the reads.** It must be built from the same
  replay context and validation jurisdiction the affordability gate decides on, or an authoring
  picker and the down-payment gate would tell the user different stories. Sharing
  `projectionBaseFor` makes that impossible rather than merely unlikely.

### The tests

- **Tests observe through the public API.** App tests build via `Projection.fromInput`/`fromState`,
  author via the typed facade methods, and read via `run()` / `retirement()` / `funding()` /
  `accountDescriptors()` — never a simulator, ledger, or transform internal. Engine-internal tests
  import each internal from its defining module.
- **Rules tests exercise the interface, not the simulator.** Where a `rules` test drove a full
  household simulation to observe an effect the engine already covers, that white-box duplication
  was dropped in favour of direct `Jurisdiction`-method contract assertions using the public
  context types.
- **One irreducible white-box gap** — a cent-exact withdrawal gross-up under the *real*
  jurisdiction, which the facade exposes no primitive for — is documented with a `TODO(facade):`
  note in `retirementView.test.ts` rather than silently dropped; the same arithmetic is covered
  engine-side in `projection/withdrawal.test.ts`.

## Changes Made

**Engine surface**

- `packages/engine/src/index.ts` — the curated export map: 104 named re-exports, each from the
  module that defines the symbol.
- `packages/engine/src/projectionRoot.ts` — **deleted.** It was a pass-through between `index.ts`
  and the defining modules; two files in the path of every widening, and the second one's only job
  was forwarding.
- `packages/engine/src/index.guard.test.ts` — the surface ratchet: the map declares nothing, uses
  no `export *`, maps only to modules that exist and are not themselves pass-throughs, and
  publishes nothing that writes.

**Engine implementation**

- `packages/engine/src/projectionFacade.ts` — the `Projection` class, and nothing else.
- `packages/engine/src/authoring/` — `state`, `mint`, `eventWrite`, `restore`, `jobs`,
  `budgetLines`, `goals`, `planScalars`, `relationships`, `housing`, `liabilities`, `revise`,
  `fromInput`.
- `packages/engine/src/projectionRun.ts` — `ProjectionResult` + `runProjection`.
- `packages/engine/src/retirementOutlook.ts` — `RetirementOutlook` + `buildRetirementOutlook`.
- `packages/engine/src/authoring/jobs.test.ts`, `authoring/mint.test.ts` — new; what only the
  extracted shape can state (the plane knowledge lives in the module, each write is a pure
  derivation, a refusal derives nothing).
- `packages/engine/src/projectionRoot.test.ts` → `projectionFacade.test.ts`, after the module it
  exercises.

**Consumers and tests**

- `packages/app/src/planWrites.guard.test.ts` — reads `index.ts` as the surface; the
  must-stay-internal list gained the projection-level state functions.
- `packages/engine/src/authoringInputs.guard.test.ts` — the source scan was widened from two fixed
  files to the whole package, with a precision filter (declared in the authoring vocabulary, OR
  published by the map) so simulator internals that legitimately carry an `id` are not dragged in.
- `packages/app/src/testing/projectionHarness.tsx`, `testing/planFixtures.ts` — route through the
  public API instead of engine internals.
- 14 app test files + 2 rules test files — migrated onto the public API / `Jurisdiction` interface.
- 15 engine test files + `events.testSupport.ts` — internal imports repointed to defining modules.
- `playground.ts`, `repl.ts` — moved off the removed `emptyLedger` export.
- `docs/projection-blocking-design.md` — two references to the deleted module repointed.

## Verification & Testing

- `npm run check` green: engine purity clean, `tsc --noEmit` clean, **1240 tests passing** (45
  todo) across **95 test files**, 0 failures.
- The published surface was compared mechanically against the pre-branch set: **104 names in, 104
  out, none added, none removed**; 19 value exports, and a runtime check confirms no write or
  state function leaked.
- All four guard tests pass: the surface is held to a curated map, the app is held to that
  surface, no authoring input accepts a caller-supplied id, and no comment references an issue or
  PR number.
