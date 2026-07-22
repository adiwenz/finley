# Issue #77 — ChildEvent: annual-cost field that auto-creates an 18-year child-cost expense

## Overview

`ChildEvent` was financially inert — adding a child recorded it in the household
roster but created no expense, so net worth and retirement age never moved (a
planner that lets you have kids for free). This change gives `ChildEvent` an
**annual cost** field (`annualCostCents`). When the event applies with a positive
cost, it spawns a linked recurring **expense series** (role `childCost`) running
from the birth month for **exactly 18 years**, tagged with `causedByEventId` so
undoing the child event transitively removes the expense via the existing
dependency machinery. A zero cost records the child with no financial effect, as
before.

The implementation mirrors the alimony/child-support pattern in the
`SeparationEvent` handler (same `causedByEventId` linkage, same bounded-duration
shape).

## RGR Verification Details

- **RED:** Added `ChildEvent > annual cost spawns a bounded 18-year childCost
  expense that reduces net worth` to `packages/engine/src/events.test.ts`. It
  seeds a $12,000 checking account, adds a `ChildEvent` with
  `annualCostCents = $12,000` at birth month 0, and asserts (a) the 12-month
  horizon net worth drops to $0 (the $1,000/mo expense drains the account) and
  (b) the derived series has `role: "childCost"`, `seriesType: "expense"`,
  `causedByEventId: "c1"`, `startMonth: 0`, `endMonth: 18*12 - 1`. Initial run
  failed exactly as expected: `expected 1200000 to be +0` — no expense existed.
- **GREEN:** Implemented the field, handler series, validation, role label, and
  form input. The test (plus a companion `zero annual cost creates no childCost
  expense` guard) went green with zero regressions.
- **REFACTOR:** Kept the handler idiomatic — reused the existing `addSeries`
  helper and the annual baseline unit (source of truth, distributed with no
  pre-round per §4), and named the 18-year bound as a local constant.

## Key Decisions & Why

- **Real, not nominal (CPI-linked).** Alimony/child-support use flat nominal
  (`growthMode: { type: "fixed" }`) because they are short, fixed-dollar
  obligations. A child cost spans 18 years, so it uses
  `{ type: "inflationLinked", annualRate: context.annualInflationRate }` to stay
  real across that span (§4.1) — the same default the home-purchase handler uses.
- **Annual is the source of truth.** The field is stored/displayed as an annual
  amount and the series carries `baseline: { unit: "annual", annualCents }`.
  Rather than pre-dividing by 12 (which rounds), the series machinery distributes
  the annual total across the year so 12 months sum exactly (§4), matching how
  `JobChangeEvent` handles annual income.
- **Exactly 18 years, inclusive end.** `endMonth = birthMonth + 18*12 - 1`
  (216 months, inclusive), mirroring alimony's bounded `+ duration - 1` shape.
- **Zero-cost is inert.** The series is only spawned when `annualCostCents > 0`
  (mirroring `if (event.alimonyMonthlyCents > 0)`), so a zero/blank cost keeps the
  child financially neutral and adds no clutter to the snapshot/timeline.
- **Owner attribution = the child.** The expense's `ownerId` is the child's own
  id. Expense series owners are attribution tags only (income owners drive cash
  pools; expense owners do not), so tagging by child keeps the linkage precise and
  unique per child without inventing a household-owner concept.
- **Required field.** `annualCostCents` is required (not optional), consistent
  with every other money field on the event union; existing fixtures were updated
  to pass `0` explicitly.
- **Default UI value.** The form defaults to an illustrative $15,000/yr (editable,
  min 0) so the common case is non-zero, with a hint that it adds an 18-year
  expense.

## Changes Made

- `packages/engine/src/ledger/eventTypes.ts`
  - Added `annualCostCents: Cents` to `ChildEvent` and rewrote its doc comment
    (the old "affects expenses only if explicit expense events follow" is no
    longer true).
  - Added `"childCost"` to the `SeriesRole` union.
- `packages/engine/src/ledger/eventHandlers.ts`
  - `child.apply` now spawns the bounded, inflation-linked `childCost` expense
    series when `annualCostCents > 0` (reads `context.annualInflationRate`).
- `packages/engine/src/ledger/eventValidation.ts`
  - `ChildEvent` structural validation now enforces non-negative `annualCostCents`.
- `packages/app/src/ledgerView.ts`
  - `seriesLabel` maps `childCost → "Child cost"`; `summarizeEvent` appends the
    annual cost to the "Had a child" detail when present.
- `packages/app/src/components/addEventForm/childForm.tsx`
  - Added an "Annual cost" `NumInput` (default $15,000/yr, min 0) and wired
    `annualCostCents` into the emitted event.
- Test fixtures updated to carry the new field: `events.test.ts`,
  `snapshot.test.ts`, `ledgerView.test.ts` (added new engine tests for the
  spawned series and the zero-cost guard).

## Verification & Testing

- `npm run check:purity` → engine purity passed (no I/O, no app/rules imports).
- `npm run typecheck` → clean (`tsc --noEmit`).
- `npx vitest run` → **611 passed | 45 todo (656)**, 52 test files, 0 failures.
