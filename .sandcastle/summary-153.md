# Issue #153 — HomePurchase: `downPaymentAccountId` → `downPaymentSourceIds[]`

## Overview

Part of the **#129 epic** (Home Purchase Funding & Goal Decoupling). Migrates the
Home Purchase event off a single down-payment account onto the shared, ordered
funding model introduced in #151.

`HomePurchaseEvent.downPaymentAccountId: string` becomes
**`downPaymentSourceIds: readonly string[]`** — an ordered list the engine drains in
order (earlier sources empty before later ones are touched). The event now:

- emits **multiple ordered down-payment draws** across the selected sources;
- **hard-blocks on shortfall** against the *selected* sources' combined balance
  (§4.5 gate rework), naming each source in the conflict;
- surfaces the draw in the diagnostic flow view **consistent with #122** — an
  investment source's realized **gain** as capital-gains income and its returned
  **principal** (plus any cash source's whole draw) as a **savings drawdown**.

The purchase still owns the asset→equity conversion (property + mortgage + the
down-payment outflow) and conserves net worth at the purchase month.

## Key architectural decision — a simulation-time funding-draw channel

The per-source split of the down payment is **balance-dependent**: with sources
`[A, B]` and a $60k payment, how much comes from each depends on A's and B's balances
at the purchase month. Those balances **do not exist during interpret/replay** (the
projection hasn't run), so the split cannot be pre-baked into per-account transfers as
the old single `AccountTransfer` was.

So the ledger records the **intent** and the **simulator resolves it**:

- New `FundingDraw` value type (`ledger/transfers.ts`): `{ month, amountCents,
  sourceIds[], reason }`.
- `homePurchase.apply` pushes a `FundingDraw` (was: one fixed `AccountTransfer`).
- Threaded through the model: `InterpretState.fundingDraws` → `Household.fundingDraws`
  → `HouseholdSimInput.fundingDraws` → `SimState.fundingDraws`.
- New per-month step `applyFundingDraws` (`projection/fundingDrawStep.ts`) drains the
  sources in order (flooring each at its balance, mirroring `drainSources`), mutates
  `assetBalances`/`basisByAccount` with the **same pro-rata basis return** the
  decumulation withdrawal and fixed asset transfers use, and returns report bands.

**Reporting is deliberately a separate channel** (the design's "does not come for
free" note): the gain band has `waterfallInflowCents: 0` — it is folded only into
`buildFlows`, never into allocation/tax. Routing the gain through the tax seam would
break the purchase's net-worth conservation (property + mortgage = price). This matches
#122, which is a **reporting** fix (band the sale as gain + returned principal), not a
change to what is taxed.

The §4.5 gate now validates only the **selected** sources: `LiquidBucket` gained an
`id`, the gate matches the selected `downPaymentSourceIds` against the liquid buckets
in the user's order and drains via the shared `drainSources` helper. A selected source
that is illiquid or empty contributes 0 (naturally excluding it, as before). The
`drained` total equals exactly the itemised buckets, so the message total and list
cannot disagree.

## RGR Verification Details

1. **Migration first (regression-guarded):** renamed the field across the type,
   handler, validation, `BuyHomeInput`, the app form, and existing fixtures; kept
   single-source behavior equivalent via the new channel. The pre-existing
   HomePurchase/snapshot/projectionRoot suites (49 tests) stayed green — the
   regression guard for the rename + channel swap.

2. **RED → GREEN for the net-new behaviors** (multi-source drain, shortfall naming,
   and reporting). RGR was verified concretely: temporarily removing the `buildFlows`
   wiring (`[...incomeSources, ...fundingDraw.gainSources]` and
   `+ fundingDraw.principalDrawdownCents`) made the two reporting tests **fail**
   (`2 failed | 19 passed`); restoring it returned all **21 passed**. The drain/gate
   tests observe behavior only the new funding-draw channel produces (multiple sources
   drained in order; conflict itemising selected sources).

## Changes Made

**Engine — ledger**

- `ledger/eventTypes.ts` — `HomePurchaseEvent.downPaymentAccountId` →
  `downPaymentSourceIds: readonly string[]`.
- `ledger/transfers.ts` — new `FundingDraw` type + `FundingReason`.
- `ledger/interpretState.ts` — `InterpretState.fundingDraws`; `LiquidBucket.id`;
  refreshed `liquidBucketsAt` doc.
- `ledger/eventHandlers.ts` — `homePurchase.check` now gates on the **selected**
  sources (drain + itemised conflict); `homePurchase.apply` emits a `FundingDraw`.
- `ledger/eventValidation.ts` — `downPaymentSourceIds` must be non-empty and distinct.
- `ledger/addEvent.ts` — `liquidBucketsLookup` includes the account `id`.
- `ledger/household.ts` / `ledger/interpret.ts` — carry `fundingDraws` onto the
  immutable `Household`.

**Engine — projection**

- `projection/fundingDrawStep.ts` — **new** `applyFundingDraws`: ordered drain +
  gain/principal report bands.
- `projection/simulate.types.ts` — `HouseholdSimInput.fundingDraws`.
- `projection/runState.ts` — `SimState.fundingDraws` + `initSimState` wiring.
- `projection/buildHouseholdInput.ts` — pass `household.fundingDraws`.
- `projection/simulate.ts` — call `applyFundingDraws` in the per-month loop; fold the
  gain bands and returned principal into `buildFlows`.

**Engine — API**

- `projectionRoot.ts` — `BuyHomeInput.downPaymentSourceIds`; `buyHome` passes it
  through.

**App**

- `components/addEventForm/homePurchaseForm.tsx` — submits
  `downPaymentSourceIds: ["savings"]` (the ordered multi-source picker is #156).

**Tests**

- `events.homePurchase.test.ts` — migrated fixtures/gate tests to the selected-source
  model; **added** ordered multi-source drain (+ order-reversal), multi-source
  shortfall naming, and cash-vs-investment reporting tests.
- `snapshot.test.ts`, `projectionRoot.test.ts` — fixtures updated to
  `downPaymentSourceIds`.

## Acceptance criteria

- [x] Home Purchase drains an ordered list of sources; multiple down-payment draws
  are emitted (verified via per-source balance drops and order-reversal).
- [x] A shortfall hard-blocks with a clear conflict message naming the selected
  sources and stating a total that equals the itemised list.
- [x] An investment-source draw realizes the gain (capital-gains income) and reports
  returned principal as a savings drawdown; a cash-funded draw reports as a savings
  drawdown — consistent with #122.
- [x] Tests cover a multi-source draw and a shortfall.

## Verification & Testing

- `npm run check:purity` — ✓ engine purity (no I/O, no app/rules imports).
- `npm run typecheck` — ✓ clean.
- `npx vitest run` — **914 tests green** (45 todo), 78 files. HomePurchase file: 21
  tests (16 migrated + 5 net-new AC coverage).

## Notes for the next iteration

- **#154 (One-Time Spend)** reuses this channel verbatim: emit a `FundingDraw` with a
  new `reason: "oneTimeSpend"` and the same gate + report wiring. (A pure outflow that
  leaves net worth, rather than converting to equity — but the drain + reporting are
  identical.)
- **#156 (funding-source picker UI)** replaces the hardcoded `["savings"]` in
  `homePurchaseForm.tsx` with the ordered eligible-source picker.
- The gain band is reporting-only (untaxed); if a future slice wants down-payment
  capital-gains tax, route the gain through the waterfall like the decumulation
  withdrawal — but reconcile the net-worth-conservation invariant first.
