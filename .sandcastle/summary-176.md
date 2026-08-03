# Issue #176 — Per-line funding attribution + ResolvedFunding

## Overview

Every simulated month funds its obligations from one aggregate pool: income, the liquid buffer,
investment liquidation, then credit. Before this slice the engine never recorded *which* source
paid *which* line — a month quietly running on credit only showed up later as a bend in net worth.

This issue makes the funding walk explicit. The engine now emits, per obligation, a
`ResolvedFunding` record naming the sources that covered it and how much each delivered, in the
order the cascade consumed them — automatic obligations (budget lines, health, debt) and explicit
draws (a home down payment) alike, in one shared record shape. Account-funded sources carry the
resolver's full withdrawal breakdown (gross, principal/basis, realized gain, tax, net delivered).
This is a *partition of a flow that already happened*: no money moves differently, and balances,
basis, tax, net worth and the insolvency flag are bit-identical to pre-slice output.

Per-line attribution is a **derived interpretation, not a ledger fact** — money is fungible, and
"the car payment went on the Visa while rent came from income" is imposed by priority order, not
observed. `CONTEXT.md` documents it as such, and the UI frames it accordingly.

The final task surfaces the attribution in the UI: the **Base + Adjustments** panel now shows a
**Funded by** section for the selected month — what covered each obligation, each purchase shown
independently even when several share a reporting purpose in one month, with the account withdrawal
breakdown exposed where the resolver produced one.

## RGR Verification Details

The whole slice is guarded by a behaviour-preservation test
(`packages/app/src/presets.behaviorPreservation.test.ts`): an FNV-1a digest of each preset's
per-month money shape (excluding `resolvedFunding`) must stay identical, proving the attribution
walk moves no money. It was landed first (task 1) and has stayed green through every task.

Each task followed red → green:

- **Engine (tasks 1–5):** `resolvedFunding.test.ts` drives the `flows.resolvedFunding` seam. Each
  scenario test was written to fail against the pre-task engine and pass only once the attribution
  was populated — e.g. the two-same-`sourceId` guard (task 4) fails when a dedup-on-`sourceId` is
  injected; the appreciated-brokerage case (tasks 3, 5) asserts gross > net with a genuine partial
  gain and tax, which a flattened net amount could not satisfy.
- **UI (task 6):** `fundingView.test.ts` began red (stub returning `[]`) and went green once
  `buildFundingAttribution` mapped records to rows; `fundingAttribution.test.tsx` began red (no
  component) and went green once the component rendered. A wiring test runs a real projection and
  feeds `flows.resolvedFunding` through the view, proving the seam matches end to end.

## Key Decisions & Why

- **`sourceId + kind`, not a bare account id.** An automatic obligation's payer is often not an
  account (income never lands in one; credit is a liability). Consumers — including the UI — branch
  on `kind` and never parse ids, so explicit and automatic branches carry one shape.
- **`obligationId` is identity; `sourceId` is only a reporting namespace.** Records live in a flat
  array, never keyed by `sourceId`. Two home-purchase down payments in one month share
  `sourceId: "downpayment"` but stay two records with distinct `obligationId`s. The UI keys its
  entries by `obligationId` for the same reason, so it can never fuse two purchases.
- **Withdrawal breakdown carried through, not flattened.** A liquidated account source keeps the
  resolver's gross/principal/gain/tax/net, obeying `gross = principal + gain` and
  `net = gross − tax`, with `amountCents === netDeliveredCents`. Split lines get pro-rata slices
  that sum back to the account's own totals with no drift.
- **Built unconditionally** (no opt-in detail flag) to avoid two divergent funding code paths.
- **UI home: the Base + Adjustments panel.** It already resolves everything at a selected month and
  lists the month's obligations, so the **Funded by** section reads the same series the charts draw
  — the editor, the graph and the attribution cannot disagree. Account sources fall back to their
  account id (as the balances view already does), since `Account` carries no label.

## Changes Made

**Engine (tasks 1–5):**
- `packages/engine/src/projection/resolvedFunding.ts` — `ResolvedFunding`/`ResolvedFundingSource`
  types; `resolveFundingAttribution` (automatic, cascade-ordered layer walk with `apportionWithdrawal`)
  and `attributeExplicitObligation` (explicit draws).
- `packages/engine/src/projection/fundingDrawStep.ts` — records one explicit obligation per draw.
- `packages/engine/src/projection/simulate.ts` / `simulate.types.ts` — sizes the supply plan and
  attaches `flows.resolvedFunding`.
- `CONTEXT.md` — "Funding attribution" entry defining the derived interpretation.
- `packages/engine/src/projection/resolvedFunding.test.ts` — all six funding-mix scenarios plus the
  behaviour-preservation guard.

**UI (task 6):**
- `packages/app/src/fundingView.ts` (+ `fundingView.test.ts`) — `buildFundingAttribution`: maps a
  month's records to `FundingAttributionRow[]`, one per record, joining authored obligation labels
  and resolving source labels from `kind`; carries the withdrawal breakdown through.
- `packages/app/src/components/baseAdjustments/fundingAttribution.tsx` (+ `.module.css`,
  `.test.tsx`) — the **Funded by** section: one entry per obligation keyed by `obligationId`, its
  sources and amounts, the withdrawal breakdown where present, a shortfall callout, and a note that
  the view is derived.
- `packages/app/src/components/baseAdjustments/baseAdjustmentsPanel.tsx` — reads the selected
  month's `resolvedFunding` off the same flows lookup as `obligations` and renders the section.

## Verification & Testing

`npm run check` (purity + typecheck + full test) green: **1548 tests passed** (45 todo) across 109
files, exit 0. The behaviour-preservation digest is unchanged, confirming the attribution — and the
UI reading it — moved no money.
