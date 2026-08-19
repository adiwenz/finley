/**
 * Federal income tax's semantics, in one place. The LIABILITY is ANNUAL — the year's taxable
 * income determines it, and nothing else — while the CASH moves in two places, which is the whole
 * of the model:
 *
 *  1. **Withholding, monthly, on wages** ({@link import("./withholding")}): the year-to-date
 *     wages annualized and priced, charged as the month's incremental share. Backward-looking by
 *     construction — it sees only income already received, so no event can change a month before
 *     itself. Nothing else is withheld against: not a gain, not a pre-tax withdrawal, not an RMD,
 *     not an early-withdrawal penalty.
 *  2. **The April true-up** ({@link import("./taxYearSettlement")}): December closes the year on
 *     its COMPLETE actual taxable income ({@link
 *     import("./taxYearSettlement").finalizeTaxYear}), subtracts what was withheld, and parks the
 *     signed remainder for the following April to charge or refund through that month's ordinary
 *     waterfall ({@link import("./taxYearSettlement").dueTaxYearSettlements}).
 *
 * The household's OTHER in-year tax cash, payroll tax, is priced by the jurisdiction's own
 * payroll seam and is unrelated to this module.
 *
 * The authoritative liability is priced through {@link annualFederalTax} — at the year's close,
 * and nowhere else — so there is exactly one federal-income-tax computation that anything is ever
 * settled against. Withholding is explicitly an ESTIMATE of it and is allowed to be wrong; being
 * wrong is what April is for.
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
