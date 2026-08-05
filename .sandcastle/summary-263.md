# Issue 263 — Store the purchase mortgage inside HomePurchaseEvent

## Overview

A financed home purchase used to be **two coupled ledger events**: a mortgage `LoanEvent` and a
`HomePurchaseEvent` naming it through `securedByLiabilityId`. That split caused two bugs — deleting
the purchase orphaned the mortgage, and editing price/down left the financed amount silently stale.

The mortgage now rides **inside** `HomePurchaseEvent.mortgage` as embedded terms, and the handler
mints the securing liability (`<propertyId>-mortgage`, `causedByEventId` = the purchase) as a
**dependent artifact**, re-derived on every interpret — the same pattern `ChildEvent` uses for its
cost stream. Both bugs disappear structurally: deleting the event drops the mortgage; revising the
event rebuilds it. `securedByLiabilityId`, its "securing liability not found" precondition, and the
mortgage-sorts-first ordering are gone. `LoanEvent`/`takeLoan`/`carryLoan` are untouched for
genuinely standalone debt.

## RGR Verification Details

Two red→green cycles drove the new behavior beyond the fixture migration:

- **Holding value/balance decoupling** (`facade/projectionFacade.transactions.test.ts`): a RED test
  authored an `ownHome` holding, revised its value, and asserted the mortgage balance stayed put.
  It failed ($240k balance jumped to the new $450k value) — a latent defect the first commit's
  blanket `price − down` recompute introduced for holdings. GREEN by branching the `buyHome`
  revision on `isPreExisting`: a holding carries/sets its balance via `mortgageBalanceCents`, a
  plan-time purchase still derives it. Verified against the live engine in the REPL first.
- **Ledger detail string** (`app/src/ledgerView.test.ts`): RED tests pinned the folded detail
  (`"$300,000, $60,000 down, $240,000 mortgage at 6.5%, 30 yr"`) and the cash case
  (`"$400,000, no mortgage"`) before the view was written.

The two epic bugs are covered directly: delete-drops-mortgage + a payoff-stranding block
(`ledger/events.homePurchase.test.ts`), and revise-re-derives-balance-and-terms
(`facade/projectionFacade.transactions.test.ts`). Net-worth conservation and the §4.5 down-payment
gate tests pass unchanged.

## Key Decisions & Why

- **Shared `amortizingLiability()` builder** (`ledger/eventHandlers.ts`): extracted from `loan.apply`
  and reused by `homePurchase.apply`, so the two handlers cannot drift on how a scheduled loan
  opens. The DRY moved from the *event* layer (compose two events) to a *function*.
- **Authoring inputs stay flat.** `BuyHomeInput`/`BuyHomeEntry` keep flat `mortgageApr`/
  `mortgageTermMonths` rather than an embedded object; only the *event* embeds `mortgage`. The
  financed `openingBalanceCents` is DERIVED and must never be author-settable — embedding on the
  input would invite a caller to supply it, and it kept the ~6 scenario fixtures stable.
- **Holding balance is decoupled from value.** A pre-existing home opens at its mortgage's current
  balance, independent of value, so the revision sets it explicitly (`mortgageBalanceCents`) while a
  plan-time purchase derives it. This is also what lets the home form edit value, balance, and terms
  in one place (the reviewer's note).
- **One event → one timeline row.** A financed purchase is now a single "Bought a home" marker with
  the mortgage folded into the detail, rather than a phantom second "Took out a loan" marker.

## Changes Made

Engine:
- `ledger/eventTypes.ts` — new `EmbeddedMortgage`; `HomePurchaseEvent.mortgage?` replaces
  `securedByLiabilityId`.
- `ledger/eventHandlers.ts` — `amortizingLiability()` shared builder; `homePurchase.apply` mints the
  derived mortgage and sets `mortgageLiabilityId`; securing-liability precondition removed.
- `authoring/housing.ts` — `applyHomePurchase`/`applyOwnHome` emit ONE event with embedded mortgage.
- `authoring/revise.ts` — `buyHome` revision carries mortgage terms, recomputes `openingBalanceCents`
  for a plan-time purchase, and sets it directly (`mortgageBalanceCents`) for a holding.
- `authoring/mint.ts` — `eventIds` drops the removed field (the mortgage id is derived).

App:
- `ledgerView.ts` — home-purchase detail folds in the mortgage terms (`formatApr`), or "no mortgage".
- `components/addEventForm/homePurchaseForm.tsx` — edits the embedded mortgage (balance for a
  holding, rate, term) through the single `buyHome` revision.
- `existingHomeForm.tsx` — unchanged; already authors `ownHome` with an embedded mortgage.

Fixtures migrated across `events.homePurchase`, `preExisting`, `snapshot`, `retirementSolver`,
`projectionFacade(.run/.test/.transactions)`, `fromInput`, and app `subForms`/`ledgerView` tests.

## Verification & Testing

`npm run typecheck` ✓ · `npm run check:purity` ✓ · **1822 tests green** (128 files, 45 todo).
