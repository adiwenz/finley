import type { Cents, WithdrawalContext, WithdrawalTaxBasis, ModelAssumption } from "@finley/engine";
import { taxableWithdrawalCents } from "./investmentTax";

/**
 * US early-withdrawal penalty (IRC §72(t)): an additional 10% tax on the TAXABLE amount of a
 * pre-tax retirement distribution taken before 59½ — layered on top of ordinary income tax,
 * never netted from it. Gated on `category === "ordinaryIncome"`, the withdrawal category
 * exclusive to a pre-tax account (`PRE_TAX_TAX_PROFILE`), so a brokerage sale or a Roth
 * (`taxExempt`) draw is never charged.
 *
 * `ctx.age` is a whole calendar-year figure (`year − birthYear`), so it cannot see a
 * half-birthday: comparing it against 59.5 charges every age up to and including 59 in full —
 * the calendar year a household turns 59 may already be past the real half-birthday for part of
 * it, so this rounds to the conservative side rather than silently under-pricing the risk this
 * seam exists to price.
 *
 * ⚠ Estimates, not advice. v1 scope: a flat 10%, no exception. Real law carves out the rule of
 * 55 (separation from service in or after the year turning 55), SEPP/72(t) substantially-equal-
 * periodic payments, disability, and several others — all unmodelled, so an early pre-tax draw
 * that would legally avoid the penalty is still priced as if it owed it.
 */
const EARLY_WITHDRAWAL_ACCESS_AGE = 59.5;
const EARLY_WITHDRAWAL_PENALTY_RATE = 0.1;

export const EARLY_WITHDRAWAL_PENALTY_ASSUMPTIONS: readonly ModelAssumption[] = [
  {
    id: "earlyWithdrawalPenalty",
    text:
      "A pre-tax retirement withdrawal before age 59½ is assumed to owe the IRS's flat 10% " +
      "additional tax on the whole taxable amount, with no exception modelled — the rule of " +
      "55, substantially-equal-periodic payments (SEPP/72(t)), disability, and other statutory " +
      "carve-outs are not applied, so an early draw that would legally avoid the penalty is " +
      "still priced as if it owed it.",
  },
];

export function earlyWithdrawalPenaltyCents(
  basis: WithdrawalTaxBasis,
  ctx: WithdrawalContext,
): Cents {
  if (basis.category !== "ordinaryIncome" || ctx.age >= EARLY_WITHDRAWAL_ACCESS_AGE) return 0;
  return Math.round(taxableWithdrawalCents(basis) * EARLY_WITHDRAWAL_PENALTY_RATE);
}
