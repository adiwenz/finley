/**
 * Federal income tax's semantics, in one place. The liability is ANNUAL — the year's taxable
 * income determines it. Nothing is withheld or estimated for it during the year (the household's
 * other in-year tax cash, payroll withholding, is priced by the jurisdiction's own payroll seam
 * and is unrelated to this module): the year closes at December on its COMPLETE actual taxable
 * income ({@link import("./taxYearSettlement").finalizeTaxYear}), and the whole liability is
 * charged as a single balance the following April, through that month's ordinary waterfall
 * ({@link import("./taxYearSettlement").dueTaxYearSettlements}).
 *
 * Every payer prices tax through {@link annualFederalTax} — the year-end close, and nowhere else —
 * so there is exactly one federal-income-tax computation in the engine, not a forecast and an
 * actual that might disagree.
 */

import type { Cents } from "../money/money";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction/jurisdiction";
import { assertPersonTaxBreakdownReconciles } from "./waterfallInvariants";
import type { TaxableByCategory } from "./taxAttribution";

/** A tax year is twelve months. */
export const MONTHS_IN_TAX_YEAR = 12;

/** One person's federal income-tax liability on a FULL year of taxable income. */
export interface AnnualFederalTax {
  readonly totalCents: Cents;
  /** Σ === {@link totalCents}, asserted against the jurisdiction's own contract. */
  readonly byCategoryCents: TaxableByCategory;
}

/** A signed federal-income-tax cash charge — an April settlement, due or refunded. */
export interface FederalTaxPayment {
  readonly totalCents: Cents;
  /** Σ === {@link totalCents}. */
  readonly byCategoryCents: TaxableByCategory;
  /** Σ === {@link totalCents}, keyed like {@link import("./taxAttribution").SourceTaxable.key}. */
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
