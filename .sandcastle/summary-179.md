# Summary — issue 179: Pre-existing debts, children, partners, and homes at simulation start

## Overview

Users can now enter items that exist *at or before* simulation start — an existing partner,
a child already born, a loan already carried, a home already owned — without breaking the
event-sourced model. The settled design keeps everything event-caused: pre-existing facts
are the **existing** events/primitives dated before "now", never base-seeding and never a
backdated transaction. A pre-now date resolves to one of two load-bearing roles:

- **Anchor** (marriage / birth / separation) — placed at its *true past month*, so its
  elapsed position drives remaining durations for free (the forward cost series clip to
  processed months `≥ 0`). Carries no net worth, so a truthful past date reconstructs
  nothing.
- **Holding** (loan / property / mortgage) — opens at the now marker (`PRE_NOW_MONTH = -1`)
  with *current* terms and **no account side-effects** (no funding draw, no §4.5
  affordability gate). Its true origination is deliberately off the timeline: reconstructing
  years of amortization to reach today's balance would violate "entered current balances are
  the sole source of financial truth."

The typed doorway is a set of dedicated `Projection` methods + `ScenarioInput` entries
(`startPartnered`, `haveExistingChild`, `carryLoan`, `ownHome`) — each takes the quantity
the user actually knows and computes the month internally. No `preExisting` boolean (a bool
can't carry elapsed time).

## Work across the branch (per `git log`)

1. **Cut 1 — anchors + reused-event holdings.** `startPartnered` (RelationshipEvent at a
   true past month), `haveExistingChild({ ageMonths })` (ChildEvent, `birthMonth < 0`),
   `carryLoan` (LoanEvent at `-1`), and pre-now `separate` (SeparationEvent `month < 0`).
   No new event types, no decomposition — reused the existing primitives, which already
   clip forward series to remaining months.
2. **Decomposition — split `HomePurchaseEvent`.** Pulled mortgage origination out of the
   monolithic purchase handler and reused `LoanEvent`; the slimmed property event carries an
   optional `securedByLiabilityId` link (referential, not a `causedBy` edge). `buyHome`
   composes loan-then-property atomically. Behavior-preserving on the transaction path —
   enables Cut 2 to reuse the same two primitives as holdings.
3. **Cut 2 — pre-existing home (holding).** `ownHome({ valueCents, mortgage?, ... })` emits
   the mortgage `LoanEvent(-1)` (if any) + property holding at `-1`, no draw / no gate.
   `acquiredMonth` + `originalPriceCents` recorded as behavior-free metadata (a future
   sell-home's capital-gains basis + display only — no current-balance logic reads them).
   Added `holdingMonthFault` to the loan/property handler checks: a holding's only valid
   pre-now month is exactly `-1` (anchors are exempt).
4. **Glossary (this task) — `CONTEXT.md`.** Added the **Holding** and **Anchor** entries so
   the ubiquitous language and the engine agree on the two roles of a pre-now date.

## RGR Verification Details

Tasks 1–3 followed Red-Green-Refactor with regression guards binding the new paths:

- `packages/engine/src/preExisting.test.ts` — the `carryLoan` / `startPartnered` /
  `haveExistingChild` / `ownHome` facades and their declarative `ScenarioInput` forms.
- `packages/engine/src/ledger/events.homePurchase.test.ts` — the handler's holding mode, the
  `-1` holding-month precondition, and import rejection of a mis-dated holding.

Task 4 is a documentation deliverable (no behavior change): verified the referenced
vocabulary exists in code before writing (`PRE_NOW_MONTH`, `isPreExisting`,
`holdingMonthFault`, and the four authoring methods).

## Key Decisions & Why

- **Two roles, not one flag.** Anchor vs. Holding is the load-bearing distinction. Anchors
  date truthfully (elapsed time is the point); holdings pin to `-1` (current terms are the
  point, and a truthful mortgage date would demand reconstructing amortization).
- **Enter current, never reconstruct.** House value and loan balance are entered as current.
  Any "I only know what I originally paid" convenience is an app-side prefill, out of scope.
- **Home = two composed primitives.** Decomposing `HomePurchaseEvent` lets a pre-existing
  home reuse the exact parts a transaction home uses, and cleans the transaction path.
  The property→mortgage link is referential and optional (cash home omits it; unsecured loan
  has no asset) — its precondition buys independence, replay ordering, and removal-safety
  with no new graph edge.
- **History metadata is behavior-free.** `acquiredMonth` / `originalPriceCents` are basis +
  display for a future gains-on-sale issue; no balance/appreciation path reads them.

## Changes Made

- `packages/engine/src/authoring/*` — `startPartnered`, `haveExistingChild`, `carryLoan`,
  `ownHome` (`buyHome` recomposed onto the split primitives).
- `packages/engine/src/ledger/eventHandlers.ts` — `HomePurchaseEvent` decomposed; holding
  mode (skip draw/gate at `-1`); `holdingMonthFault` precondition on loan + property checks.
- `packages/engine/src/projection/scenarioInput.ts` — `ownHome` (and siblings') `entryMonth`
  cases so the ref graph sorts pre-now entries correctly.
- `CONTEXT.md` — **Holding** and **Anchor** glossary entries.
- Tests: `preExisting.test.ts`, `events.homePurchase.test.ts`.

## Verification & Testing

- `npm run check` (purity + typecheck + test) green on the finishing commit:
  **1310 tests passed**, 45 todo, across 99 test files.
- This final task is a markdown-only change; the engine + app suites from tasks 1–3 hold.
