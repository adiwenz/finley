# Issue #154 — One-Time Spend Event: source-directed, cash-only hard-block

## Overview

Adds a first-class **`OneTimeSpendEvent`** to the ledger — the replacement for the
removed `spend` disposition and a sibling of `HomePurchaseEvent` in the #129 money-out
model. A One-Time Spend is a **pure outflow**: it drains an ordered list of the user's
liquid accounts to fund a discretionary spend (a car, a trip, a gift) and **hard-blocks**
if those named sources cannot cover it. Unlike a Home Purchase it originates **no asset**,
so the money simply leaves net worth.

The differentiator over a plain dated expense override is exactly what the issue calls
out: **source-directed liquidation order** (the user controls which capital gains are
realized) plus a **hard coverage gate** (spend only what these named sources hold, else
block — never a silent spill onto credit). Financing is a `LoanEvent`'s job; the opt-in
soft-cascade onto credit is deferred to #128.

The event reuses the entire **#151 shared funding channel** unchanged. Because that
channel is *reason-blind* (the down-payment work in #153 made it event-neutral), adding
the event was a matter of naming a new `FundingReason` and its reporting prefix, not
re-wiring the resolution, tax gross-up, or reporting.

## RGR Verification Details

Strict red → green vertical slices, one seam and one behavior per cycle. Seams under
test: the public engine interface (`addEvent`, `interpretLedger`, `buildProjection`,
`fundingLookup`, `removeEvent`) and the app's `summarizeEvent` / `SpendForm` render.

1. **RED** — `drains the funding source and the amount leaves net worth` failed with
   `Cannot read properties of undefined (reading 'ok')`: `validateEventData` had no case
   for the unknown `OneTimeSpendEvent`, so it returned `undefined`. **GREEN** — added the
   event type, union member, `validateEventData` case, the handler (hard-block `check` +
   pure-outflow `apply`), the `oneTimeSpend` `FundingReason`, and its `spend` report
   prefix. Test passed; net worth dropped by exactly the spend.
2. Successive slices (hard-block on shortfall, one-cent gate, exact coverage, credit never
   a source, ordered multi-source drain and its reversal, `#122`-consistent reporting,
   taxed investment-funded net-worth drop, deterministic replay, clean undo). The taxed
   slice initially over-asserted an *exact* net-worth drop; corrected to compare against an
   identical no-tax run (a grossed-up draw leaves a smaller residual that compounds less, so
   the gap is the tax plus a growth delta — the same relaxation the Home Purchase suite uses).
3. App slices: `summarizeEvent` label (RED first — exhaustiveness compile error was the
   red for typecheck), then the `SpendForm` render tests.

Final: `12` engine tests + `1` new app label test + `3` `SpendForm` tests, all green;
whole suite `987 passed | 45 todo`.

## Key Decisions & Why

- **Reuse the reason-blind funding channel, don't fork it.** `state.fundingDraws` +
  `resolveFundingDraws` already drain ordered sources, gross up over capital-gains tax,
  route the tax net-neutral through the single chokepoint, and emit the `savingsDrawdown` /
  realized-gain reporting bands — for *every* draw regardless of `reason`. So the AC3
  reporting requirement ("surface the draw as a savings drawdown and/or gain + returned
  principal, consistent with #122") **came for free** the moment the event pushed a
  `FundingDraw`. The only reason-specific addition is the `REPORT_PREFIX` entry that names
  the bands `spend:<account>` / `spend-tax:<account>`. `FundingReason` and `REPORT_PREFIX`
  are exhaustive-by-type, so a new reason without a prefix fails the typecheck rather than
  going silently unnamed.
- **No offsetting asset ⇒ the draw is the whole net-worth change.** Home Purchase pairs its
  draw with a property + mortgage that net to the price, so it conserves (minus tax). A
  One-Time Spend pairs its draw with *nothing*, so net worth falls by the spend (a cash
  source) or the spend plus the realized-gain tax (an appreciated source) — which is
  precisely what a real discretionary spend costs.
- **Same §4.5 gate as the down payment.** The `check` calls the shared, event-neutral
  `context.fundingAvailabilityAt(...)` capability — the identical after-tax "can these
  sources net this amount at this month?" question the down-payment block asks — so the gate
  blocks exactly when the simulator would fall short, under any tax regime, and the picker's
  coverage line can never promise what the engine will refuse.
- **Event shape from the issue:** `{ month, amountCents, fundingSourceIds: string[], label }`.
  `label` is the user's plain-language name; validated non-empty, amount validated positive,
  sources validated non-empty and distinct (a repeated id would double-drain one account) —
  mirroring the down payment's structural checks.
- **UI: reuse the `#156` ordered `FundingSourcePicker`.** The form is `HomePurchaseForm`
  minus price/mortgage/DTI: month + "what for" + amount + the same ordered source picker,
  reading the same `fundingLookup` the engine gates on. No new hard-block UX was needed —
  the shared `conflict` red-alert path in `main.tsx` surfaces the block message already.

## Changes Made

**Engine**
- `ledger/eventTypes.ts` — new `OneTimeSpendEvent` interface; added to the `LifeEvent`
  union (hence `NewLifeEvent`, and the app-facing `export *`).
- `ledger/transfers.ts` — `FundingReason` gains `"oneTimeSpend"`.
- `projection/fundingDrawStep.ts` — `REPORT_PREFIX` gains `oneTimeSpend: "spend"`.
- `ledger/eventValidation.ts` — `validateEventData` case: positive amount, non-empty
  distinct sources, non-empty label.
- `ledger/eventHandlers.ts` — `oneTimeSpend` handler: `check` runs the shared hard-block
  gate; `apply` pushes a `FundingDraw` with `reason: "oneTimeSpend"` and originates no
  asset. Registered in the exhaustive `HandlerRegistry`.

**App**
- `ledgerView.ts` — `summarizeEvent` case → label **"One-time spend"** with `label, $amount`.
- `components/addEventForm/spendForm.tsx` — new `SpendForm`, reusing `FundingSourcePicker`.
- `components/addEventForm/addEventForm.tsx` — menu entry **"Made a one-time spend"** wired
  to `SpendForm` with the existing `funding` prop.

**Tests**
- `engine/src/events.oneTimeSpend.test.ts` (new, 12 tests).
- `app/src/components/addEventForm/spendForm.test.tsx` (new, 3 tests).
- `app/src/ledgerView.test.ts` — one added label test.

## Verification & Testing

- `npm run check:purity` → engine purity passed (no I/O, no app/rules imports).
- `npm run typecheck` → clean (exhaustive switches over `LifeEvent` forced every new case).
- `npx vitest run` → **987 passed | 45 todo (1032)** across 83 files, zero regressions.

### Acceptance criteria

- [x] Drains ordered sources and hard-blocks on shortfall (cash-only; credit never a source).
- [x] The amount leaves net worth; totals conserved (cash: −amount; investment: −amount−tax).
- [x] Funding draw surfaces as a savings drawdown (cash) and/or gain + returned principal
      (investment), consistent with #122.
- [x] A UI form authors it; round-trips through the ledger (deterministic replay + undo).

## Notes for the next iteration

- Opt-in soft-cascade of an uncovered spend onto credit is deferred to **#128** — today a
  shortfall is a clean hard block.
- The `SpendForm` and `HomePurchaseForm` now share the picker but still duplicate the
  month-prune / pool / availability derivation. A `useFundingDraft` hook could deepen both,
  but that would touch `HomePurchaseForm` (out of this issue's scope) — left for a
  dedicated refactor.
