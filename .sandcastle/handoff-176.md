# Handoff — issue 176

**Done so far:** Task 1 (automatic-obligation attribution) and Task 2 (explicit-obligation
attribution). Tasks 3–6 remain.

The engine emits `ResolvedFunding` records on `flows.resolvedFunding` for **every** obligation now,
not just automatic ones. The flat list is `[...explicit, ...automatic]` — explicit draws resolve
first in the month, so their records lead (see `simulate.ts`, the `resolvedFunding` concat). Types
and both builders live in `packages/engine/src/projection/resolvedFunding.ts`:
`resolveFundingAttribution` (automatic) and `attributeExplicitObligation` (explicit). The explicit
branch is driven from `fundingDrawStep.ts` off the resolver's own `perSource`, so the record is a
mirror of the balance moves in that same loop. CONTEXT.md's "Funding attribution" entry (prior
slice, commit d038b43) already documents the derived-interpretation requirement.

## Live constraints
- **Behavior preservation is guarded** by `packages/app/src/presets.behaviorPreservation.test.ts`
  (FNV-1a digest of each preset's per-month money shape, excluding `resolvedFunding`). **If it
  breaks, a later task moved money it had no licence to — fix the code, not the baselines.**
  Baselines captured under `usJurisdiction`.
- **Shared record shape is now enforced by tests, not just intent.** Explicit records are all
  `kind: "account"`, never `income`; automatic records never emit `account` sources they didn't
  draw. Consumers read `kind`, never parse ids. `resolvedFunding.test.ts` pins both branches
  through the one flat list — keep them shape-identical.
- **`obligationId` is identity, `sourceId` is a reporting namespace.** Records stay a flat array,
  never keyed by `sourceId`, so two obligations sharing a `sourceId` (task 4: two `downpayment`
  draws in one month) stay distinct. `attributeExplicitObligation` copies `obligation.id` verbatim
  as `obligationId` and `obligation.sourceId` as `sourceId` — do not derive one from the other.
- **`ResolvedFundingSource.withdrawal` is now POPULATED for explicit account sources** (task 2, off
  `perSource`: gross/principal/gain/tax/net, with `amountCents === withdrawal.netDeliveredCents`).
  It is still `undefined` for the automatic branch's decumulation and liquid-drawdown sources —
  that is task 3's remaining job. The per-account net task 3 needs is `WithdrawalPlan.decumulationDraws`
  in `withdrawal.ts`; task 3 must extend that draw record with the gross/basis/gain/tax it discards
  today (computed at `withdrawal.ts` ~line 229 as `gross`, `gainCents`, `taxOnGross`).

## Dead ends / traps
- **Type-name collision:** `fundingDrawStep.ts` has its OWN local `ResolvedFundingSource` interface
  (the resolver's per-account result), distinct from `resolvedFunding.ts`'s exported
  `ResolvedFundingSource` (the attribution source). Task 2 avoided the clash by NOT importing the
  latter into `fundingDrawStep.ts` — it imports only `attributeExplicitObligation` +
  `ResolvedFunding` and feeds a structural `ExplicitDrawSource[]`. Keep that seam; don't import both
  `ResolvedFundingSource`s into one module.
- The four-layer automatic supply split lives in `simulate.ts`, not in `resolveFundingAttribution`
  (a pure distributor). Income is capped so a capital-gains-tax rounding drift can't make a layer
  attribute a negative — if you re-derive those amounts, keep that invariant. (Validated: 20,661
  automatic records across presets reconcile with zero negatives.)
- True rationing (stopping low-priority payment) is out of scope permanently — issue's #22 note.
  An explicit obligation that falls short leaves the remainder as `shortfallCents`; it does NOT
  cascade to credit yet (that arrives in #191, per the issue's forward note). Automatic obligations
  stay fully funded until credit is genuinely exhausted; the leftover need on the lowest-priority
  lines IS the insolvency residual.

## Deferred
- Task 3: full withdrawal breakdown on the AUTOMATIC branch's account sources (decumulation +
  liquid drawdown); assert `amountCents === netDeliveredCents` there too.
- Task 4: two same-`sourceId` explicit obligations in one month stay distinct records.
- Task 5: scenario coverage across funding mixes.
- Task 6: surface attribution in the UI (nothing UI-side exists yet).
