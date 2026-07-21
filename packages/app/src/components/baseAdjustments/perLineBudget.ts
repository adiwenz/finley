/**
 * Per-line monthly budget graph data (§Q27, "Base + Adjustments", issue #71, AC2).
 *
 * Turns a {@link ProjectionResult}'s series into the per-line *actually funded* rows a
 * budget chart draws, and detects the **starved** months — where the §15 waterfall
 * could not fund a line to its intent (Plan). That gap between intent and funding is
 * the interesting thing to graph: it is where a shortfall bites, and which line it hit.
 *
 * Reads `month.flows.lineFundedCents` (the engine's per-line funded map, keyed by the
 * `allocations()` id) against the caller's `intendedCents` per line. Pure: the app
 * passes in the series and the standing line intents; this derives the chart shape and
 * the summary, with no charting library dependency (so it is unit-testable in node).
 */

import type { ProjectionSeries } from "@finley/engine";

/** One standing budget line as the chart tracks it: its `allocations()` id + intent. */
export interface ChartLine {
  /** The `allocations()` id (`line:<id>`) the engine keys the funded map by. */
  readonly id: string;
  readonly label: string;
  /** The line's intended (Plan) monthly amount — what full funding looks like. */
  readonly intendedCents: number;
}

/** One month's per-line funding row for the chart. */
export interface PerLineMonthRow {
  readonly month: number;
  /** Funded cents this month, keyed by line id (0 for a line with no funded entry). */
  readonly fundedByLine: Readonly<Record<string, number>>;
  readonly intendedTotalCents: number;
  readonly fundedTotalCents: number;
  /** True when total funding fell below total intent — a shortfall month. */
  readonly starved: boolean;
  /** The lines funded below their intent this month, in line order. */
  readonly starvedLineIds: readonly string[];
}

/** The whole chart's derived data plus the shortfall summary. */
export interface PerLineBudgetData {
  readonly rows: readonly PerLineMonthRow[];
  readonly starvedMonths: readonly number[];
  readonly hasShortfall: boolean;
  /** The lines tracked, echoed so the chart can render one series per line in order. */
  readonly lines: readonly ChartLine[];
}

/**
 * Build the per-line budget chart data from a projection series (AC2). One row per
 * *flowed* month (month 0 is the flow-free opening snapshot, §4.6, so it is skipped);
 * each line's funded amount is read from the month's `lineFundedCents`, defaulting a
 * missing entry to 0 (fully starved). A line is "starved" in a month when its funding
 * is below its intent; a month is "starved" when any line is.
 */
export function buildPerLineBudgetData(
  series: ProjectionSeries,
  lines: readonly ChartLine[],
): PerLineBudgetData {
  const rows: PerLineMonthRow[] = [];
  const starvedMonths: number[] = [];

  for (const m of series.months) {
    const funded = m.flows?.lineFundedCents;
    if (funded === undefined) continue; // month 0 / any flow-free snapshot

    const fundedByLine: Record<string, number> = {};
    const starvedLineIds: string[] = [];
    let fundedTotalCents = 0;
    let intendedTotalCents = 0;
    for (const line of lines) {
      const got = funded[line.id] ?? 0;
      fundedByLine[line.id] = got;
      fundedTotalCents += got;
      intendedTotalCents += line.intendedCents;
      if (got < line.intendedCents) starvedLineIds.push(line.id);
    }

    const starved = fundedTotalCents < intendedTotalCents;
    if (starved) starvedMonths.push(m.month);
    rows.push({
      month: m.month,
      fundedByLine,
      intendedTotalCents,
      fundedTotalCents,
      starved,
      starvedLineIds,
    });
  }

  return {
    rows,
    starvedMonths,
    hasShortfall: starvedMonths.length > 0,
    lines,
  };
}

/** Year (1-based) of an absolute month, for a human-facing "Year N" label. */
function yearOf(month: number): number {
  return Math.floor(month / 12) + 1;
}

/**
 * A one-line, human-readable summary of the first shortfall for the a11y label /
 * status line (AC2), or `null` when the budget is fully funded throughout. Names the
 * first starved month and the lines the waterfall starved there.
 */
export function describeStarvation(data: PerLineBudgetData): string | null {
  const first = data.rows.find((r) => r.starved);
  if (first === undefined) return null;
  const byId = new Map(data.lines.map((l) => [l.id, l.label]));
  const names = first.starvedLineIds.map((id) => byId.get(id) ?? id).join(", ");
  return `Shortfall from Year ${yearOf(first.month)}: starved ${names}.`;
}
