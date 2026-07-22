/**
 * Monthly income graph data — the income-side companion to {@link
 * import("./perLineBudget")} ("Base + Adjustments", issue #71).
 *
 * Income is deliberately NOT a budget line: spending is authored as `Plan.budgetLines`,
 * while income rides jobs and passive streams (§6/§17). So it gets its own graph rather
 * than a band on the budget chart — and that graph is what makes the shape of a
 * retirement legible: earnings stop at the last paycheck, there is a gap until the
 * claiming age, and the government benefit picks up from there.
 *
 * Bands are the engine's {@link TaxCategory} buckets, because that is the breakdown
 * `ProjectionMonthFlows` actually reports. Earned income is tagged `wages`, so a
 * paycheck reads apart from a pre-tax account draw (`ordinaryIncome`) — but the buckets
 * are still a tax classification, not a source list: two jobs share one band, and every
 * pre-tax account shares another. A true per-source breakdown needs the engine to
 * report income by source; see the issue linked from #71.
 *
 * A second limitation is invisible here by construction: while the liquid savings
 * account still covers the gap, the §5.1 cascade charges spending straight against it
 * and no withdrawal source is created — so a household living off its savings shows
 * ZERO income, not a drawdown band.
 *
 * Pure: the app passes the series in and this derives the chart shape, with no charting
 * library dependency (so it is unit-testable in node).
 */

import type { ProjectionSeries } from "@finley/engine";

/** One income band on the chart: a tax-category bucket and how to name it. */
export interface IncomeCategory {
  readonly id: string;
  readonly label: string;
}

/** One month's income row for the chart. */
export interface IncomeMonthRow {
  readonly month: number;
  /** Gross income this month, keyed by tax category. */
  readonly centsByCategory: Readonly<Record<string, number>>;
  readonly totalCents: number;
}

export interface IncomeChartData {
  readonly rows: readonly IncomeMonthRow[];
  /** Only the categories that actually carry money somewhere, in display order. */
  readonly categories: readonly IncomeCategory[];
  /** First month with no income at all, or `null` if income never stops. */
  readonly firstMonthWithNoIncome: number | null;
}

/**
 * Human labels for the engine's tax categories. `ordinaryIncome` is named for what it
 * actually contains rather than what it is usually made of — see the module note.
 */
const CATEGORY_LABELS: Record<string, string> = {
  wages: "Earned income",
  ordinaryIncome: "Pre-tax withdrawals",
  capitalGains: "Investment withdrawals",
  taxExempt: "Tax-exempt withdrawals",
  governmentRetirementBenefit: "Government benefit",
};

/** Stable display order; anything unrecognised sorts to the end, alphabetically. */
const CATEGORY_ORDER = [
  "wages",
  "ordinaryIncome",
  "capitalGains",
  "taxExempt",
  "governmentRetirementBenefit",
];

/**
 * Build the income chart data from a projection series. One row per *flowed* month
 * (month 0 is the flow-free opening snapshot, §4.6, so it is skipped). Categories that
 * are zero across the whole horizon are dropped, so a plan with no benefit or no
 * capital gains does not carry empty bands and an unexplained legend entry.
 */
export function buildIncomeChartData(series: ProjectionSeries): IncomeChartData {
  const rows: IncomeMonthRow[] = [];
  const seen = new Set<string>();
  let firstMonthWithNoIncome: number | null = null;

  for (const m of series.months) {
    const byCategory = m.flows?.incomeByCategoryCents;
    if (byCategory === undefined) continue; // month 0 / any flow-free snapshot

    let totalCents = 0;
    for (const [category, cents] of Object.entries(byCategory)) {
      if (cents !== 0) seen.add(category);
      totalCents += cents;
    }
    if (totalCents === 0 && firstMonthWithNoIncome === null) firstMonthWithNoIncome = m.month;
    rows.push({ month: m.month, centsByCategory: byCategory, totalCents });
  }

  const categories = [...seen]
    .sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a);
      const ib = CATEGORY_ORDER.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    })
    .map((id) => ({ id, label: CATEGORY_LABELS[id] ?? id }));

  return { rows, categories, firstMonthWithNoIncome };
}

/** Year (1-based) of an absolute month, for a human-facing "Year N" label. */
function yearOf(month: number): number {
  return Math.floor(month / 12) + 1;
}

/**
 * A one-line summary for the a11y label / status line, or `null` when income never
 * stops. Names the first month with no income at all — the retirement gap between the
 * last paycheck and the first benefit, which is the thing worth pointing at.
 */
export function describeIncomeGap(data: IncomeChartData): string | null {
  if (data.firstMonthWithNoIncome === null) return null;
  return (
    `No income from Year ${yearOf(data.firstMonthWithNoIncome)} — savings cover spending directly ` +
    `until the next source starts, which is why nothing is drawn here.`
  );
}
