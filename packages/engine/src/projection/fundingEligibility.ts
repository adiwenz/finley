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
 * The two account facts eligibility reads: whether it is a liquid asset account, and whether it is
 * a revolving credit line. A credit card is never `liquid` (it is a liability, not a spendable
 * asset), so `credit` is the separate flag that admits it to the `expense` branch. Absent → an
 * ordinary asset account, so existing asset-only candidates need no `credit` field.
 */
export interface EligibilityCandidate {
  readonly liquid: boolean;
  readonly credit?: boolean;
}

/**
 * The eligible subset of `accounts` for `treatment`, in input order. Membership is a property of
 * the ACCOUNT, not the month — an emptied account (or a maxed-out card) stays eligible and is
 * reported at its capacity so the picker's pool is stable across months. Whether a source can
 * actually cover a draw is a headroom/balance question the picker greys out on, never an
 * eligibility one.
 *
 * An `expense` admits every account the household owns, illiquid ones (retirement, brokerage)
 * included, plus every credit card — a one-time spend can be paid from wherever the money sits.
 * An `asset-acquisition` is narrower: no bank funds a down payment on a card, and a lender wants
 * liquid, verifiable funds, so it admits only liquid, non-credit accounts. Retirement stays out of
 * an asset acquisition's pool for that reason.
 */
export function getEligibleFundingSources<A extends EligibilityCandidate>(
  treatment: FundingTreatment,
  accounts: readonly A[],
): readonly A[] {
  switch (treatment) {
    case "expense":
      return accounts;
    case "asset-acquisition":
      return accounts.filter((a) => a.liquid && a.credit !== true);
  }
}
