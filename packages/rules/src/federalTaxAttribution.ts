import type { Cents, TaxCategory } from "@finley/engine";
import { federalTaxParts, type FederalTaxParts } from "./federalTaxCore";

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
 * Split `totalCents` across the {@link TaxCategory} buckets that bore it, given the computed
 * {@link FederalTaxParts}. Proportional-to-taxable, per regime:
 *
 *   • Gains tax rides `capitalGains` alone, keeping its own 0/15/20% rates.
 *   • Ordinary tax splits among `wages`, `ordinaryIncome` and `governmentRetirementBenefit`
 *     by ordinary-taxable weight (the benefit by its INCLUDED portion only).
 *   • `taxExempt` never bears tax; it counts only for the benefit test.
 *
 * ⚠ LIMITATION: average-rate within the ordinary regime, not marginal incidence — it misses
 * notch/inclusion effects (an ordinary dollar can raise the taxable benefit or push gains out
 * of the 0% band). Exact in TOTAL only.
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
 * The ANNUAL single-filer federal income tax broken out per {@link TaxCategory}. Σ of the
 * returned map equals {@link federalAnnualTaxCents} exactly. Method and limitation:
 * {@link attributeFederalTax}. Empty map when no tax is owed.
 */
export function federalAnnualTaxByCategoryCents(
  annualByCategory: Partial<Record<TaxCategory, Cents>>,
  year: number,
): Partial<Record<TaxCategory, Cents>> {
  const parts = federalTaxParts(annualByCategory, year);
  return attributeFederalTax(parts.totalCents, parts);
}
