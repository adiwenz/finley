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

/** The single account fact eligibility reads today. A later slice admits credit cards for `expense`. */
export interface EligibilityCandidate {
  readonly liquid: boolean;
}

/**
 * The eligible subset of `accounts` for `treatment`, in input order. Membership is a property of
 * the ACCOUNT, not the month — an emptied liquid account stays eligible (and is reported at $0)
 * so the picker's pool is stable across months.
 *
 * Both current treatments admit exactly the liquid asset accounts: retirement is illiquid and so
 * excluded, and no bank funds a down payment on a card, so `asset-acquisition` would exclude
 * credit even once cards exist. Credit joins the `expense` branch in a later slice; the switch is
 * where that rule lands, which is why the two cases are spelled out despite sharing a body today.
 */
export function getEligibleFundingSources<A extends EligibilityCandidate>(
  treatment: FundingTreatment,
  accounts: readonly A[],
): readonly A[] {
  switch (treatment) {
    case "expense":
    case "asset-acquisition":
      return accounts.filter((a) => a.liquid);
  }
}
