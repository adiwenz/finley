/**
 * Per-line monthly budget graph data (§Q27, "Base + Adjustments", issue #71, AC2).
 *
 * Turns a {@link ProjectionResult}'s series into the per-line rows a budget chart draws:
 * one band per standing budget line, at the amount that line actually costs in each
 * month (span and dated overrides applied, price growth accrued) — **plus one band per
 * debt being serviced**, at the payment actually applied that month.
 *
 * The graph draws **everything the month costs**, in three kinds of band:
 *
 *   - the authored budget lines (tiered earth palette) — the part the user edits here;
 *   - other spending (slate): health care, and whatever the timeline added (a child's
 *     cost, alimony, an expense event) — real money, but not authored as a line;
 *   - debt service (rust): each liability's payment, which §3 computes from
 *     balance/rate/term and never expresses as an expense line at all.
 *
 * The last two are drawn precisely *because* they are not budget lines. Money that
 * leaves the household every month and appears in no band reads as money not spent: a
 * household paying a student loan saw a $3,000 budget while $3,950 left its account.
 * With all three kinds drawn, a month's stack totals exactly the obligation the income
 * graph's spending-need line plots — the two graphs are the same quantity, split by
 * where it goes and covered by what pays for it (pinned by test).
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
import type { SpendingBand } from "../../ledgerView";

/** One standing budget line as the chart tracks it: its `allocations()` id + label. */
export interface ChartLine {
  /** The `allocations()` id (`line:<id>`) the engine keys the per-line map by. */
  readonly id: string;
  readonly label: string;
}

/**
 * A band on the graph: an authored budget line, other spending, or a debt's monthly
 * payment. `kind` is what the chart colours by — these are different sorts of money
 * (chosen and editable here, owed, or simply carried), so they must not read as peers.
 */
export interface ChartBand extends ChartLine {
  readonly kind: "line" | "other" | "debt";
}

/** Band id for a debt's payment band — namespaced so it can't collide with `line:<id>`. */
export function debtBandId(liabilityId: string): string {
  return `debt:${liabilityId}`;
}

/** Band id for a non-line spending stream (health, an event's expense). */
export function spendingBandId(seriesId: string): string {
  return `spend:${seriesId}`;
}

/** What the chart draws, beyond the months themselves. */
export interface BudgetChartInput {
  /** The standing budget lines, in the order the editor lists them. */
  readonly lines: readonly ChartLine[];
  /** Health care and timeline-added expenses — spending that authors no line. */
  readonly otherSpending?: readonly SpendingBand[];
  /** Plain-language name per liability id, for the debt bands. */
  readonly debtLabels?: Readonly<Record<string, string>>;
}

/** One month's per-band row for the chart. */
export interface PerLineMonthRow {
  readonly month: number;
  /** This month's cost per band, keyed by band id (0 for a band inactive then). */
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
  /**
   * The bands tracked, echoed so the chart can render one series per band in order:
   * the budget lines as given, then a band per debt serviced anywhere in the horizon.
   */
  readonly lines: readonly ChartBand[];
}

/**
 * Every debt the projection services anywhere in the horizon, as its own band, in the
 * order the payments first appear. A debt is discovered from the series rather than
 * declared by the caller: liabilities arrive from the timeline (and the synthetic
 * shortfall card is minted by the simulator itself), so the months are the only place
 * that knows the full set. `labels` names them; an id with no label — a debt kind the
 * app has no wording for — still gets a band, under a plain fallback, because dropping
 * it would silently shrink the total.
 */
function debtBandsOf(
  series: ProjectionSeries,
  labels: Readonly<Record<string, string>>,
): ChartBand[] {
  const bands: ChartBand[] = [];
  const seen = new Set<string>();
  for (const m of series.months) {
    for (const [liabilityId, record] of Object.entries(m.liabilityPaymentRecords)) {
      if (record.amountAppliedCents <= 0 || seen.has(liabilityId)) continue;
      seen.add(liabilityId);
      bands.push({
        id: debtBandId(liabilityId),
        label: labels[liabilityId] ?? "Debt payment",
        kind: "debt",
      });
    }
  }
  return bands;
}

/**
 * Build the budget chart data from a projection series (AC2). One row per *flowed*
 * month (month 0 is the flow-free opening snapshot, §4.6, so it is skipped); each
 * line's amount is read from the month's `lineMonthlyCents`, defaulting a missing entry
 * to 0 (the line is not active that month — e.g. past the end of its span), each other
 * stream's from its own compiled series, and each debt's from that month's payment
 * record (0 in a month with nothing due).
 *
 * A stream that carries nothing anywhere in the horizon gets no band: a plan with no
 * health line should not drag an empty "Healthcare" band and an unexplained tooltip row
 * through forty years.
 */
export function buildPerLineBudgetData(
  series: ProjectionSeries,
  input: BudgetChartInput,
): PerLineBudgetData {
  const { lines, otherSpending = [], debtLabels = {} } = input;
  const rows: PerLineMonthRow[] = [];
  let insolventFromMonth: number | null = null;

  const spending = otherSpending.filter((s) =>
    series.months.some((m) => s.monthlyCentsAt(m.month) > 0),
  );
  const bands: ChartBand[] = [
    ...lines.map((l): ChartBand => ({ ...l, kind: "line" })),
    ...spending.map((s): ChartBand => ({ id: spendingBandId(s.id), label: s.label, kind: "other" })),
    ...debtBandsOf(series, debtLabels),
  ];

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
    for (const stream of spending) {
      const cents = stream.monthlyCentsAt(m.month);
      centsByLine[spendingBandId(stream.id)] = cents;
      totalCents += cents;
    }
    // What was actually applied against each debt this month — the same figure the
    // simulator charged, so a payoff-capped final payment draws as the smaller amount
    // it really was, and a paid-off debt's band simply stops.
    for (const [liabilityId, record] of Object.entries(m.liabilityPaymentRecords)) {
      const cents = Math.max(0, record.amountAppliedCents);
      centsByLine[debtBandId(liabilityId)] = cents;
      totalCents += cents;
    }
    rows.push({ month: m.month, centsByLine, totalCents });
  }

  return { rows, insolventFromMonth, lines: bands };
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
