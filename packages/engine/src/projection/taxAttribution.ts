import { apportionByWeight, type Cents } from "../money/money";
import type { TaxCategory } from "../money/cashFlowSeries";

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
 * Two per-category maps summed into a NEW one, neither input touched — how a year-to-date total
 * gets this month's figures added to it without the running accumulator being written early.
 */
export function mergeCategories(
  a: TaxableByCategory | undefined,
  b: TaxableByCategory | undefined,
): TaxableByCategory {
  const out: TaxableByCategory = { ...(a ?? {}) };
  for (const [category, cents] of Object.entries(b ?? {})) {
    if (cents) addCategory(out, category as TaxCategory, cents);
  }
  return out;
}

/**
 * `a − b`, over the union of both maps' categories. Entries may go NEGATIVE, which is the point:
 * this is how a year's actual liability per category has what was already withheld against that
 * category taken out of it, leaving a signed balance to settle.
 */
export function subtractCategories(
  a: TaxableByCategory,
  b: TaxableByCategory,
): TaxableByCategory {
  const out: TaxableByCategory = {};
  for (const category of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const net = (a[category as TaxCategory] ?? 0) - (b[category as TaxCategory] ?? 0);
    if (net !== 0) out[category as TaxCategory] = net;
  }
  return out;
}

/**
 * {@link attributeTaxToSources} for a SIGNED per-category balance: a positive category is
 * apportioned exactly as it always was, a negative one (over-withheld — a refund) is apportioned
 * by the same weights and subtracted. Σ of what lands in `into` is Σ `perCategory`, sign and all,
 * so a refund bands back to the sources whose income over-collected it.
 */
export function attributeSignedTaxToSources(
  perCategory: TaxableByCategory,
  sources: readonly SourceTaxable[],
  into: Record<string, Cents>,
): void {
  const positive: TaxableByCategory = {};
  const negated: TaxableByCategory = {};
  for (const [category, cents] of Object.entries(perCategory)) {
    if (!cents) continue;
    if (cents > 0) positive[category as TaxCategory] = cents;
    else negated[category as TaxCategory] = -cents;
  }
  attributeTaxToSources(positive, sources, into);
  const refunds: Record<string, Cents> = {};
  attributeTaxToSources(negated, sources, refunds);
  for (const [key, cents] of Object.entries(refunds)) into[key] = (into[key] ?? 0) - cents;
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
