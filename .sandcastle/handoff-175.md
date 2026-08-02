# Handoff — issue 175

**Done so far:** Task 1 (down payment as an explicitly-funded obligation), Task 2 (reorder the month pipeline: explicit before automatic), Task 3 (gate's base follows the new order + gate == sim test). Tasks 4–5 remain.

Note: #179's home-event decomposition has **not** landed on this branch — there is no `acquireAsset` primitive; the down payment is still emitted by the monolithic `HomePurchaseEvent` handler (`packages/engine/src/ledger/eventHandlers.ts` homePurchase.apply → `state.fundingDraws.push`). If #179 lands before a later task, move the obligation emission to `acquireAsset` as the issue directs.

## Live constraints
- **Resolution order is explicit → automatic** in `simulate.ts` (`simulateHousehold` month loop): `resolveFundingDraws` runs BEFORE `buildWithdrawalSources`. Do not re-invert. Explicit draws difference gains over `buildTaxableByOwner(nonWithdrawalSources)`; decumulation stacks on top via `priorTaxableByOwner` (= `fundingDraw.taxableByOwnerAfter`).
- **Decumulation's gap is still sized on non-withdrawal income only** (`withdrawal.ts` `estimateNetIncome`). `priorTaxableByOwner` seeds ONLY the gross-up tax base, never the gap — explicit draws are net-neutral and must never move the gap.
- **The gate now reads the pipeline seam "after explicit draws, before decumulation" on BOTH axes** — tax base AND per-account balances/basis:
  - Tax base: `flows.taxableByOwnerAfterFundingCents` (task 2).
  - Balances/basis: `flows.accountBalancesAfterFundingCents` / `accountBasisAfterFundingCents` (task 3, captured in `simulate.ts` right after `resolveFundingDraws`). The gate reads these in `ledger/addEvent.ts` `availabilityAt` via `balanceOf`/`basisOf`, falling back to end-of-month maps only for the `opening` snapshot (month ≤ 0, already pre-decumulation). See `simulate.types.ts` `ProjectionMonthFlows` for the field contracts.
  - **Why this was needed (task 3 was NOT test-only, contra the previous handoff):** the reorder made the candidate resolve FIRST, so the gate must see balances *before* decumulation drains them and *before* this month's contributions/compounding post — the exact seam the draw resolves at. The old gate read post-decumulation end-of-month balances and mis-priced the shortfall. This is the balance half of "the gate's marginal base must follow the new order."
- **gate == sim** (`resolveOrderedFundingDraw`, shared by `ledger/addEvent.ts` and the sim) is the load-bearing invariant. Locked by `events.homePurchase.test.ts` describe `"§4.5 gate == sim across a decumulation month"`.
- The down-payment obligation is still deliberately **not** in the list passed to `buildFlows`/`reportFlows`/`fundedLiabilityPayments`. Unchanged.

## Traps
- **A candidate's OWN untaxed gain does NOT seed the month's allocation tax base.** In `fundingDrawStep.ts` a draw's tax source is emitted only when `s.taxCents > 0`, so a candidate whose marginal gain sits under a threshold contributes its gain to `taxableByOwnerAfter` (pricing later draws/decumulation) but NOT to `allocateMonth`'s tax. Consequence for test design: to force a taxed decumulation month you must make **decumulation's own** gain cross the threshold — you cannot rely on the candidate's sub-threshold gain to push it over. The task-3 test uses a large appreciated `nest` for exactly this.
- **The gate reads the PRE-contribution, PRE-compounding balance** (the draw resolves at pipeline step 1, before `allocateMonth` contributions and `compoundAssets`). A money-out event for a fund still filling toward its target is priced on what has posted so far, not the end-of-month figure. `projectionFacade.test.ts` "names the events a goal's fund account pays for" had its down payment lowered $10k→$9k for exactly this (reason recorded inline) — the $10k used to pass on a balance the draw never reaches.
- **No existing capital-gains figure moved through tasks 2–3.** The suite has no fixture combining a down-payment draw with decumulation on appreciated accounts in one month, so nothing shifted; the interaction is pinned only by the new tests. If task 4 adds a bracketed-jurisdiction fixture with both channels drawing appreciated accounts, THAT is where a split figure will differ by order — build it fresh, do not expect an existing number to move.
- Shortfall in a decumulation month spills to the **synthetic credit card** (cascade), NOT to `isInsolvent`, whenever the card has room. Assert on `liabilityBalancesCents[SYNTHETIC_CARD_ID]` (+ one month interest — bound it, don't pin the cent).
- Regression guard for "output identical": `events.homePurchase.test.ts` asserts exact `downpayment:brokerage` / `downpayment-tax` band names and amounts. Task 5 updates it when bands re-key off `sourceId`+`treatment`.
- The picker pool `sourcesAt` in `addEvent.ts` still reads end-of-month `accountBalancesCents` (display only, not the affordability verdict) — left as-is on purpose; `availabilityAt` is the gate.

## Deferred
- **Task 4** — Sibling explicit events resolve in event sequence, the second funded from what the first left. `resolveFundingDraws` already threads a working base and drains balances across siblings in ledger order, and `accountBalancesAfterFundingCents` (task 3) already captures the post-all-explicit-draws state a later sibling would see. Task 4 adds the coverage / any explicit ordering guarantee.
- **Task 5** — Delete `FundingDraw`, `FundingReason`, `REPORT_PREFIX` (in `fundingDrawStep.ts`), and the tax-blind ordered-drain helper `drainSources` (`ledger/funding.ts`) + its test `ledger/funding.test.ts`. Re-key report bands off the obligation's `sourceId`+`treatment` (band output unchanged). The tax-aware `resolveOrderedFundingDraw` and the fixed-amount account transfer both survive untouched.

## Dead ends
- (none)
