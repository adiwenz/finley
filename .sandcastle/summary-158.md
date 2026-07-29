# Issue 158 — Retire the recurring "Added an expense" event (`BudgetItemStartEvent`)

## Overview

Recurring expenses have a single source of truth: the **Base + Adjustments** line-item
budget (`Plan.budgetLines`). The timeline's **"Added an expense"** entry — authored by
`ExpenseForm` and stored as a `BudgetItemStartEvent` — was a second, overlapping way to
author the same concept, and its paired `BudgetItemEndEvent` existed only to close such a
series. Neither had a distinct job. This change removes them outright: the menu entry, the
form, both event types, their handlers, validation, funding-source and ledger-view display
cases, and the now-dead `budgetItem` series role.

The removal is total (not the "minimal alternative" of only pulling the UI): nothing in the
codebase produced these events besides `ExpenseForm`, the income arm (`seriesType: "income"`)
was already unreachable, and no shipped ledger or preset carries them — so no data migration
is needed. Internal cost cascades (child cost, alimony, child support) build their series
via `addSeries(...)` with explicit roles and are untouched.

## RGR Verification Details

**RED** — Added a behavioral test to `mainState.test.tsx` asserting the Add-event menu no
longer offers "Added an expense". It failed exactly as expected:

```
AssertionError: expected [ 'Added an expense', …(5) ] to not include 'Added an expense'
```

**GREEN** — Removed the `BudgetItemStartEvent` menu entry and `ExpenseForm` render from
`addEventForm.tsx` (defaulting the picker to `LoanEvent`) and deleted `expenseForm.tsx`. The
test passed.

The engine type removal then surfaced as a compile-time cascade: dropping the two members
from the `LifeEvent` union turned every exhaustive `switch` and every test fixture that
named them into a type error (`npm run typecheck`), which pinned exactly the consumers and
tests needing rework. Each was migrated to a surviving event (see below) and re-verified
green.

## Key Decisions & Why

- **Removed the `budgetItem` `SeriesRole` too.** It was produced *only* by the deleted
  `BudgetItemStartEvent` handler, so after removal nothing could ever create it — leaving it
  in the union, in `ROLE_LABEL`, and in `seriesLabel` would be dead vocabulary. Its display
  behavior was identical to `base` (income → "Income", expense → "Expense"), which absorbs it.
- **Tests re-vehicled, not deleted, where they covered surviving behavior.** Many suites used
  `BudgetItemStartEvent`/`EndEvent` merely as a convenient standalone/producer/consumer event.
  Those were migrated to events that still exist so the underlying capability stays covered:
  - Ledger mechanics (sequence numbering, `removeEvent`, `computeDependents`) → `LoanEvent`.
  - Replay ordering (same-month producer-before-consumer; sort by sequence not array order) →
    `RelationshipEvent` + `SeparationEvent`, a real precondition-gated producer/consumer pair
    whose apply order is observable in the household cross-section.
  - Partner income in separation/relationship tests → the partner's **job** (authored on the
    `RelationshipEvent`), the surviving idiom for partner income.
  - Event-created expense (spending-items invariant; retirement headline age) → `ChildEvent`,
    whose child-cost series is now the only event-authored expense on the timeline.
  - Snapshot "grown rate at month" → a **base income series** with `salaryCompound` growth.
- **Tests deleted where they exercised only the removed capability.** The
  `BudgetItemStartEvent`/`EndEvent` income start/replace/end mechanics and the UI's expense-owner
  picker test had no surviving subject and were removed; the base-series coverage they sat
  beside was kept (and the file renamed `events.budgetItems.test.ts` → `baseSeries.test.ts`).
- **`OwnerSelect` removed** from `formControls.tsx` — `ExpenseForm` was its only caller.
- **Menu default → `LoanEvent`.** With the expense entry gone, `LoanForm` is the first option;
  it also submits via an "Add event" button, so the ledger-add tests still pass unchanged.

## Changes Made

Engine:
- `ledger/eventTypes.ts` — removed `BudgetItemStartEvent` / `BudgetItemEndEvent` interfaces and
  their union members; dropped the now-dead `budgetItem` `SeriesRole` and the unused
  `TaxCategory` import.
- `ledger/eventHandlers.ts` — removed the `budgetItemStart` / `budgetItemEnd` handlers, their
  registry entries, and type imports.
- `ledger/eventValidation.ts` — removed the two `validateEventData` cases.
- `ledger/interpret.ts` — removed `budgetItem` from `ROLE_LABEL`.
- `goalFunding.ts` — removed the two case labels from `eventFundingSourceIds`.

App:
- `components/addEventForm/addEventForm.tsx` — removed the "Added an expense" menu entry and
  `ExpenseForm` render; default kind is now `LoanEvent`; documented the boundary rule.
- `components/addEventForm/expenseForm.tsx` — deleted.
- `components/addEventForm/formControls.tsx` — removed the now-dead `OwnerSelect`.
- `ledgerView.ts` — removed the `BudgetItemStartEvent` / `BudgetItemEndEvent` display cases and
  the `budgetItem` case in `seriesLabel`.

Tests:
- `engine/src/baseSeries.test.ts` (renamed from `events.budgetItems.test.ts`) — kept the
  base income/expense coverage, re-expressed the one event-income case as a base income series.
- `engine/src/events.test.ts` — validation case → dangling-liability `DebtPayoffEvent`; replay
  order → `RelationshipEvent` + `SeparationEvent`.
- `engine/src/events.mechanics.test.ts` — generic vehicle events → `LoanEvent`.
- `engine/src/events.relationships.test.ts` — partner income → partner job.
- `engine/src/snapshot.test.ts` — removed the income start/replace test; separation-income →
  partner job; grown-rate → base income series.
- `engine/src/goalFunding.test.ts` — spends-nothing event → `ChildEvent`.
- `engine/src/projection/spendingItems.test.ts` — event-created expense → `ChildEvent` child cost.
- `app/src/ledgerView.test.ts` — marker event → `RelationshipEvent`; `budgetItem` role → `base`.
- `app/src/retirementView.test.ts` — ledger expense → `ChildEvent` childcare.
- `app/src/mainState.test.tsx` — added the RED menu test; removed the expense-owner test;
  refreshed the stale "default 'Added an expense'" comment.

## Verification & Testing

- `npm run check` (purity + typecheck + tests) — **green**.
- Engine purity check passed (no I/O, no app/rules imports in engine source).
- `tsc --noEmit` — no errors.
- Vitest: **1016 tests passed** | 45 todo across **85 test files**.
