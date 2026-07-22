/**
 * Per-line monthly budget graph data (§Q27, "Base + Adjustments", issue #71, AC2).
 *
 * Turns a {@link ProjectionResult}'s series into the per-line rows a budget chart draws:
 * one band per standing budget line, at the amount that line actually costs in each
 * month (span and dated overrides applied, price growth accrued).
 *
 * It deliberately does **not** ration a tight month across the §15 priority order. The
 * simulator never skips spending, so drawing a line below its amount would depict money
 * the household did in fact spend; and the point where the plan genuinely stops working
 * is insolvency, which is reported here as its own fact ({@link insolventFromMonth})
 * rather than by quietly shrinking the user's discretionary bands. Deciding what to cut
 * when a plan breaks is the user's call.
 *
 * Reads `month.flows.lineMonthlyCents`, keyed by the `allocations()` id. Pure: the app
 * passes in the series and the standing lines; this derives the chart shape and the
 * summary, with no charting library dependency (so it is unit-testable in node).
 */

import type { ProjectionSeries } from "@finley/engine";

/** One standing budget line as the chart tracks it: its `allocations()` id + label. */
export interface ChartLine {
  /** The `allocations()` id (`line:<id>`) the engine keys the per-line map by. */
  readonly id: string;
  readonly label: string;
}

/** One month's per-line row for the chart. */
export interface PerLineMonthRow {
  readonly month: number;
  /** This month's cost per line, keyed by line id (0 for a line not active then). */
  readonly centsByLine: Readonly<Record<string, number>>;
  readonly totalCents: number;
}

/** The whole chart's derived data plus the plan-health summary. */
export interface PerLineBudgetData {
  readonly rows: readonly PerLineMonthRow[];
  /**
   * First month the §5.1 cascade exhausted savings AND credit — the point the plan
   * stops being financeable. `null` when the plan holds across the whole horizon.
   */
  readonly insolventFromMonth: number | null;
  /** The lines tracked, echoed so the chart can render one series per line in order. */
  readonly lines: readonly ChartLine[];
}

/**
 * Build the per-line budget chart data from a projection series (AC2). One row per
 * *flowed* month (month 0 is the flow-free opening snapshot, §4.6, so it is skipped);
 * each line's amount is read from the month's `lineMonthlyCents`, defaulting a missing
 * entry to 0 (the line is not active that month — e.g. past the end of its span).
 */
export function buildPerLineBudgetData(
  series: ProjectionSeries,
  lines: readonly ChartLine[],
): PerLineBudgetData {
  const rows: PerLineMonthRow[] = [];
  let insolventFromMonth: number | null = null;

  for (const m of series.months) {
    if (m.isInsolvent && insolventFromMonth === null) insolventFromMonth = m.month;

    const monthly = m.flows?.lineMonthlyCents;
    if (monthly === undefined) continue; // month 0 / any flow-free snapshot

    const centsByLine: Record<string, number> = {};
    let totalCents = 0;
    for (const line of lines) {
      const cents = monthly[line.id] ?? 0;
      centsByLine[line.id] = cents;
      totalCents += cents;
    }
    rows.push({ month: m.month, centsByLine, totalCents });
  }

  return { rows, insolventFromMonth, lines };
}

/** Year (1-based) of an absolute month, for a human-facing "Year N" label. */
function yearOf(month: number): number {
  return Math.floor(month / 12) + 1;
}

/**
 * A one-line, human-readable summary for the a11y label / status line (AC2), or `null`
 * when the plan finances the whole budget across the horizon. Names the year the plan
 * runs out rather than naming a line to cut — which spending to give up at that point
 * is the user's decision, not one the graph should make for them.
 */
export function describeInsolvency(data: PerLineBudgetData): string | null {
  if (data.insolventFromMonth === null) return null;
  return (
    `From Year ${yearOf(data.insolventFromMonth)} this budget is no longer financeable — ` +
    `savings and credit are exhausted. Something has to change.`
  );
}
