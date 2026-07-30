# Issue 194 — ScenarioInput: a declarative, ID-free authoring entry point for the engine

## Overview

The engine now has a declarative, **ID-free** authoring entry point: one JSON-shaped
`ScenarioInput` value describing a whole scenario — plan *and* timeline — which
`Projection.fromInput(input, jurisdiction)` consumes, minting every id internally off the shared
counter. This closes "the engine owns identity": no caller — app, test, or seed fixture — writes
an id to describe a scenario. `PLAN_DEFAULTS` and every preset are now authored this way, and the
old two-authorities arrangement (hand-written `job-1`/`emergency`/`home`/`e0`/`loan-student`
strings a regex floor had to recognise after the fact) is gone.

The work landed across six tasks on `sandcastle/issue-194`:

1. **Declare the input types** (`scenarioInput.ts`) — `ScenarioInput`, the `JobEntry`/`GoalEntry`/
   `BudgetLineEntry` plan-plane entries, and `EventEntry`, a discriminated union over `type` with
   an exhaustiveness check (`eventEntryType`). `Ref` is a build-time-only name distinct from an id.
2. **Resolve refs** (`scenarioRefs.ts`) — standalone validation over a `ScenarioInput`: duplicate,
   unresolvable and forward refs are refused; well-known refs (`PRIMARY_PERSON_ID`, the standing
   accounts, the synthetic card) resolve to themselves; a goal ref binds to its derived fund
   account.
3. **Build `fromInput`** (`projectionRoot.ts`) — apply the plan plane (goals → jobs → budget
   lines) then month-sorted events, each through the matching authoring method so its write-time
   gate fires; all-or-nothing, returning `{ ok: false, error }` naming the offending entry.
4. **Re-prefix the goal fund account** — `goalFundAccountId(goal)` became `` `fund-${goal.id}` ``
   so a minted `goal-N` yields `fund-goal-N` rather than colliding shapes.
5. **Convert `PLAN_DEFAULTS`** — built from a `DEFAULT_INPUT` `ScenarioInput` through `fromInput`;
   its job and goals carry minted ids. Budget lines keep their stable label-keys.
6. **Convert the presets and delete `buildPresetLedger`** (this task) — see below.

## Task 6 — what changed

Each preset is now a single `ScenarioInput` value built through `fromInput`, replacing both halves
of what a preset used to do: a hand-built `Plan` with literal ids, and a seed timeline replayed
through the `buildPresetLedger` test helper (and `presetState`'s `resetLedger` loop). Both are
gone.

- **`presets.ts`** — `Preset` now carries `input: ScenarioInput` instead of `plan`/`events`. The
  four teaching scenarios inherit `DEFAULT_INPUT`'s scalars, drop the goals, and author their own
  jobs, budgets and (for `student-loan`) the seed loan. The healthy default preset reuses
  `DEFAULT_INPUT` + `PLAN_DEFAULTS`'s budget lines re-declared as entries, so it reproduces
  `PLAN_DEFAULTS` rather than becoming a second source of truth for it. `presetState` is now one
  `Projection.fromInput(...)` under `usJurisdiction`; a refusal throws (a preset-authoring bug).
- **The `id?` override** — the deliberate exception the issue calls for. Entries may pin their
  minted id: `BudgetLineEntry` and `EventEntryCommon` gained an optional `id`, threaded through
  `fromInput` to each authoring method's existing `id?` override. Presets pin only where a stable
  key is load-bearing: budget label-keys (`housing`, …), and the student loan's `loan-student`
  liability id, which the net-worth and per-line spending charts key their series on. Job, goal
  and event ids are all minted.
- **`planDefaults.ts`** — `DEFAULT_INPUT` is now exported so presets reuse it without duplicating
  the default plan's scalars.

## RGR Verification Details

- **Engine `id?` override (RED → GREEN).** Added a `fromInput` test asserting a `takeLoan` entry
  carrying `id: "loan-student"` yields a liability with that exact id while a job carrying no `id`
  still mints (`^job-\d+$`). RED: the loan minted `loan-2`. GREEN: added `id?` to
  `BudgetLineEntry`/`EventEntryCommon` and threaded it through each event authoring call in
  `fromInput`. (A budget entry's `id` already flowed through `addBudgetLine`.)
- **Preset conversion (RED → GREEN).** Added a `presets.test.ts` case asserting the student-loan
  preset's seed loan is authored through `fromInput`: its event id equals the pinned liability id
  `loan-student`, replacing the old hand-stamped `e0`. RED: event id was `e0`. GREEN: converted
  the presets, and rewrote the test harness (`projectionOf`/`planOf`/`project`) to build through
  `fromInput` instead of the deleted `buildPresetLedger`. Every pre-existing behavioural assertion
  (each preset's financial *shape*, the two-graphs-are-one-quantity invariant, panel/graph
  agreement) stayed green, and the App-rendered `debt:loan-student` band test in `mainState`
  confirms the pinned id reaches the real chart.

## Key Decisions & Why

- **`id?` is a pin, not a ref.** Unlike a `ref` (build-time only, never in `Plan`/`Ledger`), a
  pinned `id` overrides what the engine would mint and *does* land in state. It exists for
  fixtures that must keep a stable key across edits. A pin of minted shape (`job-3`) would still
  advance the floor, so fixtures pin non-minted-shaped names (`loan-student`, `housing`) — leaving
  the counter the sole authority for real minting.
- **The default preset reproduces `PLAN_DEFAULTS`, it does not re-author it.** Reusing the exported
  `DEFAULT_INPUT` plus that plan's budget lines keeps one source of truth for the healthy default;
  a test asserts `planOf(PRESETS[0])` deep-equals `PLAN_DEFAULTS`.
- **Budget lines keep label-keys** (task 5's convention) via `id?` pins rather than minted
  `line-N`, because the app's whole expense-editing surface — chart series, dated overrides,
  `allocations()` — keys on them.

## Changes Made

- `packages/engine/src/scenarioInput.ts` — `id?` on `BudgetLineEntry` and `EventEntryCommon`, with
  module-doc rationale for the pin escape hatch.
- `packages/engine/src/projectionRoot.ts` — `fromInput` threads `entry.id` into each event
  authoring call (`marry`, `haveChild`, `takeLoan`, `buyHome`, `separate`, `payOffDebt`).
- `packages/engine/src/fromInput.test.ts` — added the `id?`-pin test.
- `packages/app/src/presets.ts` — presets are `ScenarioInput` values; `Preset.input` replaces
  `plan`/`events`; `presetState` builds through `fromInput`.
- `packages/app/src/planDefaults.ts` — export `DEFAULT_INPUT`.
- `packages/app/src/presets.test.ts` — deleted `buildPresetLedger`; harness builds through
  `fromInput`; added the seed-loan authoring test.
- `packages/app/src/mainState.test.tsx` — reads the student-loan plan via `presetState` rather than
  the removed `Preset.plan`.

## Verification & Testing

- `npm run check:purity` — engine purity guard passes.
- `npm run typecheck` — clean.
- `npm run test` — **1175 tests green** (45 todo) across 90 files, including the engine
  `fromInput`/`scenarioInput`/`scenarioRefs` suites, the app `presets` and `mainState`
  integration suites, and the `planWrites.guard` facade-surface scan.
