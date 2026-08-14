/**
 * **What the money has to answer for once the last member dies.**
 *
 * During life, federal income tax is paced monthly against a year-start estimate and reconciled in
 * the following April ({@link import("./taxYearSettlement")}). Death ends that cycle mid-stream: a
 * household that dies in October never reaches the April that would have settled the year, and the
 * projection has no month left in which to charge it. This module answers the question that
 * replaces it — *were the estate's own assets enough to pay the final tax and the debts left
 * behind?* — and answers it by arithmetic on the terminal state alone. Nothing is sold, no
 * balance moves, no month is simulated, and the run's net worth is untouched.
 *
 * The alternative, tried and removed, was to force the outstanding balance through the monthly
 * funding waterfall in the final month. That waterfall reaches retirement accounts, so paying the
 * tax realized more ordinary income, which owed more tax, which sold more of the account: a
 * fixed-point climb existing only because the horizon had no next year to hand the consequence
 * to. Under a beneficiary designation the climb is not merely awkward, it is wrong — the account
 * never belonged to the estate to spend.
 *
 * **Two pools, never conflated.** {@link EstateSettlement.estateAssetsCents} is what can pay the
 * final tax and the outstanding debts; {@link EstateSettlement.beneficiaryRetirementAssetsCents}
 * is what passes to beneficiaries regardless. A household can die holding a large retirement
 * balance and still fail terminal solvency, and that is a real planning finding rather than a
 * modelling artifact.
 *
 * **Simplified by policy, not by jurisdiction.** Two assumptions are stated rather than derived:
 * inherited taxable holdings are valued at their death-date balance with no gain realized on
 * liquidation, and beneficiary-designated retirement accounts pass outside the estate. Both are
 * planning policy this engine owns; the only thing routed through the jurisdiction seam is the
 * tax calculation itself, which is the same annual pricing every other month uses.
 */

import type { Cents } from "../money/money";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction/jurisdiction";
import type { SimState } from "./runState";
import { annualFederalTax, NO_FEDERAL_TAX_PAID } from "./federalIncomeTax";
import { unsettledBalancesFromEarlierYearsCents } from "./taxYearSettlement";

/**
 * The estate, settled — every figure a terminal state, none of them a cash flow. Signed only where
 * a sign is meaningful: {@link finalTaxDueCents} and {@link finalTaxRefundCents} are the two
 * halves of one signed balance, exactly one of which is non-zero, and
 * {@link estateSurplusCents} is negative precisely when the estate is insolvent.
 */
export interface EstateSettlement {
  /** The final simulated month — the last month the household is alive. */
  readonly month: number;
  /**
   * Cash, taxable investments and any other estate-held account, at their death-date balances.
   *
   * A taxable investment holding is counted at that balance and NOT run through the withdrawal
   * seam, so liquidating it raises no capital-gains tax here: the simplified basis reset at death.
   * The reset is terminal-only — every sale made while the household was alive priced its gain
   * against the ordinary basis model.
   */
  readonly estateAccountsCents: Cents;
  /** Property at death-date appreciated value; the securing mortgage is an ordinary debt below. */
  readonly propertyValuesCents: Cents;
  /** A final-year overpayment, which the estate collects. Zero when tax is owed. */
  readonly finalTaxRefundCents: Cents;
  /** `estateAccounts + properties + finalTaxRefund` — the pool obligations are paid from. */
  readonly estateAssetsCents: Cents;
  /** A final-year underpayment, which the estate owes. Zero when a refund is due. */
  readonly finalTaxDueCents: Cents;
  /** Every modeled liability's balance at death, mortgages and revolving debt alike. */
  readonly outstandingDebtCents: Cents;
  /** `finalTaxDue + outstandingDebt`. */
  readonly estateObligationsCents: Cents;
  /** `estateAssets − estateObligations`. Negative is the shortfall, stated rather than absorbed. */
  readonly estateSurplusCents: Cents;
  /** `estateSurplusCents >= 0` — the terminal half of the retirement solver's feasibility test. */
  readonly isSolvent: boolean;
  /**
   * Beneficiary-designated retirement balances at death. Reported, never spent: excluded from
   * {@link estateAssetsCents}, and not a backstop when the estate falls short.
   */
  readonly beneficiaryRetirementAssetsCents: Cents;
}

/**
 * Every federal income-tax dollar accrued and unpaid at death, signed positive when owed.
 *
 * Two sources, and both are needed. The final year's own balance is `actual − paid`, priced off
 * the year's complete taxable income through the death month by the SAME annual call the year's
 * close uses, so the two cannot disagree. Ahead of it sits any balance a completed year parked
 * for an April the run never reached — a death in February leaves the whole prior year unsettled,
 * and that debt is as real as the final year's.
 *
 * The final year's parked balance, if December closed it, is deliberately skipped: it IS the first
 * term, and counting both would charge the estate twice.
 */
function finalTaxBalanceCents(
  state: SimState,
  jurisdiction: Jurisdiction,
  ctx: JurisdictionContext,
): Cents {
  let balance = unsettledBalancesFromEarlierYearsCents(state, ctx);
  for (const pid of state.personIds) {
    const key = `${pid}|${ctx.year}`;
    const base = state.taxableIncomeByPersonYear.get(key) ?? {};
    const paid = state.federalTaxPaidByPersonYear.get(key) ?? NO_FEDERAL_TAX_PAID;
    balance += annualFederalTax(jurisdiction, ctx, pid, base).totalCents - paid.totalCents;
  }
  return balance;
}

/**
 * Settle the estate against the terminal state. Pure: reads `state`, mutates nothing, and runs
 * once per projection — never per year, and never a second simulation pass.
 *
 * `ctx` is the FINAL month's tax year, since that is the year whose liability is being finalized.
 */
export function settleEstate(
  state: SimState,
  jurisdiction: Jurisdiction,
  ctx: JurisdictionContext,
  month: number,
): EstateSettlement {
  let estateAccountsCents = 0;
  let beneficiaryRetirementAssetsCents = 0;
  for (const account of state.accounts) {
    const balanceCents = state.assetBalances.get(account.id) ?? 0;
    if (account.beneficiaryDesignated) beneficiaryRetirementAssetsCents += balanceCents;
    else estateAccountsCents += balanceCents;
  }

  let propertyValuesCents = 0;
  for (const value of state.propertyValues.values()) propertyValuesCents += value;

  // Balances, not remaining scheduled payments: amortization stops at death, and what the estate
  // must clear is the principal outstanding on the day. The synthetic shortfall card is in here
  // like any other card — a household that financed its last years on credit still owes it.
  let outstandingDebtCents = 0;
  for (const balanceCents of state.liabilityBalances.values()) outstandingDebtCents += balanceCents;

  const taxBalanceCents = finalTaxBalanceCents(state, jurisdiction, ctx);
  const finalTaxDueCents = Math.max(0, taxBalanceCents);
  const finalTaxRefundCents = Math.max(0, -taxBalanceCents);

  const estateAssetsCents = estateAccountsCents + propertyValuesCents + finalTaxRefundCents;
  const estateObligationsCents = finalTaxDueCents + outstandingDebtCents;
  const estateSurplusCents = estateAssetsCents - estateObligationsCents;

  return {
    month,
    estateAccountsCents,
    propertyValuesCents,
    finalTaxRefundCents,
    estateAssetsCents,
    finalTaxDueCents,
    outstandingDebtCents,
    estateObligationsCents,
    estateSurplusCents,
    isSolvent: estateSurplusCents >= 0,
    beneficiaryRetirementAssetsCents,
  };
}
