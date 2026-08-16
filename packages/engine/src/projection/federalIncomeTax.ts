/**
 * Federal income tax's semantics, in one place. The liability is ANNUAL — the year's taxable
 * income determines it — but it is PAID on a monthly schedule: an even twelfth of the year's
 * estimate each month, with whatever the estimate missed carried to the FOLLOWING April as a
 * balance — the way a real filing settles.
 *
 * Every payer prices tax through {@link annualFederalTax}: the provisional schedule ({@link
 * import("./taxYearProjection").projectKnownTaxYear}), the year's estimate — which is that same
 * pricing applied to a simulated year — and the year-end close ({@link
 * import("./taxYearSettlement").finalizeTaxYear}). Routing all of them through one function is
 * what makes `actualAnnualTax − taxPaidYTD` a meaningful difference rather than a comparison of
 * two unrelated tax computations.
 */

import type { Cents } from "../money/money";
import { apportionByWeight } from "../money/money";
import type { TaxCategory } from "../money/cashFlowSeries";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction/jurisdiction";
import {
  addCategory,
  attributeTaxToSources,
  type SourceTaxable,
  type TaxableByCategory,
} from "./taxAttribution";
import { assertPersonTaxBreakdownReconciles } from "./waterfallInvariants";

/** A tax year is twelve months; the estimate is spread evenly across them. */
export const MONTHS_IN_TAX_YEAR = 12;

/** One person's federal income-tax liability on a FULL year of taxable income. */
export interface AnnualFederalTax {
  readonly totalCents: Cents;
  /** Σ === {@link totalCents}, asserted against the jurisdiction's own contract. */
  readonly byCategoryCents: TaxableByCategory;
}

/**
 * The year's estimated liability for one person, priced once at the tax year's first processed
 * month off a simulated run of that year. Held for the rest of the year so every month's
 * installment comes from the SAME estimate — a later month never re-prices from year-to-date
 * income, which is what produced large early charges and negative monthly refunds for lumpy
 * earners.
 */
export interface EstimatedTaxYear extends AnnualFederalTax {
  /**
   * The forecast year's taxable income per source, the weights each installment is apportioned
   * back across for the tax chart's bands.
   */
  readonly sourceWeights: readonly SourceTaxable[];
}

/** One month's estimated payment, or the running total of them. */
export interface FederalTaxPayment {
  readonly totalCents: Cents;
  /** Σ === {@link totalCents}. */
  readonly byCategoryCents: TaxableByCategory;
  /** Σ === {@link totalCents}, keyed like {@link SourceTaxable.key}. */
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

/**
 * The `monthIndex`-th (0-based within the tax year) of twelve even installments. Cumulative
 * rounding, so the twelve sum to `annualCents` EXACTLY — the year-end balance is then a genuine
 * "actual minus estimated" and never a rounding residue.
 */
export function monthlyInstallmentCents(annualCents: Cents, monthIndex: number): Cents {
  const upTo = (n: number): Cents => Math.round((annualCents * n) / MONTHS_IN_TAX_YEAR);
  return upTo(monthIndex + 1) - upTo(monthIndex);
}

/**
 * This month's estimated payment for one person, with the category and source splits the tax
 * chart bands on. The splits apportion the month's SCALAR installment (rather than installing
 * each category separately) so they sum to it exactly, which is what
 * `assertPersonTaxBreakdownReconciles` demands. No estimate for the year → nothing is charged.
 */
export function estimatedPaymentForMonth(
  estimate: EstimatedTaxYear | undefined,
  monthIndex: number,
): FederalTaxPayment {
  if (estimate === undefined || estimate.totalCents <= 0) return NO_FEDERAL_TAX_PAID;
  const totalCents = monthlyInstallmentCents(estimate.totalCents, monthIndex);
  if (totalCents === 0) return NO_FEDERAL_TAX_PAID;
  const byCategoryCents: TaxableByCategory = {};
  const weights = Object.entries(estimate.byCategoryCents).map(
    ([category, cents]) => [category, cents ?? 0] as const,
  );
  for (const [category, cents] of apportionByWeight(totalCents, weights)) {
    addCategory(byCategoryCents, category as TaxCategory, cents);
  }
  const bySourceCents: Record<string, Cents> = {};
  attributeTaxToSources(byCategoryCents, estimate.sourceWeights, bySourceCents);
  return { totalCents, byCategoryCents, bySourceCents };
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
