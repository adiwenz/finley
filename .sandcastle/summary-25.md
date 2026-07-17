# Goal authoring UI — add / edit / delete goals (Slice 5b gap) — #25

## Overview

The Goals panel (#8) could reorder priority and show each goal's on-track %, but there
was **no way to create, edit, or delete a goal in the UI** — the two seeded goals were
hardcoded in `PLAN_DEFAULTS`. This adds a direct goal-authoring surface on the
value-editing plane (§4.2 / §10.3 — a direct override, **no timeline event**), mirroring
how budget values are edited.

Three new **pure** transforms — `addGoal`, `updateGoal`, `removeGoal` — sit alongside the
existing `reorderGoal` / `setGoalRate` in `goalsView.ts`, each a `(goals, …) => GoalPlan[]`
wired through `setBudget`. A disclosed add/edit form (`GoalForm`) collects a goal's name,
target amount, type, disposition, target date (absolute month or "as soon as possible"),
and fund return, then re-runs the projection through the waterfall so every on-track %
updates live. No engine change was required — `GoalPlan` already carries the editable
fields, and the `goal-<id>` fund account falls out of `buildPlanAccounts` per remaining
goal automatically.

## RGR Verification Details

- **RED:** Added unit tests to `goalsView.test.ts` for `addGoal` / `updateGoal` /
  `removeGoal` (plus the `goalDisposal` pairing helper and the deterministic `freshGoalId`
  minter). They failed to even import: `TypeError: removeGoal is not a function`
  (12 failing / 9 passing).
- **GREEN:** Implemented the four helpers in `goalsView.ts`. The same 21 tests turned
  green with zero changes to the assertions.
- **REFACTOR:** Extracted `GoalForm` into its own file, wired add/edit/delete through the
  panel with an on-demand disclosure (§10.4), and added SSR render tests pinning the new
  controls. Full pipeline (`npm run check`) stayed green throughout.

## Key Decisions & Why

- **`GoalDraft = (GoalPlan − id) & GoalDisposal`.** The authorable shape is every
  `GoalPlan` field except its stable `id`. Crucially it keeps the engine's `GoalDisposal`
  **discriminated union** intact rather than flattening `disposition`/`targetDate` into
  independent fields — so an authoring form structurally **cannot** construct the illegal
  "firing disposition with no month to fire at" pair the type exists (§5.2, #28) to forbid.
- **`goalDisposal(disposition, targetDate)` helper.** The form holds its disposition and
  date as separate controls (natural for a UI) and folds them back into a legal
  `GoalDisposal` on submit. A firing disposition (`spend` / `convertToEquity`) forces a
  stray `"asap"` down to month 0; standing dispositions (`retain` / `drawDown`) keep
  `"asap"`. The form also disables the "asap" checkbox while a firing disposition is
  selected, so the coercion is a belt-and-braces guard, not the primary UX.
- **`addGoal` mints its own id via deterministic `freshGoalId`.** Since the id is derived
  from the current list (first unused `goal<n>`), `addGoal(goals, draft)` stays a pure,
  deterministic `(goals, …) => GoalPlan[]` transform — no `Math.random` / `Date.now` /
  threaded counter. New goals append **last** = lowest priority (priority is array index).
- **`removeGoal` is a plain filter.** The derived `goal-<id>` fund account needs no
  explicit teardown: `buildPlanAccounts` mints one account per goal in `budget.goals`, so
  dropping the goal drops its account. A regression test asserts the account key
  disappears from the projection's `accountBalancesCents`.
- **`updateGoal` replaces the full field set, keeping id + list position.** Priority is
  therefore untouched by an edit (only `reorderGoal` moves goals), and the untouched goals
  keep object identity so React/memo stay cheap.
- **No timeline event.** All three transforms only rewrite `budget.goals`; nothing touches
  the ledger, satisfying the §4.2/§10.3 direct-override requirement.

## Changes Made

- `packages/app/src/goalsView.ts`
  - New `GoalDraft` type (authorable goal shape, disposal union preserved).
  - New `goalDisposal(disposition, targetDate)` — builds a legal `GoalDisposal` pairing.
  - New `freshGoalId(goals)` — deterministic unique-id minter.
  - New pure transforms `addGoal`, `updateGoal`, `removeGoal`.
- `packages/app/src/components/goalsPanel/goalForm.tsx` **(new)**
  - Disclosed add/edit form; disposition + date controls fold into a legal disposal on
    submit; "asap" disabled for firing dispositions.
- `packages/app/src/components/goalsPanel/goalsPanel.tsx`
  - Per-goal **Edit** / **Delete** controls; on-demand **+ Add a goal** disclosure;
    empty-state now invites a first goal. All wired through `setBudget`, re-running the
    projection so on-track %s update live.
- `packages/app/src/goalsView.test.ts` — unit tests for the four helpers (purity,
  immutability, live re-projection, fund-account teardown, `asap` pairing legality).
- `packages/app/src/components/goalsPanel/goalsPanel.test.tsx` — SSR render tests for the
  edit/delete/add controls and the empty-state invitation.

## Verification & Testing

- `npm run check:purity` → ✓ engine purity passed.
- `npm run typecheck` → ✓ no type errors.
- `npm run test` → **402 tests green** (45 todo), 36 files. Goal-specific suites:
  `goalsView.test.ts` 21/21, `goalsPanel.test.tsx` 10/10.

### Acceptance criteria

- [x] User can add a goal (name, target, date incl. "asap", type) from the goals panel;
      it appears at lowest priority.
- [x] User can edit an existing goal's fields; the projection and on-track %s update live.
- [x] User can delete a goal and its derived fund account.
- [x] Adding/editing/deleting creates no timeline event (direct override, §4.2/§10.3).
- [x] Existing reorder, on-track %, tradeoff, and short-horizon-risk flag behavior is
      unchanged (all prior tests green).
- [x] `addGoal` / `updateGoal` / `removeGoal` are pure and unit-tested in
      `goalsView.test.ts`.
