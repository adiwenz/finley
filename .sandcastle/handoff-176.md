# Handoff — issue 176

**Done so far:** Task 1 (automatic-obligation attribution), Task 2 (explicit-obligation
attribution), Task 3 (full account-withdrawal breakdown on the automatic branch), Task 4 (guard test
proving two same-`sourceId` explicit obligations in one month stay distinct records). Tasks 5–6
remain.

The engine emits `ResolvedFunding` records on `flows.resolvedFunding` for **every** obligation, and
account-funded sources on BOTH branches now carry `withdrawal` (gross/principal/gain/tax/net) with
`amountCents === withdrawal.netDeliveredCents`. Types and both builders live in
`packages/engine/src/projection/resolvedFunding.ts`: `resolveFundingAttribution` (automatic) and
`attributeExplicitObligation` (explicit). CONTEXT.md's "Funding attribution" entry documents the
derived-interpretation requirement.

## Live constraints
- **Behavior preservation is guarded** by `packages/app/src/presets.behaviorPreservation.test.ts`
  (FNV-1a digest of each preset's per-month money shape, excluding `resolvedFunding`). **If it
  breaks, a later task moved money it had no licence to — fix the code, not the baselines.**
- **Shared record shape is enforced by tests.** Explicit records are all `kind: "account"`, never
  `income`; automatic records never emit `account` sources they didn't draw. Consumers read `kind`,
  never parse ids. `resolvedFunding.test.ts` pins both branches through one flat list.
- **`obligationId` is identity, `sourceId` is a reporting namespace.** Records stay a flat array,
  never keyed by `sourceId`. Task 4's test (`keeps two same-purpose explicit obligations in one
  month as distinct records` in `resolvedFunding.test.ts`) pins this: two `downpayment` draws in one
  month yield two records with distinct `obligationId`s, each retaining its own requested/funded/
  shortfall/sources. The per-draw loop in `fundingDrawStep.ts:214` pushes one record per obligation
  into a flat array — do NOT introduce any keying/dedup on `sourceId` there or in `simulate.ts`.
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
- **`WithdrawalPlan.decumulationDraws` carries the full breakdown** (task 3 extended it from
  `{sourceId, netDeliveredCents}` to the five-field `DecumulationDrawResult` in `withdrawal.ts`).
  `simulate.ts` passes it straight into the `FundingSupplyPlan`.
- **nullJurisdiction has no return-of-capital policy**, so a decumulation draw under it books the
  WHOLE draw as `realizedGain` (principal 0), though untaxed (net == gross). The `resolvedFunding`
  decumulation case asserts gain 500 / principal 0. Use a jurisdiction with a real tax profile (the
  `flatOrdinaryTax` fixture / `PRE_TAX_TAX_PROFILE` in `resolvedFunding.test.ts`) to exercise basis
  recovery and non-zero tax.
- **No repo prettier/eslint config.** Prettier's *default* flags every file including untouched
  ones — do NOT run `prettier --write`. The repo's `npm run check` is purity + typecheck + test.
- The four-layer automatic supply split lives in `simulate.ts`, not in `resolveFundingAttribution`
  (a pure distributor). Income is capped so a rounding drift can't make a layer attribute a
  negative — preserve that if you re-derive those amounts.
- True rationing (stopping low-priority payment) is out of scope permanently (issue's #22 note). An
  explicit shortfall does NOT cascade to credit yet (arrives in #191, per the forward note).

## Deferred
- Task 5: scenario coverage across funding mixes (the issue's acceptance breadth — a month mixing
  income/drawdown/decumulation/credit across automatic AND explicit obligations at once).
- Task 6: surface attribution in the UI (nothing UI-side reads `flows.resolvedFunding` yet). The
  UI must show each explicit purchase independently even when several share one month + `sourceId`
  (task 4's invariant is what makes that possible) and expose withdrawal details per account source.
