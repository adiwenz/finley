# Issue #119 — Create more default simulations

## Overview

A fresh session opened on a single starting point: the healthy `PLAN_DEFAULTS` saver
("Alex"), on track for retirement. That is a thin slice of the financial lives the model
is meant to illuminate. This change adds a **starter-simulation picker** to the app and
three new loadable scenarios drawn straight from the issue:

- **Living paycheck to paycheck** — income barely covers the bills, almost nothing saved.
- **Living on a credit card** — spending outruns income, piling up compounding card debt.
- **Student loan → negative net worth** — a graduate underwater on a $45k loan, digging out.

Each scenario is authored as a full **`Scenario`** (a `Plan` plus the timeline
`NewLifeEvent`s it needs), so what the user loads is exactly what the engine projects. The
student loan is modelled as a real amortizing `LoanEvent` liability at "now" — not a
negative cash balance — so its negative net worth is the honest assets-minus-liability line
from §3, and it climbs back above zero as the income services the loan.

## RGR Verification Details

**RED.** Wrote `packages/app/src/presets.test.ts` first, asserting each preset projects to
its intended *financial shape* through the real engine pipeline (`createProjectionBase →
buildPresetLedger → interpretLedger → buildHouseholdSimInput → simulateHousehold`). It
failed to even load: `Error: Failed to load url ./presets … Does the file exist?` — the
module did not yet exist.

**GREEN.** Added `packages/app/src/presets.ts` with the four presets and the
`buildPresetLedger` seed-replay helper. The five tests went green, pinning each signature:

- **default** — mid-career real net worth > 3× opening; solvent well past month 120.
- **paycheck-to-paycheck** — stays positive while working but accumulates < 25% of the
  default's wealth by month 120, then goes insolvent around retirement (no cushion).
- **living-on-credit** — real net worth turns negative within 2 years; the
  `synthetic-credit-card` liability grows month-12 → month-36; eventually insolvent.
- **student-loan** — real net worth negative at month 0, a `loan-student` liability present
  at "now", and back above zero by month 120.

A throwaway scratch test was used to calibrate the dollar figures against the live engine
(health lines, income, and expenses tuned so each working-years trajectory reflects the
income/expense gap the scenario is about) and then deleted.

**Second RGR loop (UI wiring).** Added two App-level integration tests in
`mainState.test.tsx` (jsdom) that drive the actual `<select>`: loading *Student loan* swaps
the plan (name → "Riley", opening balance → 4000) **and** seeds one timeline event (one
Remove control); switching to *Living on a credit card* swaps to "Jordan" and clears the
prior seed timeline. Both pass.

## Key Decisions & Why

- **Presets are `Scenario`s, not bare `Plan`s.** The `Plan` type carries no standing
  liabilities, so a faithful student loan must ride on the ledger. Modelling it as a
  `LoanEvent` (the same event the loan form emits) keeps negative net worth honest and
  reuses the engine's real amortization instead of hacking a negative opening balance.
- **Seed events are replayed through `addEvent`, not hand-assembled into a `Ledger`.**
  `buildPresetLedger(base, events)` folds the same base-aware `addEvent` the live UI uses,
  so a preset can never smuggle in an event the engine would reject from the form. A
  rejected seed throws (a preset bug), rather than silently dropping the event.
- **`loadPreset` builds the new ledger against the *incoming* plan's base.** It calls
  `createProjectionBase(preset.plan, …)` directly rather than reading the memoized `base`
  (which still reflects the *old* plan during the same render), avoiding a stale-base
  replay when swapping scenarios.
- **`useLedger` gained a `resetLedger` seam.** A narrow "replace the whole ledger" method
  is the minimal surface a preset load needs; it installs the pre-replayed ledger and
  clears any stale conflict.
- **Teaching scenarios drive spending through the scalar `expenseCents` path**
  (`budgetLines: []`) and trim the health lines below the default's ~$700, so the
  income/expense gap is the single legible lever behind each shape.

## Changes Made

- **`packages/app/src/presets.ts`** *(new)* — `Preset` interface; the `PRESETS` array
  (default + three scenarios) in picker order; `presetById(id)`; and `buildPresetLedger`.
- **`packages/app/src/presets.test.ts`** *(new)* — signature tests for all four presets.
- **`packages/app/src/hooks/useLedger.ts`** — added `resetLedger(ledger)` to `UseLedger`.
- **`packages/app/src/main.tsx`** — `presetId` state, a `loadPreset` handler, and a
  "Start from a scenario" `<select>` with the selected scenario's description.
- **`packages/app/src/mainState.test.tsx`** — two integration tests for the picker wiring.
- **`packages/app/src/assets/styles/globals.css`** — `.preset-picker` / `.preset-desc`.

## Verification & Testing

- `npm run typecheck` — clean.
- `npm run check:purity` — engine purity guard passes (new code is app-only).
- `npm run test` — **732 passed | 45 todo (777)**, 61 files, zero regressions.
