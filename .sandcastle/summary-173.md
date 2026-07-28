# Slice #2 — Block goal deletion when its fund account funds an event

## Overview

Deleting a goal used to be an unvalidated plan mutation. Because each goal derives exactly
one fund account (`goal-<id>`), dropping the goal drops its account — and any authored event
that named that account as a funding source was left pointing at an account that no longer
exists (a dangling funding reference, which the simulator today silently turns into fabricated
net worth).

This change refuses the deletion whenever the goal's fund account is named as a funding source
by any ledger event, and tells the user which events block it — by label and month — so they
can edit or re-point those events first. It is a plain check reading the ledger from the goals
view; no new engine machinery.

Today the only event type that names an account as a funding source is `HomePurchaseEvent`
(its ordered `downPaymentSourceIds`). The guard is written against "an event's funding
sources" generally, so it extends for free when the One-Time Spend Event (Slice #7) lands.

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

Final: `995 passed | 45 todo`, typecheck clean, engine purity clean.

## Key Decisions & Why

- **Guard in the goals view, not the engine.** The issue's layering note is explicit: this is
  defense-in-depth ahead of the funding-pipeline slices, so it belongs as a plain read of the
  ledger from the authoring surface. `goalFundingBlocks` reads `ledger.events` directly — the
  reference is an *authoring fact*, present whether or not the draw ever resolves, so reading
  the projection would be the wrong source.
- **Reuse existing vocabulary.** Blocking events are labelled via `summarizeEvent` (the same
  plain-language labels the timeline shows — "Bought a home") and dated via `monthLabel` (the
  single month→time label every surface already goes through). No new formatting concepts, so
  the refusal reads consistently with the rest of the app.
- **Structured list + formatted message as two functions.** `goalFundingBlocks` returns
  `{ label, month }[]` (tested against the AC's "by label and month"); `goalDeletionBlockMessage`
  is the single authority for the user-facing text. One formatter, tested for exact wording.
- **Derive the refusal at render, don't snapshot it.** The panel stores only `refusedDeleteId`
  and recomputes the message from the current ledger each render. Removing or re-pointing the
  blocking events therefore clears the message live (AC4) instead of leaving stale text — and
  it follows the "derive during render, not in an effect" React guideline.
- **Sort blockers by (month, sequence)** so a multi-event refusal reads in timeline order.

## Changes Made

- `packages/app/src/goalsView.ts`
  - `eventFundingSourceIds(event)` — the account ids an event names as funding sources
    (today: a home purchase's `downPaymentSourceIds`; every other type funds nothing).
  - `goalFundingBlocks(goals, id, ledger)` — the events whose funding sources name the goal's
    derived fund account, as `{ label, month }[]`, sorted by (month, sequence). Empty when
    unreferenced.
  - `goalDeletionBlockMessage(goals, id, ledger)` — the refuse-to-delete text naming each
    blocker, or `null` when deletion may proceed.
- `packages/app/src/components/goalsPanel/goalsPanel.tsx`
  - New required `ledger` prop.
  - `remove(id)` refuses (sets `refusedDeleteId`, no mutation) when the goal funds an event;
    otherwise deletes as before.
  - Renders the derived refusal as an amber `role="alert"` under the goal's actions.
- `packages/app/src/main.tsx` — passes `ledger` into `GoalsPanel`.
- `packages/app/src/assets/styles/globals.css` — `.alert-list { white-space: pre-line }` so
  the newline-joined blocker list renders as a list.
- Tests: `goalsView.test.ts` (block logic, multi-event, unreferenced, unblock),
  `goalsPanel/goalsDelete.test.tsx` (refuse + normal delete), existing `goalsPanel.test.tsx`
  render calls updated for the new prop.

## Verification & Testing

- `npm run check` (purity + typecheck + tests): **995 passed | 45 todo**, 84 test files.
- Engine purity check: passed (change is app-only; no engine edits).
- `tsc --noEmit`: clean.

## Notes for the next iteration

- The guard keys on `HomePurchaseEvent.downPaymentSourceIds` via `eventFundingSourceIds`.
  When Slice #7's One-Time Spend Event adds another event type that names funding sources,
  extend that one helper and the guard covers it — no other change needed.
- Per the issue's layering note, once Slice #6 stops the simulator fabricating net worth from
  a stranded reference, this remains as defense-in-depth. It is independent of #127's
  goal-archival semantics; if archival later separates a goal from its account, the check
  moves to the account.
