import { apportionByWeight, type Cents } from "../money";
import type { TaxCategory } from "../cashFlowSeries";

/** A per-person map of taxable amount by {@link TaxCategory}. */
export type TaxableByCategory = Partial<Record<TaxCategory, Cents>>;

/**
 * One income source's taxable contribution for a person, tagged with its reporting key
 * and tax category — the weights the per-source tax attribution (issue #110 follow-up)
 * apportions each category's tax across. `key` is the source's `sourceId` (falling back
 * to its tax category), matching how {@link import("./reportFlows").buildFlows} bands the
 * income side, so tax bands line up with income bands.
 */
export interface SourceTaxable {
  readonly key: string;
  readonly category: TaxCategory;
  readonly taxableCents: Cents;
}

/** Add `amount` to `map[category]` (creating the entry at 0 first). */
export function addCategory(map: TaxableByCategory, category: TaxCategory, amount: Cents): void {
  if (amount === 0) return;
  map[category] = (map[category] ?? 0) + amount;
}

/**
 * Split one person's per-category tax down to the individual sources that bore it
 * (§5.3, issue #110 follow-up), accumulating into the household `into` map. Within each
 * category, the tax is apportioned across that category's sources by their taxable
 * weight ({@link apportionByWeight}, so Σ shares === the category's tax exactly). All
 * sources in a category face identical treatment from the jurisdiction (it only sees the
 * summed per-category taxable), so proportional-to-taxable is the neutral, information-
 * preserving split — average-rate, not marginal (disclosed as `taxAttributionProportional`).
 *
 * Doing this per person (this is called once per person) keeps two earners in different
 * brackets from cross-subsidising: each person's own tax is split only across their own
 * sources. A category that carries tax but whose sources weren't recorded (defensive —
 * shouldn't happen, since the taxable that produced the tax came from those sources) is
 * attributed to the category key itself, so the household Σ still reconciles to `taxCents`.
 */
export function attributeTaxToSources(
  perCategory: TaxableByCategory,
  sources: readonly SourceTaxable[],
  into: Record<string, Cents>,
): void {
  const add = (key: string, cents: Cents): void => {
    if (cents > 0) into[key] = (into[key] ?? 0) + cents;
  };
  for (const [category, categoryTax] of Object.entries(perCategory)) {
    if (!categoryTax || categoryTax <= 0) continue;
    const weights = sources
      .filter((s) => s.category === category)
      .map((s) => [s.key, s.taxableCents] as const);
    if (weights.length === 0) {
      add(category, categoryTax); // fallback — keep the household Σ exact
      continue;
    }
    for (const [key, cents] of apportionByWeight(categoryTax, weights)) add(key, cents);
  }
}
