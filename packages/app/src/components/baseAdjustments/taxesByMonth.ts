/**
 * Monthly tax-paid graph data — the third companion to the income ({@link
 * import("./incomeByCategory")}) and per-line budget ({@link import("./perLineBudget")})
 * charts, sharing their x-axis and month-selection gesture.
 *
 * Tax is the household's least visible outflow: it never appears as a budget line and it
 * is netted out of every drawdown at the §5.3 chokepoint, so the two charts above it show
 * gross income and gross spending while the tax that sits between them stays implicit.
 * This graph makes it explicit — how much tax the plan pays each month, and how that
 * shape moves as earned income gives way to withdrawals and the government benefit.
 *
 * It STACKS BY TAX CATEGORY (issue #110), mirroring the income chart: the engine now
 * reports the tax broken out per `TaxCategory` (`ProjectionMonthFlows.taxByCategoryCents`)
 * because the JURISDICTION owns the attribution — US tax is not linearly separable by
 * category (progressive brackets, the capital-gains preference, benefit inclusion), so the
 * split is the jurisdiction's call, not the app's to synthesize. When the jurisdiction
 * declines the breakdown (a null jurisdiction, or one that does not implement the seam) the
 * chart falls back to a single band on the `taxCents` total, exactly as before.
 *
 * Pure: the app passes the series in and this derives the chart shape, with no charting
 * library dependency (so it is unit-testable in node).
 */

import type { ProjectionSeries, TaxCategory } from "@finley/engine";

/** One tax band on the stacked chart: a tax category and how to name it. */
export interface TaxCategoryBand {
  /** The engine's {@link TaxCategory} — the band's identity and colour/order driver. */
  readonly category: TaxCategory;
  readonly label: string;
}

/** One month's tax row for the chart. */
export interface TaxMonthRow {
  readonly month: number;
  /** Total tax this month — the sum of the bands, and the single-band value in fallback. */
  readonly taxCents: number;
  /** This month's tax keyed by {@link TaxCategory}; empty when no breakdown is reported. */
  readonly centsByCategory: Readonly<Record<string, number>>;
}

export interface TaxChartData {
  readonly rows: readonly TaxMonthRow[];
  /**
   * The tax categories that carry tax somewhere, in stable stacking order (issue #110).
   * Empty when the engine reports no per-category breakdown — the chart then draws a
   * single total band. Categories that are zero across the whole horizon are dropped, so
   * there is no empty legend entry.
   */
  readonly categories: readonly TaxCategoryBand[];
  /** True when at least one month carried a per-category breakdown (else a single band). */
  readonly hasCategoryBreakdown: boolean;
  /** Total nominal tax paid across the whole horizon (the sum of every month). */
  readonly totalCents: number;
  /** The largest single month's tax, and the month it falls in — the visible peak. */
  readonly peakMonthlyCents: number;
  readonly peakMonth: number;
  /** False when the plan pays no tax anywhere (a null jurisdiction, or an all-exempt plan). */
  readonly hasAnyTax: boolean;
}

/**
 * Stable stacking order (bottom → top) and human labels for the tax bands, mirroring the
 * income chart's category order so the two charts read consistently: earned **wages** at
 * the base, then the **government benefit**, then the drawdown-side categories. Anything
 * unrecognised sorts to the end.
 */
const TAX_CATEGORY_LABELS: Readonly<Record<TaxCategory, string>> = {
  wages: "Wages",
  governmentRetirementBenefit: "Social Security",
  ordinaryIncome: "Ordinary income",
  capitalGains: "Capital gains",
  taxExempt: "Tax-exempt",
};
const CATEGORY_ORDER: readonly TaxCategory[] = [
  "wages",
  "governmentRetirementBenefit",
  "ordinaryIncome",
  "capitalGains",
  "taxExempt",
];

function categoryRank(category: string): number {
  const i = CATEGORY_ORDER.indexOf(category as TaxCategory);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

/**
 * Build the tax chart data from a projection series. One row per *flowed* month (month 0
 * is the flow-free opening snapshot, §4.6, so it is skipped), mirroring the income chart
 * exactly so the two line up point-for-point on the shared axis.
 *
 * When a month carries `taxByCategoryCents` the row keeps the per-category split (whose Σ
 * equals `taxCents`, by the seam's contract); the union of categories that ever carry tax
 * becomes the stacked bands. When NO month carries a breakdown, `categories` is empty and
 * the row's `taxCents` is the single-band value — the pre-#110 behaviour, preserved.
 */
export function buildTaxChartData(series: ProjectionSeries): TaxChartData {
  const rows: TaxMonthRow[] = [];
  let totalCents = 0;
  let peakMonthlyCents = 0;
  let peakMonth = 0;
  let hasCategoryBreakdown = false;
  // Which categories ever carried a positive tax — drives the (dropped-if-empty) bands.
  const categoryTotals = new Map<string, number>();

  for (const m of series.months) {
    const flows = m.flows;
    if (flows === undefined) continue; // month 0 / any flow-free snapshot
    const taxCents = Math.max(0, flows.taxCents ?? 0);
    totalCents += taxCents;
    if (taxCents > peakMonthlyCents) {
      peakMonthlyCents = taxCents;
      peakMonth = m.month;
    }
    const centsByCategory: Record<string, number> = {};
    const breakdown = flows.taxByCategoryCents;
    if (breakdown !== undefined) {
      hasCategoryBreakdown = true;
      for (const [category, cents] of Object.entries(breakdown)) {
        const value = Math.max(0, cents ?? 0);
        if (value === 0) continue;
        centsByCategory[category] = (centsByCategory[category] ?? 0) + value;
        categoryTotals.set(category, (categoryTotals.get(category) ?? 0) + value);
      }
    }
    rows.push({ month: m.month, taxCents, centsByCategory });
  }

  const categories: TaxCategoryBand[] = [...categoryTotals.keys()]
    .sort((a, b) => categoryRank(a) - categoryRank(b))
    .map((category) => ({
      category: category as TaxCategory,
      label: TAX_CATEGORY_LABELS[category as TaxCategory] ?? category,
    }));

  return {
    rows,
    categories,
    hasCategoryBreakdown,
    totalCents,
    peakMonthlyCents,
    peakMonth,
    hasAnyTax: totalCents > 0,
  };
}

/** Year (1-based) of an absolute month, for a human-facing "Year N" label. */
function yearOf(month: number): number {
  return Math.floor(month / 12) + 1;
}

/** Whole dollars, grouped — for the summary line (the chart axis uses `formatDollars`). */
function dollars(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

/**
 * A one-line summary for the a11y label / status line: the lifetime total and where the
 * monthly bill peaks, or `null` when the plan pays no tax at all (nothing to describe).
 */
export function describeTaxes(data: TaxChartData): string | null {
  if (!data.hasAnyTax) return null;
  return (
    `${dollars(data.totalCents)} in tax over the plan, peaking around ` +
    `${dollars(data.peakMonthlyCents)}/mo in Year ${yearOf(data.peakMonth)}. Federal income tax only.`
  );
}
