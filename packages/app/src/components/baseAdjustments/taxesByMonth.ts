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
 * Only the TOTAL monthly tax is available: the engine computes it through the
 * jurisdiction seam as one number per person-month (`ProjectionMonthFlows.taxCents`), not
 * broken out by category — the jurisdiction owns that combination (brackets, the
 * capital-gains preference, benefit inclusion), so a per-category split is not the app's
 * to synthesize. One band, honestly.
 *
 * Pure: the app passes the series in and this derives the chart shape, with no charting
 * library dependency (so it is unit-testable in node).
 */

import type { ProjectionSeries } from "@finley/engine";

/** One month's tax row for the chart. */
export interface TaxMonthRow {
  readonly month: number;
  readonly taxCents: number;
}

export interface TaxChartData {
  readonly rows: readonly TaxMonthRow[];
  /** Total nominal tax paid across the whole horizon (the sum of every month). */
  readonly totalCents: number;
  /** The largest single month's tax, and the month it falls in — the visible peak. */
  readonly peakMonthlyCents: number;
  readonly peakMonth: number;
  /** False when the plan pays no tax anywhere (a null jurisdiction, or an all-exempt plan). */
  readonly hasAnyTax: boolean;
}

/**
 * Build the tax chart data from a projection series. One row per *flowed* month (month 0
 * is the flow-free opening snapshot, §4.6, so it is skipped), mirroring the income chart
 * exactly so the two line up point-for-point on the shared axis.
 */
export function buildTaxChartData(series: ProjectionSeries): TaxChartData {
  const rows: TaxMonthRow[] = [];
  let totalCents = 0;
  let peakMonthlyCents = 0;
  let peakMonth = 0;

  for (const m of series.months) {
    const flows = m.flows;
    if (flows === undefined) continue; // month 0 / any flow-free snapshot
    const taxCents = Math.max(0, flows.taxCents ?? 0);
    totalCents += taxCents;
    if (taxCents > peakMonthlyCents) {
      peakMonthlyCents = taxCents;
      peakMonth = m.month;
    }
    rows.push({ month: m.month, taxCents });
  }

  return { rows, totalCents, peakMonthlyCents, peakMonth, hasAnyTax: totalCents > 0 };
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
