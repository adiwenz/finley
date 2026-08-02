# Handoff — issue 176

**Done so far:** Task 1 (record attribution for automatically funded obligations). Tasks 2–6 remain.

The engine now produces `ResolvedFunding` records on `flows.resolvedFunding` for every
automatically-funded obligation, in cascade order (income → liquid drawdown → decumulation →
credit). Types are in `packages/engine/src/projection/resolvedFunding.ts`; the walk is wired in
`simulate.ts` (the block after `fundedObligationTotalCents`). CONTEXT.md's "Funding attribution"
entry already existed (prior slice, commit d038b43) and satisfies task 1's doc requirement.

## Live constraints
- **Behavior preservation is now guarded** by `packages/app/src/presets.behaviorPreservation.test.ts`.
  It hashes each preset's whole per-month money shape (balances/basis/liability/property/tax/
  net-worth/insolvency, excluding `resolvedFunding`) to an FNV-1a digest + anchors. The digests are
  genuine pre-slice values (verified by stashing the engine changes and re-capturing). **If this
  test breaks, a later task moved money it had no licence to — fix the code, do not update the
  baselines.** Baselines were captured under `usJurisdiction`.
- **Shared record shape (task 2 must match exactly).** Explicit obligations must emit the same
  `ResolvedFunding` shape and never emit an `income` source. `resolveFundingAttribution` currently
  filters to `funding.kind === "automatic"` and skips explicit ones — task 2 adds the explicit
  branch. Consumers must read `kind`, never parse ids.
- **`obligationId` is identity, `sourceId` is a reporting namespace.** Records are returned as a
  flat array (never keyed by `sourceId`) precisely so two obligations sharing a `sourceId` (task 4:
  two `downpayment` draws in one month) stay distinct. Do not introduce a `Map` keyed on `sourceId`.
- **`ResolvedFundingSource.withdrawal` is defined but left `undefined` by task 1** for decumulation
  and liquid-drawdown account sources. Task 3 populates it (gross/principal/gain/tax/net) and asserts
  `amountCents === netDeliveredCents`. The per-account net it needs is already exposed:
  `WithdrawalPlan.decumulationDraws` in `withdrawal.ts` (net delivered per liquidated account, in
  liquidation order). Task 3 extends that draw record with the gross/basis/gain/tax it discards today
  (all computed at `withdrawal.ts` ~line 229 as `gross`, `gainCents`, `taxOnGross`).

## Dead ends / traps
- The four-layer supply split lives in `simulate.ts`, not in `resolveFundingAttribution` (which is a
  pure distributor given a `FundingSupplyPlan`). Income is derived as
  `automaticFundingCents − preCascadeObligationShortfallCents − decumTotal`; credit is the residual
  to `fundedObligationTotalCents`. Income is `min`-capped so a capital-gains-tax rounding drift (the
  sizing pass leaves it in the liquid buffer to self-correct) can never make a layer attribute a
  negative. Validated: 20,661 records across all presets under `usJurisdiction` reconcile with zero
  negatives. If you re-derive these amounts, keep that invariant.
- True rationing (stopping low-priority payment) is out of scope permanently — see the issue's #22
  note. Every obligation stays fully funded until credit is genuinely exhausted; the leftover need on
  the lowest-priority lines IS the insolvency residual.

## Deferred
- Task 2: explicit-obligation attribution + assert Σ `fundedCents` reconciles with actual movements.
- Task 3: full withdrawal breakdown on account sources.
- Task 4: two same-purpose explicit obligations stay distinct.
- Task 5: scenario coverage across funding mixes.
- Task 6: surface attribution in the UI (nothing UI-side exists yet).
