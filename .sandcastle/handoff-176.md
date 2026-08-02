# Handoff — issue 176

**Done so far:** Task 1 (automatic-obligation attribution), Task 2 (explicit-obligation
attribution), Task 3 (full account-withdrawal breakdown on the automatic branch), Task 4 (guard test
proving two same-`sourceId` explicit obligations in one month stay distinct records), Task 5
(scenario coverage across funding mixes). **Only Task 6 (surface attribution in the UI) remains.**

The engine emits `ResolvedFunding` records on `flows.resolvedFunding` for **every** obligation, and
account-funded sources on BOTH branches carry `withdrawal` (gross/principal/gain/tax/net) with
`amountCents === withdrawal.netDeliveredCents`. Types and both builders live in
`packages/engine/src/projection/resolvedFunding.ts`: `resolveFundingAttribution` (automatic) and
`attributeExplicitObligation` (explicit). CONTEXT.md's "Funding attribution" entry documents the
derived-interpretation requirement.

## Live constraints
- **Behavior preservation is guarded** by `packages/app/src/presets.behaviorPreservation.test.ts`
  (FNV-1a digest of each preset's per-month money shape, excluding `resolvedFunding`). **If it
  breaks, a later task moved money it had no licence to — fix the code, not the baselines.** Task 6
  is UI-only and must not touch engine money flow, so this must stay green untouched.
- **Shared record shape is enforced by tests.** Explicit records are all `kind: "account"`, never
  `income`; automatic records never emit `account` sources they didn't draw. Consumers read `kind`,
  never parse ids. The UI (task 6) must do the same — branch on `kind`, never on the id string.
- **`obligationId` is identity, `sourceId` is a reporting namespace.** Records are a flat array,
  never keyed by `sourceId`. Two same-`sourceId` explicit draws in one month yield two records with
  distinct `obligationId`s (pinned by `resolvedFunding.test.ts`). **The UI must show each purchase
  independently even when several share one month + `sourceId`** — aggregation, if any, is a
  deliberate reduce at the reporting layer, never an assumption that `sourceId` is unique.
- **`ResolvedFundingSource.withdrawal` is populated for every liquidated account source** — explicit
  draws and automatic decumulation. It is `undefined` only for the liquid-buffer drawdown (a cash
  spend that never passes the withdrawal resolver). The UI must render account details only when
  `withdrawal` is present. Five fields obey `gross = principal + gain` and `net = gross − tax`.

## Test coverage map (task 5)
`packages/engine/src/projection/resolvedFunding.test.ts` now covers all six issue scenarios through
the `flows.resolvedFunding` seam. Earlier tasks left four; task 5 added the remaining two:
- **Explicit purchase across multiple accounts** — one obligation, `orderedAccountIds` longer than
  the first account's balance, drains each account in ordered turn → one record, two `account`
  sources. This is the shape the UI must render for a single multi-account purchase.
- **Appreciated investment incurring capital-gains tax** — a `CAPITAL_GAINS_TAX_PROFILE` account is
  grown 12%/yr for a year (the sim never opens a post-tax account already appreciated, so the basis
  gap can ONLY come from compounding across months), then an explicit month-12 draw realizes a
  partial gain under a 25% cap-gains jurisdiction. Asserts genuine partial principal AND gain AND
  tax, distinct from the pre-tax whole-gain case. Fixtures: `flatCapitalGainsTax`,
  `appreciatingAccount`.

## Dead ends / traps
- **No opening-basis input.** `initSimState` (`runState.ts:126`) sets a post-tax account's basis to
  its opening balance; only compounding across months opens a basis-below-balance gap. Any future
  "appreciated account" fixture must grow the account and draw in a LATER month (draw resolves
  before `compoundAssets`, `simulate.ts:143` vs `:251`). A single-month horizon shows zero gain.
- **`proportionalFraction` transfers scale basis WITH balance** (`assetSteps.ts:17`), so they cannot
  manufacture an unrealized gain — do not reach for them to fake appreciation.
- **Type-name collision:** `fundingDrawStep.ts` has its OWN local `ResolvedFundingSource` (the
  resolver's per-account result), distinct from `resolvedFunding.ts`'s exported one. Keep the seam:
  feed a structural `ExplicitDrawSource[]`, don't import both into one module.
- **nullJurisdiction has no return-of-capital policy**, so a decumulation draw under it books the
  WHOLE draw as `realizedGain` (principal 0), though untaxed. Use a jurisdiction with
  `taxableWithdrawalCents` (`flatCapitalGainsTax` in the test, or the `flatOrdinaryTax`/
  `PRE_TAX_TAX_PROFILE` pair) to exercise basis recovery and non-zero tax.
- **No repo prettier/eslint config.** Prettier's *default* flags every file — do NOT run
  `prettier --write`. The gate is `npm run check` (purity + typecheck + test), all green as of task 5.
- True rationing (stopping low-priority payment) is out of scope permanently (issue's #22 note). An
  explicit shortfall does NOT cascade to credit yet (arrives in #191, per the forward note).

## Deferred
- **Task 6: surface attribution in the UI.** Nothing UI-side reads `flows.resolvedFunding` yet. Show
  each explicit purchase independently even when several share one month + `sourceId`, and expose
  the per-account `withdrawal` breakdown for account sources. This is the last task — its commit
  writes `.sandcastle/summary-176.md` and deletes this handoff. Invoke `/vercel-react-best-practices`
  for anything under `packages/app/src/`.
