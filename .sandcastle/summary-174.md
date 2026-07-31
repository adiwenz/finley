# Summary — issue 174

## Overview

`SpendingItem` — a read model built at the *end* of each simulated month that the simulation
never consumed — is gone. In its place `FinancialObligation` is the normalized runtime
representation of everything a month must fund (budget lines, healthcare, event-spawned expense
series, and each liability's scheduled payment), and the dataflow is inverted: obligations are
constructed *before* decumulation sizing, and the waterfall's input is now a **derivation of the
obligation list** rather than a scalar computed independently in parallel. The reported list and
the funded amount are now structurally incapable of disagreeing — one list, two named sums over
it. The slice is proven end-to-end by the budget editor, which now renders every obligation the
month incurs, not just the authored budget lines.

## RGR Verification Details

Each slice landed red → green:

- **Two named sums** (`automaticFundingTotal`, `expenseReportingTotal`): unit tests over
  hand-built lists, pinning that they stay two functions and coincide only while all funding is
  automatic.
- **Construction per source**: one focused regression test per source kind — budget line,
  healthcare, child cost, alimony/child support, and each liability payment — asserting the right
  treatment, priority, and payoff-capped debt amount.
- **Inversion**: the projection-output invariance suite (net-worth curve, headline retirement
  age, totals) held unchanged — the inversion moved no numbers.
- **Flow record**: the obligation list replaced the spending-item array; `lineMonthlyCents` and
  the rollups are all derived from it in one pass, pinned by an engine invariant test.
- **UI (this task)**: `obligationEditLink` unit tests (each source kind → its surface, or null);
  `SpendingEditor` tests (non-editable obligation renders read-only with amount + deep link,
  authored lines stay editable, no edit/delete on read-only rows); `BaseAdjustmentsPanel`
  integration tests (the plan's health care and a loan payment render read-only beside the
  editable budget lines, deep-linking to the plan and the loan respectively).

## Key Decisions & Why

- **Two sums are two functions, deliberately.** They are identical this slice and diverge
  permanently in Slice #4 (`funding: explicit`). Naming them apart now stops a later
  "simplification" collapsing them; no call site inlines its own `.reduce`.
- **Amounts are requested/owed, nominal at the month.** A debt obligation carries the
  payoff-capped payment (capped by the debt, never by affordability). What was actually charged
  is deferred to `ResolvedFunding` (Slice #5), which keeps obligations dumb and summable.
- **Priority resolved at construction from source kind**, no new authoring surface: debt payments
  and court-ordered support in the mandatory tier (preserving today's never-rationed behaviour),
  healthcare and child cost in the needs tier, budget lines by their existing category ordering
  carried through compilation. Ties break on the stable `id` so chart bands never reshuffle.
- **Ordering is a reporting concern.** `buildObligations` returns source order; `buildFlows`
  orders by priority before placing the list on the record. The waterfall consumes an
  order-invariant sum, so it does not care.
- **Deep links are in-page anchors.** The app is one scrolling page with no router, so a
  non-editable row's "real edit surface" is the card that authors the fact: healthcare → the plan
  card, event-spawned expense → the timeline, a loan payment → the timeline (where loans live).
  The anchor ids are a single source of truth (`obligationLink.ts`), consumed by `main.tsx`.

## Changes Made

Earlier tasks (1–5), from the branch log:

- `packages/engine/src/projection/financialObligation.ts` — the `FinancialObligation` type,
  `ObligationSource`, `automaticFundingTotal` / `expenseReportingTotal`,
  `orderObligationsByPriority`, `buildObligations`, priority tiers.
- `compileBudget.ts` / `projectionBase.ts` / `ledger/interpret.ts` — every source now tags its
  series with an `obligationSource` (kind, category, editable, priority).
- `reportFlows.ts` / `simulate.types.ts` — the flow record carries `obligations` and
  `totalObligationsCents`; `lineMonthlyCents` and the rollups derive from the one list.
- `projection/spendingItems.ts` deleted; no `SpendingItem` terminology survives.

This task (6):

- `packages/app/src/components/baseAdjustments/obligationLink.ts` (new) — `obligationEditLink`
  maps a non-editable obligation to its edit surface's anchor, or null; `OBLIGATION_SURFACE_ANCHORS`
  is the shared anchor-id source of truth.
- `spendingEditor.tsx` — renders the month's full `obligations` list in priority order; `editable`
  gates the in-place input (authored budget lines) vs. a read-only `ObligationRow` with amount and
  deep link.
- `baseAdjustmentsPanel.tsx` — reads the selected month's `flows.obligations` off the same series
  the chart draws and passes it to `SpendingEditor`.
- `main.tsx` — the Budget & accounts card and the timeline carry the deep-link anchor ids.

## Verification & Testing

`npm run check` green (purity → typecheck → tests): **1278 tests passed, 45 todo**.
