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
   an exhaustiveness check (`eventEntryType`). `Ref` is a BRANDED, build-time-only name, distinct
   from an id at compile time and built with `ref()`.
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
   its job, goals AND budget lines all carry minted ids.
6. **Convert the presets and delete `buildPresetLedger`** (this task) — see below.

## Task 6 — what changed

Each preset is now a single `ScenarioInput` value built through `fromInput`, replacing both halves
of what a preset used to do: a hand-built `Plan` with literal ids, and a seed timeline replayed
through the `buildPresetLedger` test helper (and `presetState`'s `resetLedger` loop). Both are
gone.

- **`presets.ts`** — `Preset` now carries `input: ScenarioInput` instead of `plan`/`events`. The
  three teaching scenarios (`paycheck-to-paycheck`, `living-on-credit`, `student-loan`) inherit
  `DEFAULT_INPUT`'s scalars, drop the goals, trim health, and author their own jobs, budgets and
  (for `student-loan`) the seed loan. `taxed-in-retirement` is NOT one of them: it keeps the
  default household's goals and health and varies only job, budget, return and life expectancy.
  The healthy default preset IS `DEFAULT_INPUT`, so it reproduces `PLAN_DEFAULTS` exactly.
  `presetState` is one `Projection.fromInput(...)` under `usJurisdiction`; a refusal throws (a
  preset-authoring bug).
- **No entry may name an id.** `ScenarioInput` is an authoring API: refs connect entries while a
  document is applied, and `Projection`'s own authoring methods mint every durable id off the
  shared counter. Restoring state whose ids already exist is `Projection.fromState`'s job.
- **Every authoring input lost its `id?`** — `JobInput`, `BudgetLineInput`, `GoalInput` and all
  six event inputs — so no caller anywhere can name a durable id, and `mint` no longer has an
  override branch at all. The one operation that legitimately needs an
  already-issued job id — moving a job between household members, which must keep its overrides,
  pay changes and employer match — became `Projection.reassignJob(jobId, toOwnerId, job)`: it
  takes the id as an argument and performs the two-plane move itself, so authoring a job and
  relocating one are different verbs.
- **`planDefaults.ts`** — `DEFAULT_INPUT` is exported (so presets reuse it) and now carries the
  Base budget lines as entries, so `PLAN_DEFAULTS` is the built plan wholesale rather than a
  built plan with budget lines layered on afterwards.

## RGR Verification Details

- **Preset conversion (RED → GREEN).** Added a `presets.test.ts` case asserting the student-loan
  preset's seed loan is authored through `fromInput` and that both its ids are minted
  (`^loan-\d+$`), the event and its liability sharing one. RED: the event id was the hand-stamped
  `e0`. GREEN: converted the presets, and rewrote the test harness
  (`projectionOf`/`planOf`/`project`) to build through `fromInput` instead of the deleted
  `buildPresetLedger`. Every pre-existing behavioural assertion (each preset's financial *shape*,
  the two-graphs-are-one-quantity invariant, panel/graph agreement) stayed green.
- **Allocator regression tests.** `fromInput.test.ts` pins that every id comes off the counter in
  the shape `mint` issues, that ids are unique and never one the engine already holds
  (`WELL_KNOWN_REF_IDS`), that the counter is left clear so later authored writes cannot collide,
  that a `fromState` round trip changes no id, and that no ref survives anywhere in the
  serialized state.

## Key Decisions & Why

- **Authoring and import are different APIs.** `fromInput` describes a scenario for the first time
  and mints; `fromState` restores state whose ids were issued earlier and floors the counter past
  them. Collapsing the two — letting an input carry ids — is what gives identity two authorities,
  so `ScenarioInput` has no `id` field anywhere.
- **`Ref` is branded.** `string & { [REF_BRAND]: true }`, built with `ref(name)`. The distinction
  from an id is now enforced by the compiler rather than asserted in a comment: an id read off a
  live `Plan` will not type-check in a ref position. The five names that address something the
  engine provides are exported pre-branded (`PRIMARY_PERSON_REF`, …) so fixtures reach for a
  constant instead of wrapping a raw id.
- **The default preset reproduces `PLAN_DEFAULTS`, it does not re-author it.** It IS
  `DEFAULT_INPUT`; a test asserts `planOf(PRESETS[0])` deep-equals `PLAN_DEFAULTS`.
- **Budget line ids are minted (`line-N`), not label-keys.** The app's expense surface keys on
  whatever the engine issued, read back off the built plan — no surface and no test may assume a
  line's id spells its label.

## Changes Made

- `packages/engine/src/scenarioInput.ts` — branded `Ref` + the `ref()` constructor; no `id` field
  on any entry.
- `packages/engine/src/scenarioRefs.ts` — pre-branded `PRIMARY_PERSON_REF`/`SAVINGS_REF`/
  `RETIREMENT_REF`/`BROKERAGE_REF`/`SYNTHETIC_CARD_REF` beside `WELL_KNOWN_REF_IDS`.
- `packages/engine/src/projectionRoot.ts` — `fromInput` passes no id to any authoring call; the
  ref registry is local to the call. `JobInput`/`BudgetLineInput` drop `id?`; `reassignJob`
  replaces the caller-sequenced job move and `assertJobIdFree` goes with it. Facade re-exports the
  entry types, `ref` and the well-known refs. `mint(state, kind)` always mints; `mintedNumber`
  survives for `seqFloor`, which is now the only thing that has to recognize an id it did not
  issue (one arriving by import or on a revised event).
- `packages/app/src/jobEditing.ts`, `jobWrites.ts` — a cross-member move is one `reassign` write
  instead of an id-carrying `add` plus a `remove`, so the app no longer orders the two halves.
- `packages/app/src/components/baseAdjustments/budgetTemplate.ts` — the template and the 50/30/20
  seeds name no ids; the label key `toBudgetLines` applies is a local placeholder for the
  rebalance math, stripped before a seed reaches `addBudgetLine`.
- `packages/engine/src/fromInput.test.ts` — the allocator/collision/round-trip/no-persisted-ref
  suite.
- `packages/app/src/presets.ts` — presets are `ScenarioInput` values, id-free; `taxed-in-retirement`
  restored to the default household's goals and $700/$500 health.
- `packages/app/src/planDefaults.ts` — export `DEFAULT_INPUT`, budget lines included; `PLAN_DEFAULTS`
  is the built plan wholesale.
- `packages/app/src/presets.test.ts` — harness builds through `fromInput`; seed-loan minting test;
  a focused `taxed-in-retirement` equivalence suite over its authored goals and health values.
- `packages/app/src/mainState.test.tsx`, `baseAdjustmentsPanel.test.tsx` — chart series keys and
  budget lines are looked up by label off the built state, never by an assumed id.

## Verification & Testing

- `npm run check:purity` — engine purity guard passes.
- `npm run typecheck` — clean.
- `npm run test` — **1183 tests green** (45 todo) across 90 files, including the engine
  `fromInput`/`scenarioInput`/`scenarioRefs` suites, the app `presets` and `mainState`
  integration suites, and the `planWrites.guard` facade-surface scan.
