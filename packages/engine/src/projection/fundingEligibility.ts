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
 * the ACCOUNT, not the month — an emptied liquid account (or a maxed-out card) stays eligible and
 * is reported at its capacity so the picker's pool is stable across months. Whether a card can
 * actually cover a draw is a headroom question the picker greys out on, never an eligibility one.
 *
 * The two treatments differ in exactly one rule: an `expense` admits credit cards, an
 * `asset-acquisition` does not (no bank funds a down payment on a card). Retirement is illiquid
 * and excluded from both.
 */
export function getEligibleFundingSources<A extends EligibilityCandidate>(
  treatment: FundingTreatment,
  accounts: readonly A[],
): readonly A[] {
  switch (treatment) {
    case "expense":
      return accounts.filter((a) => a.liquid || a.credit === true);
    case "asset-acquisition":
      return accounts.filter((a) => a.liquid && a.credit !== true);
  }
}
