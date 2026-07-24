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
 * It STACKS BY INCOME SOURCE (issue #110 follow-up), mirroring the income chart exactly:
 * the engine now reports the tax broken out per source (`ProjectionMonthFlows
 * .taxBySourceCents`) — which JOB, which account draw bore it — because the JURISDICTION
 * owns the category attribution (US tax is not linearly separable — progressive brackets,
 * the capital-gains preference, benefit inclusion) and the engine then splits each
 * category's tax across the sources in it by taxable weight. So a two-earner household sees
 * *which job* is taxed, not a single lumped `wages` band. Bands are coloured and ordered by
 * each source's provenance category (wages first, then the benefit, then the drawdown-side
 * categories) so the tax chart reads consistently with the income chart. When the
 * jurisdiction declines the breakdown (a null jurisdiction, or one that does not implement
 * the seam) the chart falls back to a single band on the `taxCents` total, as before.
 *
 * ⚠ The per-source split is proportional (average-rate), not marginal — the caveat the
 * report discloses as `taxAttributionProportional`. Adding a second job really costs more
 * tax than its average share, so a band shows a source's *average* share of the bill.
 *
 * Pure: the app passes the series in and this derives the chart shape, with no charting
 * library dependency (so it is unit-testable in node).
 */

import type { IncomeSourceCategory, ProjectionSeries } from "@finley/engine";

/** One tax band on the stacked chart: a source, how to name it, and its provenance. */
export interface TaxSourceBand {
  /** The engine's stable source id (a job's id, an account draw, or a category fallback). */
  readonly id: string;
  readonly label: string;
  /** Provenance category, driving band colour and stacking order (as on the income chart). */
  readonly category: string;
}

/** One month's tax row for the chart. */
export interface TaxMonthRow {
  readonly month: number;
  /** Total tax this month — the sum of the bands, and the single-band value in fallback. */
  readonly taxCents: number;
  /** This month's tax keyed by source id; empty when no per-source breakdown is reported. */
  readonly centsBySource: Readonly<Record<string, number>>;
}

export interface TaxChartData {
  readonly rows: readonly TaxMonthRow[];
  /**
   * The income sources that carry tax somewhere, in stable stacking order (issue #110
   * follow-up). Empty when the engine reports no per-source breakdown — the chart then
   * draws a single total band. Sources that are zero across the whole horizon are dropped,
   * so there is no empty legend entry.
   */
  readonly sources: readonly TaxSourceBand[];
  /** True when at least one month carried a per-source breakdown (else a single band). */
  readonly hasSourceBreakdown: boolean;
  /** Total nominal tax paid across the whole horizon (the sum of every month). */
  readonly totalCents: number;
  /** The largest single month's tax, and the month it falls in — the visible peak. */
  readonly peakMonthlyCents: number;
  readonly peakMonth: number;
  /** False when the plan pays no tax anywhere (a null jurisdiction, or an all-exempt plan). */
  readonly hasAnyTax: boolean;
}

/**
 * Human labels for a source keyed only by its tax CATEGORY (the fallback key the engine
 * uses for an untitled source — e.g. a wage stream with no job id). A real job bands under
 * its own name; these cover the fallback so a category-keyed band still reads in English.
 */
const TAX_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  wages: "Wages",
  governmentRetirementBenefit: "Social Security",
  ordinaryIncome: "Ordinary income",
  capitalGains: "Capital gains",
  taxExempt: "Tax-exempt",
};

/**
 * Stable stacking order (bottom → top) by provenance category, matching the income chart
 * so the two line up: earned **wages** at the base, then the **government benefit**, then
 * the drawdown-side categories. Anything unrecognised sorts to the end.
 */
const CATEGORY_ORDER: readonly IncomeSourceCategory[] = [
  "wages",
  "governmentRetirementBenefit",
  "ordinaryIncome",
  "capitalGains",
  "taxExempt",
  "savingsDrawdown",
];

function categoryRank(category: string): number {
  const i = CATEGORY_ORDER.indexOf(category as IncomeSourceCategory);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

/**
 * Build the tax chart data from a projection series. One row per *flowed* month (month 0
 * is the flow-free opening snapshot, §4.6, so it is skipped), mirroring the income chart
 * exactly so the two line up point-for-point on the shared axis.
 *
 * When a month carries `taxBySourceCents` the row keeps the per-source split (whose Σ
 * equals `taxCents`, by the seam's contract); the union of sources that ever carry tax
 * becomes the stacked bands, named from the month's `incomeSources` where available. When
 * NO month carries a breakdown, `sources` is empty and the row's `taxCents` is the
 * single-band value — the pre-breakdown behaviour, preserved.
 */
export function buildTaxChartData(series: ProjectionSeries): TaxChartData {
  const rows: TaxMonthRow[] = [];
  let totalCents = 0;
  let peakMonthlyCents = 0;
  let peakMonth = 0;
  let hasSourceBreakdown = false;
  // Label/category per source id, learned from the income-source flows (the income side
  // names each job); tax-only keys fall back to a category label below.
  const registry = new Map<string, { label: string; category: string }>();
  // Which sources ever carried a positive tax — drives the (dropped-if-empty) bands, in
  // first-appearance order (a Map preserves insertion order).
  const sourceTotals = new Map<string, number>();

  for (const m of series.months) {
    const flows = m.flows;
    if (flows === undefined) continue; // month 0 / any flow-free snapshot
    // Learn each income source's name/provenance so a tax band can label its job.
    for (const s of flows.incomeSources ?? []) {
      if (!registry.has(s.sourceId)) registry.set(s.sourceId, { label: s.label, category: s.category });
    }

    const taxCents = Math.max(0, flows.taxCents ?? 0);
    totalCents += taxCents;
    if (taxCents > peakMonthlyCents) {
      peakMonthlyCents = taxCents;
      peakMonth = m.month;
    }

    const centsBySource: Record<string, number> = {};
    const breakdown = flows.taxBySourceCents;
    if (breakdown !== undefined) {
      hasSourceBreakdown = true;
      for (const [sourceId, cents] of Object.entries(breakdown)) {
        const value = Math.max(0, cents ?? 0);
        if (value === 0) continue;
        centsBySource[sourceId] = (centsBySource[sourceId] ?? 0) + value;
        sourceTotals.set(sourceId, (sourceTotals.get(sourceId) ?? 0) + value);
      }
    }
    rows.push({ month: m.month, taxCents, centsBySource });
  }

  const sources: TaxSourceBand[] = [...sourceTotals.keys()]
    .map((id) => {
      const known = registry.get(id);
      if (known !== undefined) return { id, label: known.label, category: known.category };
      // A tax-only key (no income band) — an untitled source keyed by its category, or a
      // zero-cash booking. Name it from the category table, or the raw key as a last resort.
      return { id, label: TAX_CATEGORY_LABELS[id] ?? id, category: id };
    })
    // Sort by category order, ties broken by first-appearance (the Map's insertion order).
    .sort((a, b) => categoryRank(a.category) - categoryRank(b.category));

  return {
    rows,
    sources,
    hasSourceBreakdown,
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
