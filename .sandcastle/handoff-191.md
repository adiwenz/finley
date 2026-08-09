# Handoff — issue 191 (Credit is an authored funding source)

Whole-issue mode: no declared tasks. I split it into parts and am landing them
green one at a time. Read `gh issue view 191` and `docs/projection-blocking-design.md`
§6–§7 for the spec.

**My breakdown (whole issue):**
1. **Eligibility seam** — DONE (this commit). `getEligibleFundingSources` now admits credit
   cards for `expense`, excludes them for `asset-acquisition`.
2. **Credit funding primitive** — TODO. Widen the ordered draw so a `credit` source borrows
   against headroom (`availableCredit = creditLimit − balance`, clamp ≥0) with no sale, no
   basis, no tax; `perSource` gains a `kind`. See design §7 ("Widen `resolveOrderedFundingDraw`
   to a discriminated source"). This is called out as the riskiest change in the epic.
3. **Failure / availability reporting** — TODO. Credit in `alternativeSources` for an
   `expense` (never `asset-acquisition`); availability = remaining headroom, no gross-up; no
   capital-gains tax introduced. `fundingLookup.sourcesAt` must report a card's headroom
   (`limit − balance`) from `liabilityBalancesCents`, not an asset balance.
4. **Simulator execution** — TODO. A credit draw increases the corresponding liability balance
   (the borrow IS the funding action — no cash minted first). Skip the synthetic shortfall card
   (`SYNTHETIC_CARD_ID`) as a pickable source everywhere.
5. **UI** — TODO. Picker offers credit for expenses only, greys a card whose headroom cannot
   cover the draw (like a $0 account) and one with no entered limit, and makes the borrowing
   consequence clear. `packages/app/src/components/addEventForm/fundingSourcePicker.tsx`,
   `fundingView.ts`.

## Live constraints
- `EligibilityCandidate` gained an optional `credit?: boolean` (absent → asset account), so
  existing asset-only candidate literals still typecheck. A credit card has `liquid: false`;
  `credit: true` is the flag that admits it. Parts 2–5 must set `credit` on card candidates
  when building eligibility pools (`fundingFailure.ts` `EligibleAccountState`,
  `addEvent.ts`/`fundingLookup`, `fundingDrawStep.ts` `accountPool`) — today those pools are
  built from asset accounts only and never include credit cards at all.
- The engine RECOMMENDS, never CHOOSES: no auto-adding/substituting credit as a fallback, no
  reordering. Credit executes only at the user's authored position, in one pass.
- `FundingSourceKind` in `resolvedFunding.ts` already carries `"credit"`; the attribution and
  flow-view plumbing (`fundingView.ts`) already handle a credit source. Reuse, don't duplicate.
- Explicit funding today exists ONLY for `asset-acquisition` (home-purchase down payment) —
  `resolveFundingDraws` filters `treatment === "asset-acquisition"`. There is no explicit
  *expense* funding authoring path yet (CONTEXT.md "One-Time Spend" describes it but it is
  unbuilt). Part 4/5 must confirm how an expense names credit sources; this may be the largest
  remaining piece.

## Dead ends
- (none yet)

## Deferred
- Nothing deferred out of scope yet; all five parts belong to this issue.
