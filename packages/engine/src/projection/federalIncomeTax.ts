/**
 * Federal income tax's semantics, in one place — and the shape of the two figures that never
 * agree.
 *
 * The LIABILITY is annual: the year's taxable income, all of it, determines it, and it is knowable
 * only once the year is over. What the household actually PAYS during the year is WITHHOLDING —
 * whatever payroll took out of each paycheck, computed from that paycheck alone. Non-wage income
 * has nothing withheld against it at all, because no payroll system sees it.
 *
 * The difference is not an error to be minimized. It is the refund or the balance due, and the
 * year's close parks it for the following April to settle
 * ({@link import("./taxYearSettlement").finalizeTaxYear}).
 *
 * {@link annualFederalTax} is the single pricing chokepoint: the year's close is the only caller,
 * so "actual liability − withheld" is a difference of two well-defined figures rather than a
 * comparison of two unrelated tax computations.
 */

import type { Cents } from "../money/money";
import type { TaxCategory } from "../money/cashFlowSeries";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction/jurisdiction";
import { addCategory, type TaxableByCategory } from "./taxAttribution";
import { assertPersonTaxBreakdownReconciles } from "./waterfallInvariants";

/** A tax year is twelve months. */
export const MONTHS_IN_TAX_YEAR = 12;

/**
 * A compiled income series resolves ONE figure per month, so a month IS the finest paycheck this
 * model has and there are twelve of them a year. Every jurisdiction withholding rule that
 * annualizes a period's pay reads this, so the model's pay-period granularity is stated once here
 * rather than assumed at each seam.
 *
 * Monthly is a real IRS pay frequency with its own published percentage-method column, so nothing
 * has to be invented to use it — the alternative, synthesizing biweekly paycheck dates a job never
 * carried, would be a fiction with worse arithmetic and no more truth in it.
 */
export const PAY_PERIODS_PER_YEAR = MONTHS_IN_TAX_YEAR;

/** One person's federal income-tax liability on a FULL year of taxable income. */
export interface AnnualFederalTax {
  readonly totalCents: Cents;
  /** Σ === {@link totalCents}, asserted against the jurisdiction's own contract. */
  readonly byCategoryCents: TaxableByCategory;
}

/** Tax paid in one month, or the running total of what a year has paid so far. */
export interface FederalTaxPayment {
  readonly totalCents: Cents;
  /** Σ === {@link totalCents}. */
  readonly byCategoryCents: TaxableByCategory;
  /** Σ === {@link totalCents}, keyed by income-source key. */
  readonly bySourceCents: Record<string, Cents>;
}

export const NO_FEDERAL_TAX_PAID: FederalTaxPayment = {
  totalCents: 0,
  byCategoryCents: {},
  bySourceCents: {},
};

/**
 * Price a full year of taxable income. `personId` only names the person in the reconciliation
 * failure the jurisdiction's breakdown contract is checked against.
 */
export function annualFederalTax(
  jurisdiction: Jurisdiction,
  ctx: JurisdictionContext,
  personId: string,
  annualTaxableByCategory: TaxableByCategory,
): AnnualFederalTax {
  const totalCents = jurisdiction.computeTaxCents(annualTaxableByCategory, ctx);
  const byCategoryCents = jurisdiction.computeTaxByCategoryCents(annualTaxableByCategory, ctx);
  assertPersonTaxBreakdownReconciles(personId, totalCents, byCategoryCents);
  return { totalCents, byCategoryCents };
}

/** Fold one month's payment into a person's running year-to-date total. */
export function addFederalTaxPayment(
  running: FederalTaxPayment,
  payment: FederalTaxPayment,
): FederalTaxPayment {
  if (payment.totalCents === 0) return running;
  const byCategoryCents: TaxableByCategory = { ...running.byCategoryCents };
  for (const [category, cents] of Object.entries(payment.byCategoryCents)) {
    if (cents) addCategory(byCategoryCents, category as TaxCategory, cents);
  }
  const bySourceCents: Record<string, Cents> = { ...running.bySourceCents };
  for (const [source, cents] of Object.entries(payment.bySourceCents)) {
    if (cents) bySourceCents[source] = (bySourceCents[source] ?? 0) + cents;
  }
  return {
    totalCents: running.totalCents + payment.totalCents,
    byCategoryCents,
    bySourceCents,
  };
}
