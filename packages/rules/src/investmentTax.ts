import type {
  Cents,
  WithdrawalTaxBasis,
  AccountReturnKind,
  ReturnTaxTreatment,
} from "@finley/engine";

/**
 * US-2026 investment-account tax policy — the jurisdiction half of the seam: the engine tracks
 * cost basis and compounds returns, these decide how much of a withdrawal is taxable and
 * whether a return is taxed at accrual or deferred. No brackets or year are read, so they are
 * not year-parameterized; the amounts they feed are taxed by
 * {@link import("./federalTax").computeFederalTaxCents}.
 *
 * ⚠ Estimates, not advice; US single-filer simplification.
 */

/**
 * Return of capital (US): only the GAIN in a draw is taxable. Average-cost / pro-rata — basis
 * returns in proportion to its share of the balance. A basis-0 account (pre-tax, or any balance
 * with no recorded basis) returns the whole draw as gain. Monotone non-decreasing in
 * `grossCents`, as the engine's withdrawal gross-up loop requires.
 */
export function taxableWithdrawalCents(basis: WithdrawalTaxBasis): Cents {
  const { grossCents, basisCents, balanceCents } = basis;
  if (balanceCents <= 0 || basisCents <= 0) return grossCents;
  const basisFraction = Math.min(1, basisCents / balanceCents);
  const principalReturned = Math.min(basisCents, Math.round(grossCents * basisFraction));
  return grossCents - principalReturned;
}

/** Bank interest → ordinary income, taxed in the year it is credited (the 1099-INT). */
const INTEREST_AT_ACCRUAL: ReturnTaxTreatment = { taxAtAccrual: true, category: "ordinaryIncome" };
/** Capital appreciation → deferred; the gain is taxed at withdrawal against cost basis. */
const APPRECIATION_DEFERRED: ReturnTaxTreatment = { taxAtAccrual: false, category: "capitalGains" };

export function returnTaxTreatment(returnKind: AccountReturnKind): ReturnTaxTreatment {
  return returnKind === "interest" ? INTEREST_AT_ACCRUAL : APPRECIATION_DEFERRED;
}
