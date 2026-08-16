/**
 * **What the money has to answer for once the last member dies.**
 *
 * During life, federal income tax is paced monthly against a year-start estimate and reconciled in
 * the following April ({@link import("./taxYearSettlement")}). Death ends that cycle mid-stream: a
 * household that dies in October never reaches the April that would have settled the year, and the
 * projection has no month left in which to charge it. This module answers what replaces it, by
 * arithmetic on the terminal state alone. Nothing is sold, no balance moves, no month is
 * simulated, and the run's net worth is untouched.
 *
 * The alternative, tried and removed, was to force the outstanding balance through the monthly
 * funding waterfall in the final month. That waterfall reaches retirement accounts, so paying the
 * tax realized more ordinary income, which owed more tax, which sold more of the account: a
 * fixed-point climb existing only because the horizon had no next year to hand the consequence
 * to. Under a beneficiary designation the climb is not merely awkward, it is wrong — the account
 * never belonged to the estate to spend.
 *
 * ## Two questions, and only one of them is the solver's
 *
 * **Was the household still ahead when it died?** — {@link
 * EstateSettlement.terminalEconomicNetWorthCents}: every asset it owned, minus every debt it owed,
 * minus the tax it had accrued and not paid. Beneficiary designations do not appear in it, because
 * a designation routes wealth, it does not create or destroy any. This is what the retirement
 * solver tests, and the only thing it tests at the terminal ({@link
 * import("../retirement/retirementSolver").planOutcome}).
 *
 * **Who actually gets paid out of what?** — the `probate*` fields: collateral answers for the debt
 * it secures, probate assets pay the remaining obligations, beneficiary-designated accounts pass
 * outside probate untouched, and an obligation the probate estate cannot cover is reported as
 * {@link EstateSettlement.unpaidObligationsCents} rather than charged to anyone. This is a
 * distribution report. It is deliberately downstream of feasibility, and nothing here decides
 * whether a retirement age works.
 *
 * Keeping them apart is the whole point. Judged on probate liquidity, a household that dies with
 * $1.4M in an IRA and a cent of unsettled tax "fails" while a poorer one holding the same wealth
 * in a taxable account passes — a beneficiary form deciding a retirement age. Judged on economic
 * net worth, the richer household is richer, which is the only defensible answer; where its heirs'
 * money sits is then reported separately, for the reader rather than the solver.
 *
 * **Simplified by policy, not by jurisdiction.** Three assumptions are stated rather than derived:
 * inherited taxable holdings are valued at their death-date balance with no gain realized on
 * liquidation; beneficiary-designated retirement accounts pass outside probate; and a mortgage is
 * secured by the property naming it ({@link import("./simulate.types").SimProperty.mortgageLiabilityId}),
 * with any balance beyond the collateral's value dropping to an ordinary unsecured claim. All
 * three are planning policy this engine owns; the only thing routed through the jurisdiction seam
 * is the tax calculation itself, which is the same annual pricing every other month uses.
 */

import type { Cents } from "../money/money";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction/jurisdiction";
import type { SimState } from "./runState";
import { annualFederalTax, NO_FEDERAL_TAX_PAID } from "./federalIncomeTax";
import { unsettledBalancesFromEarlierYearsCents } from "./taxYearSettlement";

/**
 * The terminal state, settled — every figure a stock, none of them a cash flow. Signed only where
 * a sign is meaningful: {@link finalTaxDueCents} and {@link finalTaxRefundCents} are the two
 * halves of one signed balance, exactly one of which is non-zero, and
 * {@link terminalEconomicNetWorthCents} is negative precisely when the household died behind.
 */
export interface EstateSettlement {
  /** The final simulated month — the last month the household is alive. */
  readonly month: number;

  // ── Economic position: what the solver tests ──────────────────────────────────────────────

  /**
   * Every asset the household held at death, at death-date values: all accounts —
   * beneficiary-designated retirement included — plus all property.
   *
   * A taxable investment holding is counted at its balance and NOT run through the withdrawal
   * seam, so liquidating it raises no capital-gains tax here: the simplified basis reset at death.
   * The reset is terminal-only — every sale made while the household was alive priced its gain
   * against the ordinary basis model.
   */
  readonly totalAssetsCents: Cents;
  /**
   * Every modeled liability's balance at death, mortgages and revolving debt alike — secured and
   * unsecured together, because economically the household owes all of it.
   *
   * Balances, not remaining scheduled payments: amortization stops at death, and what is owed is
   * the principal outstanding on the day. The synthetic shortfall card is in here like any other
   * card — a household that financed its last years on credit still owes it, and that is exactly
   * what stops "borrow and spend it" from buying a feasible retirement.
   */
  readonly totalDebtCents: Cents;
  /** A final-year underpayment, accrued and unpaid at death. Zero when a refund is due. */
  readonly finalTaxDueCents: Cents;
  /** A final-year overpayment, still collectible at death. Zero when tax is owed. */
  readonly finalTaxRefundCents: Cents;
  /**
   * `totalAssets + finalTaxRefund − totalDebt − finalTaxDue` — the household's economic position
   * on the day it died, ignoring who inherits what.
   *
   * Equal to the final month's `netWorthNominalCents` adjusted for the tax balance the projection
   * had no month left to charge, and equal to it exactly when that balance is zero.
   */
  readonly terminalEconomicNetWorthCents: Cents;
  /**
   * `terminalEconomicNetWorthCents >= 0` — the terminal half of the retirement solver's
   * feasibility test, and the whole of it. No tolerance: a shortfall is a shortfall, and the
   * remedy for a rounding-sized one is to stop producing it, not to round it away here.
   */
  readonly isEconomicallySolvent: boolean;

  // ── Composition of those assets ───────────────────────────────────────────────────────────

  /** Cash and taxable investments — the accounts that pass through probate. */
  readonly estateAccountsCents: Cents;
  /**
   * Beneficiary-designated retirement balances at death. Inside {@link totalAssetsCents} because
   * the household owned them; outside {@link probateAssetsCents} because their beneficiaries take
   * them directly, ahead of any creditor of the estate.
   */
  readonly beneficiaryRetirementAssetsCents: Cents;
  /** Property at death-date appreciated value, gross of the mortgage securing it. */
  readonly propertyValuesCents: Cents;

  // ── Distribution: who actually gets paid ──────────────────────────────────────────────────

  /** Balances owed on loans secured by property the household still held — its mortgages. */
  readonly securedDebtCents: Cents;
  /** Of {@link securedDebtCents}, the part the collateral covers: Σ min(value, balance). */
  readonly collateralAppliedCents: Cents;
  /** Secured balance the collateral did not cover — an underwater mortgage, now unsecured. */
  readonly securedDeficiencyCents: Cents;
  /** Debt no surviving collateral answers for, plus any {@link securedDeficiencyCents}. */
  readonly unsecuredDebtCents: Cents;
  /** `estateAccounts + finalTaxRefund + equity in property` — the pool creditors can reach. */
  readonly probateAssetsCents: Cents;
  /** `finalTaxDue + unsecuredDebt` — what those assets are asked to pay. */
  readonly probateObligationsCents: Cents;
  /** `probateAssets − probateObligations`. Negative means creditors go short. */
  readonly probateSurplusCents: Cents;
  /**
   * What the probate estate could not pay, and nobody does: unsecured claims die with an empty
   * estate. Reported, never backfilled from {@link beneficiaryRetirementAssetsCents}, and never
   * an input to feasibility — it is already inside {@link terminalEconomicNetWorthCents} as debt.
   */
  readonly unpaidObligationsCents: Cents;
  /** What reaches heirs: the probate residue, if any, plus everything passing by designation. */
  readonly heirDistributionCents: Cents;
  /** `probateSurplusCents >= 0`. A distribution fact, NOT the feasibility test. */
  readonly isProbateSolvent: boolean;
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
 * Property value split into the part answering for its own mortgage and the equity left over.
 *
 * A property secures the loan it names, and only up to what it is worth: a $200k house against a
 * $250k mortgage clears $200k of it and leaves a $50k deficiency, which stops being secured and
 * joins the unsecured queue. A mortgage whose property is gone — sold before death — is secured by
 * nothing, so it never appears here and falls through to unsecured in full.
 */
function collateral(state: SimState): {
  securedDebtCents: Cents;
  collateralAppliedCents: Cents;
  propertyEquityCents: Cents;
} {
  let securedDebtCents = 0;
  let collateralAppliedCents = 0;
  let propertyEquityCents = 0;
  const counted = new Set<string>();
  for (const property of state.properties) {
    const valueCents = state.propertyValues.get(property.id) ?? 0;
    const mortgageId = property.mortgageLiabilityId;
    // `counted` guards the pathological case of two properties naming one loan: the balance is
    // owed once, so it may only be secured once, and the second property is pure equity.
    const balanceCents =
      mortgageId === undefined || mortgageId === null || counted.has(mortgageId)
        ? 0
        : (state.liabilityBalances.get(mortgageId) ?? 0);
    if (balanceCents > 0 && mortgageId !== undefined && mortgageId !== null) counted.add(mortgageId);
    const appliedCents = Math.min(valueCents, balanceCents);
    securedDebtCents += balanceCents;
    collateralAppliedCents += appliedCents;
    propertyEquityCents += valueCents - appliedCents;
  }
  return { securedDebtCents, collateralAppliedCents, propertyEquityCents };
}

/**
 * Settle the terminal state. Pure: reads `state`, mutates nothing, and runs once per projection —
 * never per year, and never a second simulation pass.
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

  let totalDebtCents = 0;
  for (const balanceCents of state.liabilityBalances.values()) totalDebtCents += balanceCents;

  const taxBalanceCents = finalTaxBalanceCents(state, jurisdiction, ctx);
  const finalTaxDueCents = Math.max(0, taxBalanceCents);
  const finalTaxRefundCents = Math.max(0, -taxBalanceCents);

  // The economic answer: everything owned, less everything owed. No designation appears in it.
  const totalAssetsCents =
    estateAccountsCents + beneficiaryRetirementAssetsCents + propertyValuesCents;
  const terminalEconomicNetWorthCents =
    totalAssetsCents + finalTaxRefundCents - totalDebtCents - finalTaxDueCents;

  // The distribution answer, computed from the same stocks and deciding nothing.
  const { securedDebtCents, collateralAppliedCents, propertyEquityCents } = collateral(state);
  const securedDeficiencyCents = securedDebtCents - collateralAppliedCents;
  const unsecuredDebtCents = totalDebtCents - collateralAppliedCents;
  const probateAssetsCents = estateAccountsCents + finalTaxRefundCents + propertyEquityCents;
  const probateObligationsCents = finalTaxDueCents + unsecuredDebtCents;
  const probateSurplusCents = probateAssetsCents - probateObligationsCents;

  return {
    month,
    totalAssetsCents,
    totalDebtCents,
    finalTaxDueCents,
    finalTaxRefundCents,
    terminalEconomicNetWorthCents,
    isEconomicallySolvent: terminalEconomicNetWorthCents >= 0,
    estateAccountsCents,
    beneficiaryRetirementAssetsCents,
    propertyValuesCents,
    securedDebtCents,
    collateralAppliedCents,
    securedDeficiencyCents,
    unsecuredDebtCents,
    probateAssetsCents,
    probateObligationsCents,
    probateSurplusCents,
    unpaidObligationsCents: Math.max(0, -probateSurplusCents),
    heirDistributionCents: Math.max(0, probateSurplusCents) + beneficiaryRetirementAssetsCents,
    isProbateSolvent: probateSurplusCents >= 0,
  };
}
