# Handoff — issue 191 (Credit is an authored funding source)

Whole-issue mode: no declared tasks. I split it into parts and am landing them
green one at a time. Read `gh issue view 191` and `docs/projection-blocking-design.md`
§6–§7 for the spec.

**My breakdown (whole issue):**
1. **Eligibility seam** — DONE. `getEligibleFundingSources` admits credit cards for `expense`,
   excludes them for `asset-acquisition`.
2. **Credit funding primitive** — DONE. `resolveOrderedFundingDraw` now takes a discriminated
   `FundingSourceState` (`AccountFundingSource | CreditFundingSource`); a credit source borrows
   against headroom (`creditLimitCents − balanceCents`, clamp ≥0; null limit = unbounded), no
   sale/basis/gain/tax, stacks nothing on the owner base. `ResolvedFundingSource` gained a
   required `kind: "account" | "credit"` (credit sets `category: "taxExempt"`, gain/tax/… = 0).
3. **Failure classifier — credit alternatives** — DONE. `EligibleAccountState` is now a union
   (account | credit candidate); `classifyFundingFailure` prices each source at its *capacity*
   (account balance sold net of tax; card headroom = `limit − owed`, clamp ≥0, tax-free) via a
   `capacityOf` helper, drops zero/limitless-capacity sources, and offers an unselected credit
   card in `alternativeSources` for an `expense` (never `asset-acquisition` — eligibility already
   excludes it). NOTE: the classifier's *capability* is built and unit-tested, but no real caller
   feeds it credit yet — the account pools in `resolveFundingDraws` (`state.accounts`) and
   `addEvent.ts` `failureAt` (`liquidAccounts`) are still asset-only. Wiring credit candidates
   into those pools is part 4's job.
4. **Simulator execution** — DONE. `resolveFundingDraws` now resolves ANY explicit obligation
   (filter is `funding.kind === "explicit"`, treatment-agnostic — inert in production since only
   home purchases author explicit obligations today, but reachable for #178's one-time spend). It
   assembles credit `FundingSourceState` from `state.liabilities` (RevolvingCard, excluding
   `SYNTHETIC_CARD_ID`) with `balanceCents` = owed from `liabilityBalances`; a credit source's
   borrow INCREASES `state.liabilityBalances[card]` (no asset sold, no basis, no savings drawdown,
   no gain/tax band). The block classifier pool now includes real cards and passes the
   obligation's own treatment, so a stranded expense can name an unselected card as an alternative.
   `ExplicitDrawSource`/`attributeExplicitObligation` carry `kind` so a credit borrow attributes
   as `kind:"credit"` with no withdrawal breakdown. Proven end-to-end in
   `simulate.creditFunding.test.ts` via a constructed explicit-expense obligation.

   RESOLVED open question: One-Time Spend is a SEPARATE issue, **#178 (Slice #7)**, which depends
   on #191. #178 authors the `OneTimeSpendEvent` → explicit-expense obligation and owns the
   double-count/reporting/nudge. #191's job is the credit-aware seams + machinery (done in
   parts 1-4) plus the picker extension (part 5). Do NOT build the One-Time Spend event here.
5. **UI** — TODO. Extend the funding-source picker + `fundingLookup.sourcesAt` so eligible credit
   cards are listable for an EXPENSE only (never asset-acquisition — the down-payment form must
   stay cash/investment only), greyed when headroom cannot cover the draw (like a $0 account) and
   when a card has no entered limit, with the borrowing consequence made clear ("increases this
   card's debt"). Surface eligibility/availability from the engine, not re-derived in React.
   Files: `packages/app/src/components/addEventForm/fundingSourcePicker.tsx` (+ its test),
   `packages/app/src/fundingView.ts`, engine `fundingLookup.sourcesAt` (`addEvent.ts`) to report a
   card's headroom from `liabilityBalancesCents`. NOTE: the picker is only wired to
   homePurchaseForm today (asset-acquisition), so the credit rows are built ahead of #178's expense
   form — mirror parts 1-3's "seam ahead of consumer" and unit-test the picker directly. Invoke
   `/vercel-react-best-practices` for the TSX work.

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
