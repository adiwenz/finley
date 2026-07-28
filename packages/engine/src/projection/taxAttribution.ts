import { apportionByWeight, type Cents } from "../money";
import type { TaxCategory } from "../cashFlowSeries";

/** A per-person map of taxable amount by {@link TaxCategory}. */
export type TaxableByCategory = Partial<Record<TaxCategory, Cents>>;

/**
 * `key` is the source's `sourceId` (falling back to its tax category), matching how
 * {@link import("./reportFlows").buildFlows} bands the income side, so tax bands line up
 * with income bands.
 */
export interface SourceTaxable {
  readonly key: string;
  readonly category: TaxCategory;
  readonly taxableCents: Cents;
}

export function addCategory(map: TaxableByCategory, category: TaxCategory, amount: Cents): void {
  if (amount === 0) return;
  map[category] = (map[category] ?? 0) + amount;
}

/**
 * Splits one person's per-category tax down to the sources that bore it, accumulating into
 * the household `into` map. Within a category, tax is apportioned by taxable weight
 * ({@link apportionByWeight}, so Σ shares === the category's tax exactly). The jurisdiction
 * sees only the summed per-category taxable, so proportional-to-taxable is the neutral
 * split — average-rate, not marginal (disclosed as `taxAttributionProportional`).
 *
 * Call once per person, so two earners in different brackets cannot cross-subsidise. A
 * category carrying tax with no recorded sources (defensive) is attributed to the category
 * key, keeping the household Σ reconciled to `taxCents`.
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
