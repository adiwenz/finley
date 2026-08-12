import { apportionByWeight, type Cents } from "../money/money";
import type { TaxCategory } from "../money/cashFlowSeries";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction/jurisdiction";
import type { TaxableByCategory } from "./taxAttribution";

/**
 * The engine's shared income-tax reconciliation: {@link Jurisdiction.computeTaxCents} takes
 * ANNUAL taxable-by-category and returns ANNUAL tax liability — the jurisdiction owns tax
 * POLICY only, never a monthly assumption. Every monthly caller (the waterfall's take-home
 * charge, a funding-draw gross-up, a decumulation gross-up) shares this ONE
 * annualize → tax → de-annualize step so they cannot drift apart.
 *
 * ×12 here is a placeholder steady-state annualization (this month's slice recurs all year);
 * it overstates a lump (an RMD, a bonus) exactly as the old jurisdiction-side seam did. Real
 * YTD annualization (`taxableYTD / monthsElapsed × 12`) is the next step, threaded through
 * the same three call sites.
 */

/** ×12 a per-category cents map — exact for integer cents, no rounding. */
export function annualizeByCategory(monthlyByCategory: TaxableByCategory): TaxableByCategory {
  const out: TaxableByCategory = {};
  for (const [category, cents] of Object.entries(monthlyByCategory)) {
    if (!cents) continue;
    out[category as TaxCategory] = cents * 12;
  }
  return out;
}

/** This month's income tax: annualize ×12, tax the annual estimate, return 1/12 of it. */
export function monthlyIncomeTaxCents(
  jurisdiction: Jurisdiction,
  ctx: JurisdictionContext,
  monthlyTaxableByCategory: TaxableByCategory,
): Cents {
  return Math.round(
    jurisdiction.computeTaxCents(annualizeByCategory(monthlyTaxableByCategory), ctx) / 12,
  );
}

/**
 * {@link monthlyIncomeTaxCents} broken out per {@link TaxCategory}: the ANNUAL breakdown's
 * cents stand in as weights, apportioning the MONTHLY total ({@link apportionByWeight},
 * largest-remainder) so Σ === `monthlyIncomeTaxCents` for the same input EXACTLY — never a
 * separately-rounded figure that could fail {@link
 * import("./waterfallInvariants").assertPersonTaxBreakdownReconciles}.
 */
export function monthlyIncomeTaxByCategoryCents(
  jurisdiction: Jurisdiction,
  ctx: JurisdictionContext,
  monthlyTaxableByCategory: TaxableByCategory,
): TaxableByCategory {
  const annual = annualizeByCategory(monthlyTaxableByCategory);
  const monthlyTotal = monthlyIncomeTaxCents(jurisdiction, ctx, monthlyTaxableByCategory);
  const annualBreakdown = jurisdiction.computeTaxByCategoryCents(annual, ctx);
  const weights = Object.entries(annualBreakdown)
    .filter((entry): entry is [string, number] => (entry[1] ?? 0) > 0)
    .map(([category, cents]) => [category, cents as number] as const);
  const out: TaxableByCategory = {};
  for (const [category, cents] of apportionByWeight(monthlyTotal, weights)) {
    out[category as TaxCategory] = cents;
  }
  return out;
}
