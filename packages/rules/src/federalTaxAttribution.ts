import type { Cents, TaxCategory } from "@finley/engine";
import { federalTaxParts, annualizeByCategory, type FederalTaxParts } from "./federalTaxCore";

// annualizeByCategory lives in ./federalTaxCore (a neutral ×12 helper, not attribution
// logic); re-exported here to preserve its former import path.
export { annualizeByCategory } from "./federalTaxCore";

/**
 * Distribute integer-cents `totalCents` across `entries` (`[category, weight]` pairs) in
 * proportion to the weights, every share an integer cent and Σ shares === `totalCents`
 * exactly (largest-remainder: floor each share, then hand leftover cents to the largest
 * fractional remainders). Zero-weight and zero-share categories are omitted.
 */
function apportionByWeight(
  totalCents: Cents,
  entries: readonly (readonly [TaxCategory, number])[],
): Partial<Record<TaxCategory, Cents>> {
  const weightSum = entries.reduce((s, [, w]) => s + w, 0);
  if (totalCents <= 0 || weightSum <= 0) return {};

  const shares: { category: TaxCategory; whole: Cents; remainder: number }[] = [];
  let allocated = 0;
  for (const [category, weight] of entries) {
    const exact = (totalCents * weight) / weightSum;
    const whole = Math.floor(exact);
    allocated += whole;
    shares.push({ category, whole, remainder: exact - whole });
  }
  let leftover = totalCents - allocated;
  shares.sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; leftover > 0; i = (i + 1) % shares.length, leftover--) shares[i]!.whole += 1;

  const out: Partial<Record<TaxCategory, Cents>> = {};
  for (const { category, whole } of shares) if (whole > 0) out[category] = whole;
  return out;
}

/**
 * Split a `totalCents` federal-tax figure across the {@link TaxCategory} buckets that bore
 * it, given the computed {@link FederalTaxParts}. Regime-aware proportional-to-taxable:
 *
 *   • The preferential capital-gains tax rides `capitalGains` alone: gains keep their own
 *     0/15/20% rates rather than an averaged blend.
 *   • The progressive ordinary tax splits among `wages`, `ordinaryIncome`, and
 *     `governmentRetirementBenefit` by ordinary-taxable weight (the benefit weighted by
 *     its INCLUDED portion only), sharing the standard deduction and bracket climb
 *     pro-rata.
 *   • `taxExempt` never bears tax — it is only counted for the benefit test.
 *
 * ⚠ LIMITATION: an average-rate attribution WITHIN the ordinary regime. It cannot capture
 * that a category's LAST dollar sits in a higher bracket than its first, nor notch/inclusion
 * effects (a marginal ordinary dollar can raise the taxable benefit or push gains out of the
 * 0% band). Exact in TOTAL, not a marginal-incidence decomposition.
 */
function attributeFederalTax(
  totalCents: Cents,
  parts: FederalTaxParts,
): Partial<Record<TaxCategory, Cents>> {
  const w = parts.ordinaryWeights;
  const ordinaryWeightSum = w.wages + w.ordinaryIncome + w.governmentRetirementBenefit;
  const entries: [TaxCategory, number][] = [];
  if (ordinaryWeightSum > 0) {
    for (const category of ["wages", "ordinaryIncome", "governmentRetirementBenefit"] as const) {
      const taxBorne = (parts.ordinaryTaxCents * w[category]) / ordinaryWeightSum;
      if (taxBorne > 0) entries.push([category, taxBorne]);
    }
  }
  if (parts.gainsTaxCents > 0) entries.push(["capitalGains", parts.gainsTaxCents]);
  return apportionByWeight(totalCents, entries);
}

/**
 * The ANNUAL single-filer federal income tax broken out per {@link TaxCategory}, the
 * per-category analog of {@link federalAnnualTaxCents}. Σ of the returned map equals
 * {@link federalAnnualTaxCents} exactly. See {@link attributeFederalTax} for the
 * attribution method and its limitation. Empty map when no tax is owed.
 */
export function federalAnnualTaxByCategoryCents(
  annualByCategory: Partial<Record<TaxCategory, Cents>>,
  year: number,
): Partial<Record<TaxCategory, Cents>> {
  const parts = federalTaxParts(annualByCategory, year);
  return attributeFederalTax(parts.totalCents, parts);
}

/**
 * The engine's per-category tax seam for the US single filer, taking MONTHLY amounts. Σ
 * equals {@link computeFederalTaxCents} for the same slice EXACTLY. Method and limitation:
 * {@link attributeFederalTax}. The only per-category entry point `index.ts` wires into
 * {@link usJurisdiction}.
 */
export function computeFederalTaxByCategoryCents(
  monthlyByCategory: Partial<Record<TaxCategory, Cents>>,
  year: number,
): Partial<Record<TaxCategory, Cents>> {
  const parts = federalTaxParts(annualizeByCategory(monthlyByCategory), year);
  // Apportion the MONTHLY total (== computeFederalTaxCents) by the annual weights — identical
  // ratios monthly vs. annual — so Σ(breakdown) === the scalar the waterfall charged, not a
  // separately-rounded figure.
  const monthlyTotal = Math.round(parts.totalCents / 12);
  return attributeFederalTax(monthlyTotal, parts);
}
