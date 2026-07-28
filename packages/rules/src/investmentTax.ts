import type {
  Cents,
  WithdrawalTaxBasis,
  AccountReturnKind,
  ReturnTaxTreatment,
} from "@finley/engine";

/**
 * US-2026 investment-account tax policy — the jurisdiction side of the two seams the engine
 * holds state for. The engine tracks cost basis and compounds returns; these own the
 * CONSEQUENCE: how much of a withdrawal is taxable, and whether a return is taxed at accrual
 * or deferred to withdrawal. They read no brackets or year, so they are not
 * year-parameterized; the amounts they feed are taxed by
 * {@link import("./federalTax").computeFederalTaxCents}.
 *
 * ⚠ Estimates, not advice; US single-filer simplification.
 */

/**
 * Return of capital (US): already-taxed principal comes back tax-free, only the GAIN is
 * taxable. Average-cost / pro-rata — a draw returns basis in proportion to the basis share of
 * the balance, so a partially appreciated account books a constant gain fraction per draw. A
 * basis-0 account (pre-tax, or any balance with no recorded basis) returns the whole draw as
 * gain, fully taxable — exactly the pre-tax behavior. Monotone non-decreasing in `grossCents`,
 * as the engine's withdrawal gross-up loop requires.
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

/**
 * Taxing a return by its neutral kind: interest is ordinary income booked at accrual;
 * appreciation defers to withdrawal, taxed there against basis
 * ({@link taxableWithdrawalCents}). Accrual-vs-realization timing and income categorization
 * live in `rules`, not the engine.
 */
export function returnTaxTreatment(returnKind: AccountReturnKind): ReturnTaxTreatment {
  return returnKind === "interest" ? INTEREST_AT_ACCRUAL : APPRECIATION_DEFERRED;
}
