/**
 * Monthly tax-paid graph data — third companion to the income ({@link
 * import("./incomeByCategory")}) and per-line budget ({@link import("./perLineBudget")})
 * charts, sharing their x-axis and month-selection gesture.
 *
 * Tax is the household's least visible outflow: never a budget line, netted out of every
 * drawdown at the chokepoint, so the charts above show gross income and gross spending
 * with the tax between them implicit. This makes it explicit, including how the shape
 * moves as earned income gives way to withdrawals and the government benefit.
 *
 * It STACKS BY INCOME SOURCE, mirroring the income chart: the jurisdiction owns category
 * attribution (US tax is not linearly separable — progressive brackets, the capital-gains
 * preference, benefit inclusion) and the engine splits each category's tax across its
 * sources by taxable weight into `ProjectionMonthFlows.taxBySourceCents`. So a two-earner
 * household sees *which job* is taxed, not one lumped `wages` band. Bands colour and order
 * by provenance category (wages, then the benefit, then drawdown-side) to match the income
 * chart. Attribution is required of every jurisdiction and enforced to reconcile, so a
 * plan that pays tax always stacks per source; a zero-tax plan has no bands.
 *
 * ⚠ The per-source split is proportional (average-rate), not marginal — disclosed as
 * `taxAttributionProportional`. A second job really costs more than its average share.
 *
 * Pure, with no charting-library dependency, so it is unit-testable in node.
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
  /** Total tax this month — Σ of the per-source bands, and the value drawn when zero-tax. */
  readonly taxCents: number;
  /** This month's tax keyed by source id; empty when no per-source breakdown is reported. */
  readonly centsBySource: Readonly<Record<string, number>>;
}

export interface TaxChartData {
  readonly rows: readonly TaxMonthRow[];
  /**
   * Income sources carrying tax somewhere, in stable stacking order. Empty only for a
   * zero-tax plan, which attributes nothing. Sources zero across the whole horizon are
   * dropped, so no legend entry is empty.
   */
  readonly sources: readonly TaxSourceBand[];
  /** True when any tax was attributed to a source; false for a zero-tax plan. */
  readonly hasSourceBreakdown: boolean;
  /** Total nominal tax across the whole horizon. */
  readonly totalCents: number;
  /** The largest single month's tax and the month it falls in — the visible peak. */
  readonly peakMonthlyCents: number;
  readonly peakMonth: number;
  /** False when the plan pays no tax anywhere (a null jurisdiction, or an all-exempt plan). */
  readonly hasAnyTax: boolean;
}

/**
 * Labels for a source keyed only by its tax CATEGORY — the engine's fallback key for an
 * untitled source (e.g. a wage stream with no job id). A real job bands under its own
 * name; these keep a category-keyed band readable.
 */
const TAX_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  wages: "Wages",
  governmentRetirementBenefit: "Social Security",
  ordinaryIncome: "Ordinary income",
  capitalGains: "Capital gains",
  taxExempt: "Tax-exempt",
};

/**
 * Stacking order (bottom → top) by provenance category, matching the income chart: wages
 * at the base, then the government benefit, then drawdown-side. Unrecognised sorts last.
 */
const CATEGORY_ORDER: readonly IncomeSourceCategory[] = [
  "wages",
  "governmentRetirementBenefit",
  "savingsInterest",
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
 * Name a tax source with no income band to borrow a label from — an untitled stream the
 * engine keyed by its bare tax category. (A source with real provenance, e.g. a job or
 * savings interest, appears on the income side and lends its label via the registry.)
 * Reading the category off the key keeps the anonymous bucket readable and sorted/coloured
 * with its category. Display fallback only: it assigns no business meaning — what counts
 * as "savings interest" is the engine's provenance. Unrecognised keeps its id, sorts last.
 */
function bandForTaxOnlyKey(id: string): TaxSourceBand {
  const trailing = id.split(":").pop() ?? id;
  if (TAX_CATEGORY_LABELS[trailing]) return { id, label: TAX_CATEGORY_LABELS[trailing]!, category: trailing };
  if (TAX_CATEGORY_LABELS[id]) return { id, label: TAX_CATEGORY_LABELS[id]!, category: id };
  return { id, label: id, category: id };
}

/**
 * Tax chart data from a projection series. One row per *flowed* month — month 0 is the
 * flow-free opening snapshot and is skipped — mirroring the income chart so the two line
 * up point-for-point on the shared axis.
 *
 * Each row keeps the split from the required `taxBySourceCents`, whose Σ equals `taxCents`
 * by enforced contract; the union of sources that ever carry tax becomes the bands, named
 * from the month's `incomeSources` where available. A zero-tax plan attributes nothing, so
 * `sources` is empty and every row's `taxCents` is 0.
 */
export function buildTaxChartData(series: ProjectionSeries): TaxChartData {
  const rows: TaxMonthRow[] = [];
  let totalCents = 0;
  let peakMonthlyCents = 0;
  let peakMonth = 0;
  let hasSourceBreakdown = false;
  // Label/category per source id, learned from the income-source flows (which name each
  // job, and savings interest as its own band); no income band falls back to a category
  // label below.
  const registry = new Map<string, { label: string; category: string }>();
  // Sources that ever carried positive tax — drives the bands, in first-appearance order
  // (a Map preserves insertion order).
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

    // The breakdown is always present (`{}` in a zero-tax month). A source appears
    // only for tax it actually bore.
    const centsBySource: Record<string, number> = {};
    for (const [sourceId, cents] of Object.entries(flows.taxBySourceCents ?? {})) {
      const value = Math.max(0, cents ?? 0);
      if (value === 0) continue;
      hasSourceBreakdown = true;
      centsBySource[sourceId] = (centsBySource[sourceId] ?? 0) + value;
      sourceTotals.set(sourceId, (sourceTotals.get(sourceId) ?? 0) + value);
    }
    rows.push({ month: m.month, taxCents, centsBySource });
  }

  const sources: TaxSourceBand[] = [...sourceTotals.keys()]
    .map((id) => {
      const known = registry.get(id);
      if (known !== undefined) return { id, label: known.label, category: known.category };
      // No income band to borrow a name from — an untitled stream keyed by its bare tax
      // category. (Savings interest is NOT this case: it has an income band.)
      return bandForTaxOnlyKey(id);
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
 * One-line summary for the a11y label / status line: lifetime total and where the monthly
 * bill peaks. `null` when the plan pays no tax at all.
 */
export function describeTaxes(data: TaxChartData): string | null {
  if (!data.hasAnyTax) return null;
  return (
    `${dollars(data.totalCents)} in tax over the plan, peaking around ` +
    `${dollars(data.peakMonthlyCents)}/mo in Year ${yearOf(data.peakMonth)}. Federal income tax only.`
  );
}
