# Handoff — issue 175

**Done so far:** Task 1 (represent the down payment as an explicitly-funded obligation). Tasks 2–5 remain.

Note: #179's home-event decomposition has **not** landed on this branch — there is no `acquireAsset` primitive; the down payment is still emitted by the monolithic `HomePurchaseEvent` handler (`packages/engine/src/ledger/eventHandlers.ts` homePurchase.apply → `state.fundingDraws.push`). If #179 lands before a later task, move the obligation emission to `acquireAsset` as the issue directs.

## Live constraints
- **`assetAcquisitionObligation(draw)`** (`packages/engine/src/projection/financialObligation.ts`) is the representation seam introduced here: a `FundingDraw` → an `asset-acquisition`, `funding: explicit` obligation. `resolveFundingDraws` now derives the draw's amount + ordered source list from it (`fundingDrawStep.ts`). The raw `FundingDraw` record is still the ledger truth and still the ONLY carrier of `reason` → report-band prefix (`REPORT_PREFIX`, keyed on `FundingReason`). Task 5 retires the record and re-keys bands off the obligation's `sourceId`+`treatment` — until then band naming stays `reason`-based and band output must stay byte-identical.
- The obligation's `id`/`sourceId`/`label` are **provisional** (they key off `draw.reason`) and `priority`/`sourceKind` are inert — an explicit obligation never ranks in the automatic waterfall. Task 5 gives it real identity when it becomes the sole record.
- The down-payment obligation is deliberately **not** in the list passed to `buildFlows`/`reportFlows`/`fundedLiabilityPayments` — adding it there would create a new band / consume the automatic funded pool and break output-identical. If a later task surfaces it in that list, it must be excluded from `fundedLiabilityPayments`'s walk (it draws its own accounts, not the shared pool) and from the reported obligation bands, or output changes.
- **gate == sim** (`resolveOrderedFundingDraw` is shared by the §4.5 gate at `ledger/addEvent.ts:123` and the simulator) is the load-bearing invariant for tasks 2–4. The pipeline reorder in task 2 is what most easily breaks it.
- Regression guard for "output identical": `packages/engine/src/events.homePurchase.test.ts` asserts exact `downpayment:brokerage` / `downpayment-tax` band names and amounts. Keep it green through task 4; task 5 updates it when bands re-key.

## Dead ends
- (none yet)

## Deferred
- Reorder month pipeline (explicit before automatic) → task 2. Expect capital-gains figures in existing tax tests to shift; that diff is intentional.
- Gate's marginal taxable base "after explicit draws, before decumulation" + gate==sim test → task 3.
- Sibling explicit events resolve in event sequence → task 4.
- Delete `FundingDraw`, `FundingReason`, `REPORT_PREFIX`, the tax-blind ordered-drain helper + its test; re-key bands off `sourceId`+`treatment` → task 5.
