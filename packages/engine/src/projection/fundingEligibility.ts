/**
 * The engine-owned funding-eligibility seam. Given an obligation's treatment and the household's
 * accounts, it returns the subset an obligation of that treatment may draw from. The UI never
 * re-implements this — the picker and the blocked-projection classifier both call here — so a
 * source the user can select is exactly a source the engine will count.
 *
 * Only the rules that exist today are encoded. Additional axes the originating PRD proposed
 * (account restrictions, minimum retained balances, withdrawal capability) have no representation
 * in the engine and are deliberately absent rather than stubbed, so nothing here implies a rule
 * the simulator does not enforce.
 */

/** The treatments that name their own funding sources; `debt-payment` is always the automatic waterfall. */
export type FundingTreatment = "expense" | "asset-acquisition";

/**
 * The one account fact eligibility reads: whether the source is a revolving credit line rather
 * than a holding of the household's own money. Absent → an ordinary asset account, so existing
 * asset-only candidates need no `credit` field.
 *
 * Deliberately NOT `liquid`. That flag means "eligible to receive net cash flow from the
 * allocation waterfall" ({@link import("../plan/simAccount").SimAccount.liquid}) — a
 * deposit-destination fact, unrelated to whether a holding can be converted to cash for a
 * purchase. Brokerage and retirement are both `liquid: false` yet both are perfectly spendable.
 */
export interface EligibilityCandidate {
  readonly credit?: boolean;
}

/**
 * The eligible subset of `accounts` for `treatment`, in input order. Membership is a property of
 * the ACCOUNT, not the month — an emptied account (or a maxed-out card) stays eligible and is
 * reported at its capacity so the picker's pool is stable across months. Whether a source can
 * actually cover a draw is a headroom/balance question the picker greys out on, never an
 * eligibility one.
 *
 * An `expense` admits every account the household owns plus every credit card — a one-time spend
 * can be paid from wherever the money sits. An `asset-acquisition` differs in exactly one respect:
 * no bank funds a down payment on a card, so credit is barred. Every account holding the
 * household's OWN money qualifies, brokerage and retirement included — a lender cares that funds
 * exist and can be traced, not that they were already sitting in cash.
 *
 * The tax on getting the money out is priced by {@link
 * import("./fundingDrawStep").resolveOrderedFundingDraw} per source, so a brokerage draw bears its
 * gain. An early-withdrawal PENALTY on a retirement draw is not modelled anywhere in the engine,
 * so a retirement-funded down payment reads slightly cheaper than it would really be.
 */
export function getEligibleFundingSources<A extends EligibilityCandidate>(
  treatment: FundingTreatment,
  accounts: readonly A[],
): readonly A[] {
  switch (treatment) {
    case "expense":
      return accounts;
    case "asset-acquisition":
      return accounts.filter((a) => a.credit !== true);
  }
}
