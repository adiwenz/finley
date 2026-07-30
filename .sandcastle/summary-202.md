# Migrate the app onto the Projection facade (both planes) and stop minting ids

## Overview

The app instantiated `Projection` in **zero** production places: it drove the low-level engine
pipeline by hand on the read path, wrote the ledger through the functional `addEvent` layer,
held `Plan` and `Ledger` as two separate React states, and minted its own ids into the engine's
namespace from seven sites. That is the two-write-paths problem: two authorities minting into
one scenario, safe only because they never acted on the same scenario at once.

This change collapses all of that into one atomic migration. React now holds a single immutable
`ProjectionState`. Reads go through one `Projection` handle (`run` + `funding`) rebuilt per state
change; every write builds a momentary handle, mutates it, and discards it — funnelled through a
single `useProjection` hook that owns the transaction discipline. No app file mints an id: the
facade's shared counter is the sole authority, and it is floored past whatever a state already
carries on the way into every write.

## RGR Verification Details

**Engine (RED → GREEN).** Added two tests to `projectionRoot.test.ts`:

- *"derives the mortgage liability id parent-suffixed from the property id"* — RED: `buyHome`
  minted `mortgage-home-1`; asserted `home-1-mortgage`. GREEN: flipped the derivation in
  `buyHome` to `` `${id}-mortgage` ``.
- *"answers the funding question from the current ledger's liquid balances"* — RED: `funding()`
  did not exist (compile failure). GREEN: added `Projection.funding()`, reusing the handle's own
  `baseConfig()` and validation jurisdiction so the picker and the §4.5 gate decide on the same
  numbers.

**App.** The migration is inherently atomic (read path, write path, state model, and id minting
cannot be separated), so the existing behavioral suite is the executable spec. `mainState.test`'s
14 integration tests — add/remove events, cross-plane partner-job edits, preset loads, the
loan-payment spend band, budget edits — all pass unchanged in intent, which is the "no behavior
change other than the id scheme" guarantee. The three memoization spies that watched the
now-encapsulated `createProjectionBase` were repointed to `Projection.fromState` (the app's
reprojection entry point, which `transact` also routes through) — the only observable left once
the base build moved inside the facade.

Unit tests for the changed seams were moved to the new shapes: the event sub-forms now assert the
**facade input** they hand `takeLoan` / `separate` / `haveChild` / `marry` / `buyHome` (via a
stub `Projection`), not a hand-built `NewLifeEvent`; `goalsView`'s `addGoal`/`freshGoalId` blocks
were removed (that behavior is now `Projection.addGoal`, covered in the engine).

## Key Decisions & Why

- **One `ProjectionState`, momentary handles.** A held mutable `Projection` is `Object.is`-equal
  to itself, so `useState` would bail out and re-render nothing; forcing it with a version counter
  makes React's state a lie and invalidates every memo on any write. React holds the plain value;
  writes pick up a handle, mutate, and drop it.
- **`useProjection` owns the discipline.** `transact` wraps one facade write and turns a refused
  write (the facade throws) into the `conflict` message; `reviseEvents` runs an all-or-nothing
  ledger revision and reports acceptance *synchronously* (off a ref) so a cross-plane job write
  can skip the plan side on a refusal; `setBudget` reshapes the plan through the domain transforms
  directly (they mint nothing), carrying the ledger reference through so plan-only edits leave
  ledger-keyed memos able to skip.
- **The counter is floored on the way in, not in `setBudget`.** Every facade write builds through
  `fromState`, which floors the counter past every id the scenario already holds — including
  primary jobs the app still mints via `nextJobIdFor`. So the engine steps over an app-minted
  `job-N` before its next mint regardless, closing the collision the single-scenario model would
  otherwise open, without re-flooring on every keystroke.
- **`funding()` on the facade.** The home-purchase picker needs a `FundingLookup`, which needed a
  `base` from the now-banned `createProjectionBase`. Exposing it on the handle — reusing the same
  `baseConfig` and validation jurisdiction the affordability gate uses — keeps the picker and the
  gate from ever telling the user different stories.
- **Preset loading via `fromScenario`, structural stamping.** A preset's authored events are
  stamped in order into a ledger (identical to replaying through `addEvent` for a valid preset,
  which every preset is verified to be in `presets.test.ts`) and loaded through `fromScenario`,
  which floors both counters. This keeps `createProjectionBase` out of production without
  rewriting the preset seed data (its literal ids are #194's job).
- **Derived ids parent-suffixed.** `mortgage-home-3` → `home-3-mortgage`, matching the existing
  `p-3-job-1` convention so a sort groups derived ids under their parent. (Partner-job ids are
  now minted by `marry` as `job-N`, so the app-side `${partnerId}-job-N` scheme is moot.)
- **Job authoring left as-is, deliberately.** The issue's minter list names exactly `nextId`,
  `freshGoalId`, and `nextLineId`; `nextJobIdFor` is not on it. Its `job-N` shape is recognized by
  the counter's floor, and the two-plane job write is out of this issue's scope.

## Changes Made

**Engine**

- `projectionRoot.ts`: `buyHome` derives `` `${id}-mortgage` ``; added `funding(): FundingLookup`.
- `projectionRoot.test.ts`: mortgage-id and `funding()` tests.

**App — state model & hook**

- `hooks/useProjection.ts` (new): the single authoring hook — `state`, `conflict`, `setBudget`,
  `transact`, `reviseEvents`, `removeEvent`, `loadState`. Replaces `useLedger.ts` (deleted).
- `main.tsx`: holds one `ProjectionState`; reads via a `Projection` memo (`run` + `funding`) keyed
  on `state`; preset load via `presetState` + `loadState`; wires `onAddGoal` / `onAddLine` /
  `onAdd` through `transact`. The five low-level pipeline calls are gone.

**App — creation through the facade**

- `goalsView.ts`: removed `addGoal` and `freshGoalId`.
- `baseAdjustments/budgetLines.ts`: removed `nextLineId` and `addLineFromDraft`; added
  `budgetLineInputFromDraft`; `updateLineFromDraft` patches via a shared `lineBody`.
- `goalsPanel.tsx` / `baseAdjustmentsPanel.tsx`: `add` routes through new `onAddGoal` / `onAddLine`
  props; edit/reorder/delete still call the domain transforms directly.

**App — no id minting in forms**

- `addEventForm/formControls.tsx`: `FormProps` drops `nextId`; `onAdd` is now
  `(write: (p: Projection) => void) => void`.
- `childForm` / `loanForm` / `homePurchaseForm` / `relationshipForm` / `separationForm`: submit by
  calling the matching facade method (`haveChild` / `takeLoan` / `buyHome` / `marry` / `separate`);
  `addEventForm.tsx` drops `nextId`.
- `planPeople.ts`: added `jobInputFromDraft` (a `JobInput` for `marry`, no id/owner).

**App — preset & wiring**

- `presets.ts`: added `presetState(preset): ProjectionState` (facade-based); `buildPresetLedger`
  retained for the `presets.test` oracle.
- `jobWrites.ts` / `jobsPanel.tsx` / `baseAdjustmentsPanel.tsx`: `EventRevision` now imported from
  `useProjection`.

**Tests** updated to the new seams: `mainState`, `subForms`, `relationshipForm`,
`fundingSourcePicker`, `homePurchaseForm`, `goalsView`, `goalsPanel`, `goalsDelete`,
`baseAdjustmentsPanel`, `jobsPanel`.

## Verification & Testing

- `npm run typecheck` — clean.
- `npm run check:purity` — engine purity holds.
- `npx vitest run` — **1088 passed | 45 todo (86 files)**; engine 623, app 382.
