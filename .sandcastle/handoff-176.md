# Handoff — issue 176

**Done so far:** Task 1 (automatic-obligation attribution), Task 2 (explicit-obligation
attribution), Task 3 (full account-withdrawal breakdown on the automatic branch). Tasks 4–6 remain.

The engine emits `ResolvedFunding` records on `flows.resolvedFunding` for **every** obligation, and
account-funded sources on BOTH branches now carry `withdrawal` (gross/principal/gain/tax/net) with
`amountCents === withdrawal.netDeliveredCents`. Types and both builders live in
`packages/engine/src/projection/resolvedFunding.ts`: `resolveFundingAttribution` (automatic) and
`attributeExplicitObligation` (explicit). CONTEXT.md's "Funding attribution" entry (commit d038b43)
documents the derived-interpretation requirement.

## Live constraints
- **Behavior preservation is guarded** by `packages/app/src/presets.behaviorPreservation.test.ts`
  (FNV-1a digest of each preset's per-month money shape, excluding `resolvedFunding`). **If it
  breaks, a later task moved money it had no licence to — fix the code, not the baselines.**
- **Shared record shape is enforced by tests.** Explicit records are all `kind: "account"`, never
  `income`; automatic records never emit `account` sources they didn't draw. Consumers read `kind`,
  never parse ids. `resolvedFunding.test.ts` pins both branches through one flat list.
- **`obligationId` is identity, `sourceId` is a reporting namespace.** Records stay a flat array,
  never keyed by `sourceId`. Task 4's two same-`sourceId` `downpayment` draws in one month MUST stay
  distinct records — `attributeExplicitObligation` copies `obligation.id` → `obligationId` and
  `obligation.sourceId` → `sourceId` verbatim; do not derive one from the other. The pipeline
  already keeps them separate (see the two explicit records for `home-1`/`home-2` in the issue);
  task 4 is chiefly a *test* proving it, not new machinery.
- **`ResolvedFundingSource.withdrawal` is POPULATED for every liquidated account source** — explicit
  draws (task 2) and automatic decumulation (task 3). It stays `undefined` only for the
  liquid-buffer drawdown, a cash spend that never passes through the withdrawal resolver. The five
  fields obey `gross = principal + gain` and `net = gross − tax` per source.
- **A split decumulation draw apportions its breakdown across obligations** via
  `apportionWithdrawal` in `resolvedFunding.ts` — cumulative-rounded on gross/gain from the running
  consumed-net, principal/tax derived, so slices sum back to the account's own totals with no drift.
  If a later task changes how a layer is consumed, keep that invariant.

## Dead ends / traps
- **Type-name collision:** `fundingDrawStep.ts` has its OWN local `ResolvedFundingSource` interface
  (the resolver's per-account result), distinct from `resolvedFunding.ts`'s exported one. Task 2
  avoided the clash by feeding a structural `ExplicitDrawSource[]` and NOT importing both into one
  module. Keep that seam.
- **`WithdrawalPlan.decumulationDraws` now carries the full breakdown** (task 3 extended it from
  `{sourceId, netDeliveredCents}` to the five-field `DecumulationDrawResult` in `withdrawal.ts`,
  reusing the `gross`/`gainCents`/`taxOnGross` the gross-up loop already computed). `simulate.ts`
  passes it straight into the `FundingSupplyPlan`.
- **nullJurisdiction has no return-of-capital policy**, so a decumulation draw under it books the
  WHOLE draw as `realizedGain` (principal 0), though untaxed (net == gross). This is why the
  `resolvedFunding.test.ts` decumulation case asserts gain 500 / principal 0, not gain 0. A
  jurisdiction with `taxableWithdrawalCents` (see the `capGainsTax`/`flatOrdinaryTax` test
  jurisdictions) is needed to exercise real basis recovery.
- **No repo prettier/eslint config.** Prettier's *default* flags every file including untouched
  ones — do NOT run `prettier --write`. The repo's `npm run check` is purity + typecheck + test.
- The four-layer automatic supply split lives in `simulate.ts`, not in `resolveFundingAttribution`
  (a pure distributor). Income is capped so a rounding drift can't make a layer attribute a
  negative — preserve that if you re-derive those amounts.
- True rationing (stopping low-priority payment) is out of scope permanently (issue's #22 note). An
  explicit shortfall does NOT cascade to credit yet (arrives in #191, per the forward note).

## Deferred
- Task 4: two same-`sourceId` explicit obligations in one month stay distinct records (test-led).
- Task 5: scenario coverage across funding mixes.
- Task 6: surface attribution in the UI (nothing UI-side exists yet).
