# Slice #2 — Block goal deletion when its fund account funds an event

## Overview

Deleting a goal used to be an unvalidated plan mutation. Because each goal derives exactly
one fund account (`goal-<id>`), dropping the goal drops its account — and any authored event
that named that account as a funding source was left pointing at an account that no longer
exists (a dangling funding reference, which the simulator today silently turns into fabricated
net worth).

This change refuses the deletion whenever the goal's fund account is named as a funding source
by any ledger event, and tells the user which events block it — by label and month — so they
can edit or re-point those events first.

The guard lives in the engine, beside the event union it questions, because "which events
spend from an account" is engine knowledge and goal deletion is not only a UI gesture: the
`Projection` API can drop a goal too, and refuses on the same rule. The app layer keeps one
thing — turning the engine's answer into the sentence a person reads.

Two event types name an account as a funding source: `HomePurchaseEvent` (its ordered
`downPaymentSourceIds`) and `DebtPayoffEvent` (its `accountId`, the paired outflow that pays
the liability down). The engine's `eventFundingSourceIds` is an exhaustive switch with no
default arm, so a new event type that spends from an account cannot compile until it answers
the question — the One-Time Spend Event (Slice #7) will fail the typecheck rather than
silently slip past the guard.

## RGR Verification Details

Three red→green cycles, each a single failing test first.

1. **Pure block logic** (`goalsView.test.ts`) — added `goalFundingBlocks` /
   `goalDeletionBlockMessage` tests. RED: `TypeError: goalDeletionBlockMessage is not a
   function`. GREEN: implemented both in `goalsView.ts`.
2. **Panel wiring** (`goalsPanel/goalsDelete.test.tsx`, jsdom) — clicking Delete on a blocked
   goal. RED: `setBudget` was called (goal deleted) and no alert rendered. GREEN: the panel
   consults `goalDeletionBlockMessage` before mutating and renders the refusal.
3. **AC4 unblock** — added a test asserting the block clears once the referencing event leaves
   the ledger; passed against the already-implemented logic (ledger-driven, so no stale state).
4. **Engine relocation** — moved the predicate down to `goalFunding.ts` and added
   `Projection.removeGoal`. Exhaustiveness was verified by deleting an arm of the switch and
   confirming `tsc` fails with TS2366, then restoring it.
5. **Stale-refusal fix** — pinned the refusal to the blockers of one delete attempt. Both
   halves of the fix were checked by removing each in turn and confirming which test fails:
   the id filter is what catches a blocker *replaced in a single update*, and it alone is
   enough to make revival impossible. The state-clear is belt-and-braces and no test
   fails without it.

Final: `1019 passed | 45 todo`, typecheck clean, engine purity clean.

## Key Decisions & Why

- **The predicate is engine, the sentence is app.** Which events spend from an account is a
  fact about the event union, so it lives beside it; the plain-language refusal needs
  `summarizeEvent` and `monthLabel`, which engine purity forbids the engine importing. The
  seam falls exactly there: the engine returns `LifeEvent[]`, the app names them.
- **Read the ledger, not the projection.** The reference is an *authoring fact*, present
  whether or not the draw ever resolves, so the projection would be the wrong source.
- **Exhaustive switch, no default arm.** `eventFundingSourceIds` answers for every member of
  `LifeEvent`. A default arm would let a future spending event default to "funds nothing" and
  silently reopen the dangling-reference hole; without one, it is a compile error.
- **`DebtPayoffEvent` counts too.** Its `accountId` is drained by the paired outflow
  (`eventHandlers.ts` pushes a negative account transfer), so it strands exactly like a down
  payment. Nothing in today's UI authors one, but the functional `addEvent` accepts it.
- **`Projection.removeGoal` throws rather than returning a result.** Every refusal on that
  class throws (see `commitEvent`); `validateGoalRemoval` is the ask-first path for callers
  that want to check before acting, which is what the panel uses.
- **Reuse existing vocabulary.** Blocking events are labelled via `summarizeEvent` (the same
  plain-language labels the timeline shows — "Bought a home") and dated via `monthLabel` (the
  single month→time label every surface already goes through). No new formatting concepts, so
  the refusal reads consistently with the rest of the app.
- **Structured list + formatted message as two functions.** `goalFundingBlocks` returns
  `{ eventId, label, month }[]` (tested against the AC's "by label and month"); the row carries
  its event id so a caller can hold *which* events blocked without holding the words describing
  them. `fundingBlockMessage` is the single authority for the user-facing text.
- **The refusal is pinned to one delete attempt.** The panel stores `{ goalId, blockerEventIds }`
  — the events that blocked at that click — and re-derives the wording from the current ledger
  each render. Ids rather than the sentence, so a blocker re-dated afterwards still reads
  correctly; pinned rather than "whatever blocks this goal now", so an event that funds the
  same goal later cannot revive a refusal the user never asked for a second time.
- **Sort blockers by (month, sequence)** so a multi-event refusal reads in timeline order.

## Changes Made

- `packages/engine/src/goalFunding.ts` (new)
  - `eventFundingSourceIds(event)` — the account ids an event spends from, in drain order.
    Exhaustive over `LifeEvent`, no default arm.
  - `eventsFundedByGoal(goals, goalId, ledger)` — the events spending from the goal's derived
    fund account, sorted by (month, sequence). Empty for an unreferenced or unknown goal.
  - `validateGoalRemoval(goals, goalId, ledger)` — the ledger's own `ValidationResult`, with
    a `reason` naming each blocker by id, type and month.
- `packages/engine/src/projectionRoot.ts` — `Projection.removeGoal(id)`: drops the goal, or
  throws with the state untouched while an event still spends from its fund account.
- `packages/engine/src/index.ts` — exports the new module.
- `packages/app/src/goalsView.ts`
  - `goalFundingBlocks(goals, id, ledger)` — maps the engine's blockers to
    `{ eventId, label, month }[]` using `summarizeEvent`. No longer decides *which* events block.
  - `fundingBlockMessage(blocks)` — the refuse-to-delete text for a given set of blockers, or
    `null` for none. Takes the rows rather than the goal, so the panel can format one
    refusal's own blockers instead of everything currently blocking the goal.
- `packages/app/src/components/goalsPanel/goalsPanel.tsx`
  - New required `ledger` prop.
  - `remove(id)` refuses (records `{ goalId, blockerEventIds }`, no mutation) when the goal
    funds an event; otherwise deletes as before.
  - Renders the derived refusal as an amber `role="alert"` under the goal's actions.
- `packages/app/src/main.tsx` — passes `ledger` into `GoalsPanel`.
- `packages/app/src/assets/styles/globals.css` — `.alert-list { white-space: pre-line }` so
  the newline-joined blocker list renders as a list.
- Tests: `goalFunding.test.ts` (per-type funding sources, blocker discovery and ordering,
  refusal wording), `projectionRoot.test.ts` (remove / refuse / state untouched / unblock /
  unknown id), `goalsView.test.ts` (block logic, multi-event, unreferenced, unblock),
  `goalsPanel/goalsDelete.test.tsx` (refuse + normal delete + the stale-refusal regressions:
  no revival after a later blocker, no revival when a blocker is replaced in one update,
  wording re-read from the ledger, partial-clear keeps the rest), existing `goalsPanel.test.tsx`
  render calls updated for the new prop.

## Verification & Testing

- `npm run check` (purity + typecheck + tests): **1019 passed | 45 todo**, 85 test files.
- Engine purity check: passed.
- `tsc --noEmit`: clean.

## Notes for the next iteration

- The app holds a bare `Plan` in React state and mutates it through `goalsView`, not through
  `Projection`. So the panel's guard and `Projection.removeGoal` are two callers of one rule
  rather than one path — they cannot drift (both go through `eventsFundedByGoal`), but if the
  app ever adopts `Projection` as its state root, the panel's pre-check collapses into it.
- Per the issue's layering note, once Slice #6 stops the simulator fabricating net worth from
  a stranded reference, this remains as defense-in-depth. It is independent of #127's
  goal-archival semantics; if archival later separates a goal from its account, the check
  moves to the account.
