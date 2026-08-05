# Handoff — issue 263

Whole-issue mode (no declared tasks). I split it into two green parts:

**Done (Part 1 — engine structural refactor):** The mortgage is now a dependent artifact embedded
in `HomePurchaseEvent.mortgage` (see `ledger/eventTypes.ts` `EmbeddedMortgage`), minted at interpret
by `homePurchase.apply` (`ledger/eventHandlers.ts`) via the shared `amortizingLiability` builder that
`loan.apply` also uses. `securedByLiabilityId` and its precondition are gone; authoring emits ONE
event (`authoring/housing.ts`); the `buyHome` revision recomputes `openingBalanceCents` from
price − down and carries `mortgageApr`/`mortgageTermMonths` (`authoring/revise.ts`). Both bugs are
covered: delete drops the mortgage + a payoff-stranding block (`events.homePurchase.test.ts`
`removeEvent — a financed home purchase`); revise re-derives the balance
(`facade/projectionFacade.transactions.test.ts`). Repo fully green: typecheck ✓, 1819 tests ✓, purity ✓.

**Remaining (Part 2 — app presentation, the LAST part → deletes this handoff + writes the summary):**
1. `packages/app/src/ledgerView.ts` — the `HomePurchaseEvent` case still shows only price/down. Fold
   the mortgage terms into the "Bought a home" detail (mortgage now absent ⇒ cash — say so).
2. The reviewer's issue comment: editing a pre-existing home must let you change the home value,
   the mortgage balance, AND the mortgage terms in ONE place. Today `homePurchaseForm.tsx` hides
   mortgage APR/term on edit and the `buyHome` revision drops them — that is now stale. Surface
   `mortgageApr`/`mortgageTermMonths` in the home form (add + edit) and route them through the single
   `buyHome` revision (the revision already accepts them). `existingHomeForm.tsx` authors `ownHome`;
   confirm its mortgage inputs still flow through.
3. Update the two app tests that pin the OLD "mortgage fields drop out" behavior:
   `components/addEventForm/subForms.test.tsx` — the test at ~line 276 asserts mortgage APR/Term are
   NOT rendered on a `buyHome` edit and that the revise call omits them. That assertion must flip.
   The standalone-`LoanEvent` `MORTGAGE` fixture / `LoanForm` mortgage-marker test (~line 234) may now
   be dead for purchases (purchases no longer emit a mortgage `LoanEvent`) — decide whether it still
   describes a real path.

## Live constraints
- Authoring input `BuyHomeInput` keeps FLAT `mortgageApr`/`mortgageTermMonths` (not an embedded
  object) — the EVENT embeds `mortgage`, the input does not. Deliberate: `openingBalanceCents` is
  DERIVED (price − down) and must never be author-settable, so embedding on the input would invite a
  caller to supply it. `BuyHomeEntry` (`input/scenarioInput.ts`) was left flat for the same reason;
  the ~6 app/engine scenario fixtures using flat `mortgageApr`/`mortgageTermMonths` still compile.
- Derived mortgage liability id is `` `${propertyId}-mortgage` `` (e.g. `home-1-mortgage`). Tests key
  `liabilityBalancesCents[...]` on that string.
- `mortgage` absent ⇒ cash purchase / owned outright ⇒ `property.mortgageLiabilityId === null`.

## Dead ends / traps
- No repo-wide lint/format tool — `npm run check` = purity + typecheck + test only.
- `projection/simulate.blocking.test.ts` hand-builds a `SimProperty` + `AmortizingLoan` at the sim
  layer with id `mtg1`; it is NOT event-driven and was correctly left untouched. Don't "fix" it.
- Whole-suite `vitest run` takes >2 min — run it in the background, not foreground.
