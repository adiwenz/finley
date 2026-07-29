# Issue #182 — What the app can do that the Projection API cannot

## Overview

`Projection` (`packages/engine/src/projectionRoot.ts`) is the published high-level API of
`@finley/engine`, but it is *append-only authoring*: before this change it could `addGoal`
(appends at lowest priority) and `removeGoal`, yet had no way to **edit** a goal or **reorder**
one. The app, meanwhile, edits goals freely through `goalsView.updateGoal` / `reorderGoal`.

The issue is a map of every such divergence and singles one out as the sharpest:

> Goal **priority** is the sharpest of these: priority is a goal's index in `Plan.goals`, and
> `addGoal` appends, so an API caller can only ever author goals in lowest-priority order and
> has no way to reorder them afterwards.

This change closes the goal-editing gaps in the Projection API — the sharpest call-out plus its
natural companion — bringing the API to parity with the app for the cohesive goals surface that
#181 (`addGoal`/`removeGoal`) already started. `Projection` now exposes:

- **`updateGoal(id, patch)`** — replace a subset of a goal's authorable fields, keeping its
  `id` (and thus its `goal-<id>` fund account) and its list position, so priority is untouched.
- **`reorderGoal(id, "up" | "down")`** — move a goal one slot earlier or later in the funding
  order; the only reprioritization primitive, since priority is array index.

Scope was held to goals deliberately: the issue is explicitly *"a map of known gaps, not a
backlog — nothing here is a defect on its own"*, and the remaining rows (jobs, budget-line
edits, event lifecycle, `removeTransaction`) are separate surfaces left as documented gaps.

## RGR Verification Details

Two red → green cycles, each a single failing test first, in
`packages/engine/src/projectionRoot.test.ts`.

1. **`updateGoal`** — new describe block "editing a goal keeps its id and priority".
   - RED: `TypeError: p.updateGoal is not a function`.
   - GREEN: added `updateGoal(id, patch: Partial<GoalInput>)` — a map that spreads the patch
     onto the matching goal, drops any `id` in the patch so the stable id cannot be overwritten,
     and no-ops on an unknown id. Three tests: patch-only-named-fields, position/priority held,
     unknown-id no-op.
2. **`reorderGoal`** — new describe block "reordering a goal changes its funding priority".
   - RED: assertion failure on `p.reorderGoal is not a function`.
   - GREEN: added `reorderGoal(id, direction)` mirroring the app's `goalsView.reorderGoal`
     (one-slot swap, no-op at the ends and for an unknown id). Three tests: up, down, and the
     no-op boundaries.

Full file: 28 tests green (was 22).

## Key Decisions & Why

- **Patch, not whole draft.** The app's `updateGoal` takes a full `GoalDraft` (form-shaped
  replace). The API instead takes `Partial<GoalInput>`: a programmatic caller names only what
  changes, and this subsumes the app's separate `setGoalRate`. The `id` is stripped from the
  patch before the spread so an edit can never re-point a goal's stable id / fund account.
- **No guard on `updateGoal`.** `removeGoal` is guarded because dropping a goal drops its
  `goal-<id>` fund account, which an event may still reference (the #181 rule). Editing keeps
  the id, so the account id is stable and no funding reference can dangle — no guard needed, and
  the docstring says so.
- **Inline, matching the file.** Both methods route through the existing `commitPlan` primitive
  (carries the ledger through untouched) and are written inline like `addGoal`/`removeGoal`
  rather than importing the app's pure helpers — `Projection` lives in the engine and imports no
  app code, and reorder/update are trivial array ops, not shared *rules* that could drift.
- **`reorderGoal` shape mirrors the app.** Up/down one slot matches `goalsView.reorderGoal` and
  the issue's own reference to it, keeping the two surfaces conceptually aligned.
- **Held scope to goals.** Deliberately did not add job/budget-line edits, event revise/remove,
  or `removeTransaction(id)`; the issue frames those as a map, not a work list.

## Changes Made

- `packages/engine/src/projectionRoot.ts`
  - Added `updateGoal(id: string, patch: Partial<GoalInput>): void` — patch a goal's authorable
    fields, keeping id, fund account, and list position.
  - Added `reorderGoal(id: string, direction: "up" | "down"): void` — move a goal one slot in
    the funding order; no-op at the ends and for an unknown id.
- `packages/engine/src/projectionRoot.test.ts`
  - New describe block covering `updateGoal` (patch, priority-held, unknown-id no-op).
  - New describe block covering `reorderGoal` (up, down, boundary no-ops).

## Verification & Testing

- `npm run check:purity` → engine purity passed (no I/O, no app/rules imports).
- `npm run typecheck` → clean.
- `npm run test` → **1022 passed | 45 todo (1067)**, 85 files. `projectionRoot.test.ts`: 28
  passed (up from 22).

## Notes for the next iteration

The remaining rows in the issue's map are untouched and still real: job edit/remove, pay-change
and income-override authoring, deferral/monthly-income setters, budget-line edit/remove, the
~15 free plan scalars the budget editor patches vs. the one `setRetirementTarget`, the
unauthored `ChildEvent` / `SeparationEvent` / `BudgetItemStartEvent` transactions, and the
event lifecycle (`removeTransaction(id)` — still named as future work in the class comment —
plus revise/replace). Each remains a place where an app-side rule would need mirroring until the
larger "state root vs. separate surface" decision the issue closes on is made.
