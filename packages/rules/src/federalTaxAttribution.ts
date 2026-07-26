import type { Cents, TaxCategory } from "@finley/engine";
import { federalTaxParts, type FederalTaxParts } from "./federalTax";

/**
 * Distribute an integer-cents `totalCents` across `entries` (each a `[category,
 * weight]` pair) IN PROPORTION to the weights, with every share an integer cent and
 * Σ shares === `totalCents` exactly (largest-remainder apportionment: floor each
 * share, then hand the leftover cents to the largest fractional remainders). Zero-
 * weight and zero-share categories are omitted, so the map carries only bands worth
 * drawing. The exact-sum guarantee is what lets the attribution honour the AC
 * "total still equals `computeTaxCents`".
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
  // Hand out the leftover cents, biggest fractional remainder first.
  let leftover = totalCents - allocated;
  shares.sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; leftover > 0; i = (i + 1) % shares.length, leftover--) shares[i]!.whole += 1;

  const out: Partial<Record<TaxCategory, Cents>> = {};
  for (const { category, whole } of shares) if (whole > 0) out[category] = whole;
  return out;
}

/**
 * Split a `totalCents` federal-tax figure across the {@link TaxCategory} buckets that
 * bore it, given the computed {@link FederalTaxParts}. ATTRIBUTION METHOD (§5.3, issue
 * #110) — regime-aware proportional-to-taxable:
 *
 *   • The preferential **capital-gains** tax rides the `capitalGains` bucket alone, so
 *     the split respects that gains are taxed at their own 0/15/20% rates rather than
 *     an averaged blend (the interaction #100 turned on).
 *   • The progressive **ordinary** tax is divided among `wages`, `ordinaryIncome`, and
 *     `governmentRetirementBenefit` in proportion to each one's ordinary-taxable weight
 *     (the benefit weighted by its INCLUDED portion only), so the standard deduction
 *     and the bracket climb are shared pro-rata across the ordinary contributors.
 *   • `taxExempt` never bears tax (it is never taxed, only counted for the benefit test).
 *
 * ⚠ LIMITATION (documented, mirrors the withdrawal-seam monotonicity caveat): this is an
 * average-rate attribution WITHIN the ordinary regime — it cannot perfectly capture that
 * the LAST dollar of one category sits in a higher bracket than the first, nor the
 * notch/inclusion effects (a marginal dollar of ordinary income can raise the taxable
 * benefit or push gains out of the 0% band). The split is exact in TOTAL, defensible
 * per bucket, and honest about not being a marginal-incidence decomposition.
 */
function attributeFederalTax(
  totalCents: Cents,
  parts: FederalTaxParts,
): Partial<Record<TaxCategory, Cents>> {
  const w = parts.ordinaryWeights;
  const ordinaryWeightSum = w.wages + w.ordinaryIncome + w.governmentRetirementBenefit;
  const entries: [TaxCategory, number][] = [];
  // Weight each category by the TAX it bore: the ordinary tax split pro-rata by
  // ordinary-taxable weight, the gains tax attributed whole to capital gains.
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

/** Annualize a monthly per-category slice (×12) — the input the annual math expects. */
export function annualizeByCategory(
  monthlyByCategory: Partial<Record<TaxCategory, Cents>>,
): Partial<Record<TaxCategory, Cents>> {
  const annualByCategory: Partial<Record<TaxCategory, Cents>> = {};
  for (const [category, cents] of Object.entries(monthlyByCategory)) {
    annualByCategory[category as TaxCategory] = (cents ?? 0) * 12;
  }
  return annualByCategory;
}

/**
 * The engine's §5.3 per-category tax seam for the US single filer (issue #110): MONTHLY
 * per-category taxable amounts in → this month's tax split per {@link TaxCategory} out,
 * the per-category analog of {@link computeFederalTaxCents}. Σ of the returned map equals
 * {@link computeFederalTaxCents} for the same slice EXACTLY — the monthly scalar total is
 * apportioned by the annual per-regime weights (the ratios are identical monthly vs.
 * annual), so the breakdown can never disagree with the total the take-home already used.
 * See {@link attributeFederalTax} for the attribution method and its documented limitation.
 * This is the only per-category entry point `index.ts` wires into {@link usJurisdiction}.
 */
export function computeFederalTaxByCategoryCents(
  monthlyByCategory: Partial<Record<TaxCategory, Cents>>,
  year: number,
): Partial<Record<TaxCategory, Cents>> {
  const parts = federalTaxParts(annualizeByCategory(monthlyByCategory), year);
  // Apportion the MONTHLY total (== computeFederalTaxCents) by the annual weights, so
  // Σ(breakdown) === the scalar the waterfall charged, not a separately-rounded figure.
  const monthlyTotal = Math.round(parts.totalCents / 12);
  return attributeFederalTax(monthlyTotal, parts);
}
