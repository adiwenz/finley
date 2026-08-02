# Handoff — issue 175

**Done so far:** Task 1 (down payment as an explicitly-funded obligation) and Task 2 (reorder the month pipeline: explicit before automatic). Tasks 3–5 remain.

Note: #179's home-event decomposition has **not** landed on this branch — there is no `acquireAsset` primitive; the down payment is still emitted by the monolithic `HomePurchaseEvent` handler (`packages/engine/src/ledger/eventHandlers.ts` homePurchase.apply → `state.fundingDraws.push`). If #179 lands before a later task, move the obligation emission to `acquireAsset` as the issue directs.

## Live constraints
- **Resolution order is now explicit → automatic** in `simulate.ts` (`simulateHousehold` month loop): `resolveFundingDraws` runs BEFORE `buildWithdrawalSources`. Do not re-invert this. Explicit draws difference their gains over `buildTaxableByOwner(nonWithdrawalSources)` (decumulation has not run); decumulation stacks its gains on top via the new `priorTaxableByOwner` arg to `buildWithdrawalSources` (= `fundingDraw.taxableByOwnerAfter`).
- **Decumulation's gap is still sized on `netIncomeCents` from non-withdrawal income only** (`withdrawal.ts` `estimateNetIncome`). The new `priorTaxableByOwner` seeds ONLY the gross-up tax base, never the gap — explicit draws are net-neutral and must never move the gap. `priorTaxableByOwner` REPLACES the income-only base (it already contains non-withdrawal income); merging would double-count. Absent the arg (direct unit calls in `withdrawal.test.ts`, or a month with no explicit draw) behaviour is byte-identical to before, which is why no existing test moved.
- **The gate's exported base is already "after explicit draws, before decumulation"** — this is task 3's target and the reorder produced it for free: `flows.taxableByOwnerAfterFundingCents = fundingDraw.taxableByOwnerAfter`, now computed pre-decumulation (see the updated comment at `simulate.ts` ~line 222). Task 3's remaining work is NOT to change this value — it is to **add the gate == sim regression test** (a money-out event authored in a month that also has decumulation must predict exactly the sim's shortfall) and to confirm the gate at `addEvent.ts:99` reads it unchanged (it does — it consumes `taxableByOwnerAfterFundingCents` as-is). Keep the gate narrow: the tax its own sale induces, differenced over the base preceding it, never the month's whole bill.
- **gate == sim** (`resolveOrderedFundingDraw` shared by `ledger/addEvent.ts:123` and the sim) remains the load-bearing invariant. The reorder preserved it; the task-3 test locks it.
- The down-payment obligation is still deliberately **not** in the list passed to `buildFlows`/`reportFlows`/`fundedLiabilityPayments` (would create a new band / consume the automatic pool). Unchanged by task 2.
- Regression guard for "output identical": `packages/engine/src/events.homePurchase.test.ts` asserts exact `downpayment:brokerage` / `downpayment-tax` band names and amounts. Still green; task 5 updates it when bands re-key off `sourceId`+`treatment`.

## Traps
- **No existing tax test shifted, despite the issue predicting it would.** The current suite has NO fixture combining a down-payment draw with decumulation in the same month, so no capital-gains figures moved — the whole suite stayed green through the reorder. The interaction is now pinned by the new `describe("HomePurchaseEvent — explicit draw resolves before automatic decumulation")` in `events.homePurchase.test.ts`, which asserts the automatic obligation spills to the synthetic credit card (`SYNTHETIC_CARD_ID`) exactly because the explicit draw drained the shared account first. If task 3/4 adds a bracketed-jurisdiction fixture with both channels drawing appreciated accounts, THAT is where a capital-gains split figure will differ by order — build it fresh, do not expect an existing number to move.
- The shortfall in a decumulation month spills to the **synthetic credit card** (cascade), NOT to `isInsolvent`, whenever the synthetic card has room. `isInsolvent` only fires once the cascade is exhausted. Assert on `liabilityBalancesCents[SYNTHETIC_CARD_ID]` for the "financed the gap" outcome (and it carries one month of interest — bound it, don't pin the exact cent).

## Deferred
- Gate's marginal base + **gate == sim test** → task 3. Base value already correct (see Live constraints); add the test and confirm gate narrowness.
- Sibling explicit events resolve in event sequence → task 4. (`resolveFundingDraws` already threads a working base across siblings in ledger order; task 4 adds the coverage / any ordering guarantee.)
- Delete `FundingDraw`, `FundingReason`, `REPORT_PREFIX`, the tax-blind ordered-drain helper + its test; re-key bands off `sourceId`+`treatment` → task 5.

## Dead ends
- (none)
