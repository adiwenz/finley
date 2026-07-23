import type {
  Cents,
  WithdrawalTaxBasis,
  AccountReturnKind,
  ReturnTaxTreatment,
} from "@finley/engine";

/**
 * US-2026 investment-account tax policy (§5.3, #94) — the jurisdiction side of the two
 * seams the engine holds state for. The engine tracks each account's cost basis and
 * compounds its return; these functions own the CONSEQUENCE: how much of a withdrawal
 * is taxable, and whether a return is taxed as it accrues or deferred to withdrawal.
 * They read no live figures (no brackets, no year), so they are not year-parameterized;
 * the amounts they feed are taxed by {@link import("./federalTax").computeFederalTaxCents}.
 *
 * ⚠ Estimates, not advice; US single-filer simplification.
 */

/**
 * Return of capital (US): principal the owner already paid tax on comes back tax-free;
 * only the GAIN is taxable. Average-cost / pro-rata method — a draw returns basis in
 * proportion to how much of the balance is basis, so a partially appreciated account
 * books a constant gain fraction per draw. A basis-0 account (a pre-tax account, or any
 * balance with no recorded basis) returns the whole draw as gain — fully taxable, which
 * is exactly the pre-tax behavior. Monotone non-decreasing in `grossCents`, as the
 * engine's withdrawal gross-up loop requires.
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
 * How US-2026 taxes an account's return by its neutral kind: interest is ordinary income
 * booked at accrual; appreciation is deferred to a withdrawal, taxed there against basis
 * (see {@link taxableWithdrawalCents}). This is the accrual-vs-realization timing and
 * income categorization that #94 moved out of the engine and into `rules`.
 */
export function returnTaxTreatment(returnKind: AccountReturnKind): ReturnTaxTreatment {
  return returnKind === "interest" ? INTEREST_AT_ACCRUAL : APPRECIATION_DEFERRED;
}
