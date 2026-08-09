# Slice #6f — Credit is an authored funding source (issue #191)

## Overview

Credit cards become an explicit, engine-recognised funding source: an obligation may name a card
alongside cash/brokerage accounts, and the funding engine executes that choice through the same
ordered machinery as any other source. Credit never appears because the engine silently borrows —
it participates only where the user placed it, and a shortfall on named sources blocks rather than
spilling onto an unnamed card.

The work landed in five green, self-contained commits (whole-issue mode, split by the agent):

1. **Eligibility seam** — `getEligibleFundingSources` admits credit for `expense`, excludes it for
   `asset-acquisition`.
2. **Credit funding primitive** — `resolveOrderedFundingDraw` takes a discriminated source; a
   credit source borrows against headroom, tax-free, in the one ordered pass.
3. **Failure classifier** — a blocked expense can offer an unselected card in `alternativeSources`,
   priced at headroom.
4. **Simulator execution** — a named credit source's borrow increases the card's liability.
5. **UI picker** — the funding-source picker lists eligible cards, greyed by headroom, debt made
   plain.

## Scope boundary with #178 (Slice #7 — One-Time Spend Event)

`#178` is a separate open issue that authors the `OneTimeSpendEvent` — the event that produces an
explicit *expense* obligation — and it **depends on #191**. #178's own text attributes the picker
extension to #191 and says an expense "may name a credit card among its sources (#191)". So #191
delivers the credit-aware **seams, engine machinery, and picker capability**; #178 builds the
expense-authoring surface that exercises them end-to-end.

Concretely, two pieces are deliberately left to #178 because they belong to the expense form it
owns and have no other consumer today (the picker is currently wired only to the home-purchase
form, which is `asset-acquisition` and credit-excluded):

- `fundingLookup.sourcesAt` / `availabilityAt` reporting and pricing credit cards for the expense
  pool. `sourcesAt` gained an optional `kind`/`limited` shape on `FundingSourceBalance` (below) so
  #178 can populate credit rows without another migration; the credit-headroom sourcing itself
  lands with #178's form.

Every #191 acceptance criterion is met and tested at the engine seam; the picker capability is
unit-tested directly.

## RGR verification details

Each part was written test-first (RED → GREEN), verified failing for the expected reason before
implementing:

- **Eligibility** (`fundingEligibility.test.ts`): RED — a credit candidate was excluded from the
  expense pool; GREEN after `expense` admits `liquid || credit`.
- **Primitive** (`fundingDrawStep.test.ts`, new): RED — a credit source delivered nothing (stub
  `continue`); GREEN after the borrow-against-headroom branch. Covers headroom clamping, the
  null-limit=unbounded default, one-pass account-then-credit order, and zero tax stacked.
- **Classifier** (`fundingFailure.test.ts`): RED — a card alternative was priced at its owed
  balance ($1k) instead of headroom ($9k); GREEN after `capacityOf`.
- **Simulator** (`simulate.creditFunding.test.ts`, new): RED — an explicit expense naming a card
  was not resolved at all (status ran-to-horizon instead of the expected borrow/block); GREEN after
  `resolveFundingDraws` resolved any explicit obligation and applied credit to the liability.
- **Picker** (`fundingSourcePicker.test.tsx`): RED — credit rows were indistinguishable and never
  greyed for no-limit; GREEN after the credit row rendering + `rowAriaLabel`.

## Key decisions & why

- **Optional discriminants over required ones.** `EligibilityCandidate.credit?`,
  `AccountFundingSource.kind?`, `FundingSourceBalance.kind?/limited?` are all optional so the many
  existing asset-only literals across the engine compile untouched — the change is additive, each
  commit green in isolation.
- **A credit source is priced by headroom, an account by balance.** `availableCredit = limit −
  owed`, clamped ≥0; a null limit is unbounded in the raw primitive but treated as *unavailable* in
  the classifier and picker (an unbounded card would trivially "fund" everything and could never
  block, making the coverage advice meaningless).
- **Borrow ≠ sale.** A credit draw books no basis, no gain, no tax, and no savings drawdown; it
  raises `liabilityBalances[card]`, and the card's existing interest/payment mechanics carry it
  forward. Net worth drops by the new debt.
- **One ordered pass, never reordered.** Account and credit sources walk the single authored list
  in `resolveOrderedFundingDraw`; a second pass would silently reorder `[visa, checking]` into
  assets-then-credit — the substitution this design exists to prevent.
- **Engine recommends, never chooses.** An explicit obligation whose named sources fall short
  blocks; the engine never borrows on an unnamed card. Proven by a sim test where an available card
  is left untouched.

## Changes made

Engine:
- `projection/fundingEligibility.ts` — `credit?` fact; `expense` admits cards, `asset-acquisition`
  does not.
- `projection/fundingDrawStep.ts` — `FundingSourceState` is now `AccountFundingSource |
  CreditFundingSource`; `resolveOrderedFundingDraw` borrows against credit headroom;
  `ResolvedFundingSource` gained `kind`; `resolveFundingDraws` resolves any explicit obligation,
  assembles credit sources from `state.liabilities` (excluding the synthetic card), applies a
  borrow to `liabilityBalances`, and classifies a block against a pool including real cards keyed on
  the obligation's treatment.
- `projection/fundingFailure.ts` — `EligibleAccountState` is a union; `classifyFundingFailure`
  prices each source at its `capacityOf` (account balance net of tax, card headroom tax-free) and
  offers unselected cards as expense alternatives.
- `projection/resolvedFunding.ts` — `ExplicitDrawSource`/`attributeExplicitObligation` carry
  `kind`, so a credit borrow attributes as `kind:"credit"` with no withdrawal breakdown.
- `ledger/interpretState.ts` — `FundingSourceBalance` gained `kind?`/`limited?` for the picker.

App:
- `components/addEventForm/fundingSourcePicker.tsx` — renders credit rows with the debt
  consequence, greys a maxed or limitless card, distinct aria-labels via `rowAriaLabel`.
- `components/addEventForm/addEventForm.module.css` — `.sourceNote` for the credit annotation.

## Verification & testing

`npm run check` green: engine-purity guard, `tsc --noEmit`, and **1784 tests passing** (45 todo).
New suites: `fundingDrawStep.test.ts` (5), `simulate.creditFunding.test.ts` (3); extended:
`fundingEligibility.test.ts`, `fundingFailure.test.ts`, `fundingSourcePicker.test.tsx`.
