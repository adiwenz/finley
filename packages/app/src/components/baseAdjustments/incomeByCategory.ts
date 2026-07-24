/**
 * Monthly income graph data — the income-side companion to {@link
 * import("./perLineBudget")} ("Base + Adjustments", issue #71), reporting income
 * **by source** (issue #99).
 *
 * Income is deliberately NOT a budget line: spending is authored as `Plan.budgetLines`,
 * while income rides jobs and passive streams (§6/§17). So it gets its own graph rather
 * than a band on the budget chart — and that graph is what makes the shape of a
 * retirement legible: earnings stop at the last paycheck, there is a gap until the
 * claiming age, and the government benefit picks up from there.
 *
 * Bands are the engine's per-source flows (`ProjectionMonthFlows.incomeSources`), not
 * tax-category buckets, so each band names its own source: *which* job pays, *which*
 * account a decumulation draw drains. The previous version banded by {@link
 * import("@finley/engine").ProjectionMonthFlows.incomeByCategoryCents} — a tax
 * classification — which forced hedged labels ("Pre-tax withdrawals" covered every
 * pre-tax account) and collapsed two jobs into one band; issue #99 replaced that.
 *
 * It also surfaces the **savings drawdown**: while cash savings cover the retirement
 * gap the engine reports a `savingsDrawdown` source rather than nothing, so "living off
 * savings" reads as its own band instead of a misleading flat zero.
 *
 * Pure: the app passes the series in and this derives the chart shape, with no charting
 * library dependency (so it is unit-testable in node).
 */

import type { IncomeSourceCategory, ProjectionSeries } from "@finley/engine";

/** One income band on the chart: a source, how to name it, and its provenance. */
export interface IncomeSourceBand {
  /** The engine's stable `sourceId` — the band's identity across months. */
  readonly id: string;
  readonly label: string;
  /** Provenance category, driving band colour and display order. */
  readonly category: IncomeSourceCategory;
}

/** One month's income row for the chart. */
export interface IncomeMonthRow {
  readonly month: number;
  /** Gross cash this month, keyed by source id. */
  readonly centsBySource: Readonly<Record<string, number>>;
  readonly totalCents: number;
}

export interface IncomeChartData {
  readonly rows: readonly IncomeMonthRow[];
  /** Only the sources that actually carry money somewhere, in display order. */
  readonly sources: readonly IncomeSourceBand[];
  /**
   * First month with no income AND no savings drawdown — a genuine nothing, which under
   * a solvent plan should not happen (the gap is now a drawdown band). `null` otherwise.
   */
  readonly firstMonthWithNoIncome: number | null;
  /** First month funded by drawing down cash savings, or `null` if that never happens. */
  readonly firstSavingsDrawdownMonth: number | null;
}

/**
 * Stable display order by provenance category: earned income, then withdrawals by tax
 * friction, then the government benefit, and the savings drawdown last (it is not income,
 * so it reads beneath the real sources). Anything unrecognised sorts to the very end.
 */
const CATEGORY_ORDER: readonly IncomeSourceCategory[] = [
  "wages",
  "ordinaryIncome",
  "capitalGains",
  "taxExempt",
  "governmentRetirementBenefit",
  "savingsDrawdown",
];

function categoryRank(category: string): number {
  const i = CATEGORY_ORDER.indexOf(category as IncomeSourceCategory);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

/**
 * Build the income chart data from a projection series. One row per *flowed* month
 * (month 0 is the flow-free opening snapshot, §4.6, so it is skipped). Sources that
 * carry nothing across the whole horizon are dropped, so a plan with no benefit or no
 * drawdown does not carry an empty band and an unexplained legend entry.
 */
export function buildIncomeChartData(series: ProjectionSeries): IncomeChartData {
  const rows: IncomeMonthRow[] = [];
  // First-seen label/category per source id, and whether it ever carried money.
  const seen = new Map<string, IncomeSourceBand>();
  const order: string[] = [];
  let firstMonthWithNoIncome: number | null = null;
  let firstSavingsDrawdownMonth: number | null = null;

  for (const m of series.months) {
    const sources = m.flows?.incomeSources;
    if (sources === undefined) continue; // month 0 / any flow-free snapshot

    const centsBySource: Record<string, number> = {};
    let totalCents = 0;
    for (const s of sources) {
      if (s.grossCents === 0) continue;
      centsBySource[s.sourceId] = (centsBySource[s.sourceId] ?? 0) + s.grossCents;
      totalCents += s.grossCents;
      if (!seen.has(s.sourceId)) {
        seen.set(s.sourceId, { id: s.sourceId, label: s.label, category: s.category });
        order.push(s.sourceId);
      }
      if (s.category === "savingsDrawdown" && firstSavingsDrawdownMonth === null) {
        firstSavingsDrawdownMonth = m.month;
      }
    }
    if (totalCents === 0 && firstMonthWithNoIncome === null) firstMonthWithNoIncome = m.month;
    rows.push({ month: m.month, centsBySource, totalCents });
  }

  const sources = order
    .map((id) => seen.get(id)!)
    // Sort by category order, ties broken by first-appearance (already in `order`).
    .sort((a, b) => categoryRank(a.category) - categoryRank(b.category));

  return { rows, sources, firstMonthWithNoIncome, firstSavingsDrawdownMonth };
}

/** Year (1-based) of an absolute month, for a human-facing "Year N" label. */
function yearOf(month: number): number {
  return Math.floor(month / 12) + 1;
}

/**
 * A one-line summary for the a11y label / status line, or `null` when income runs
 * continuously with no savings drawdown. Names the retirement gap for what it actually
 * is — a stretch lived off savings, drawn as its own band — rather than the old,
 * misleading "no income" framing (issue #99).
 */
export function describeIncomeGap(data: IncomeChartData): string | null {
  if (data.firstSavingsDrawdownMonth !== null) {
    return (
      `From Year ${yearOf(data.firstSavingsDrawdownMonth)} you're living off savings — ` +
      `the drawdown band is spending covered by cash, not income.`
    );
  }
  if (data.firstMonthWithNoIncome !== null) {
    return (
      `No income and no savings left from Year ${yearOf(data.firstMonthWithNoIncome)} — ` +
      `nothing is covering spending here.`
    );
  }
  return null;
}
