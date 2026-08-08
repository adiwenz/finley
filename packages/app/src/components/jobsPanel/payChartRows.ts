/**
 * What the pay chart PLOTS — the sampling policy, separated from the SVG that draws it.
 *
 * This is the chart's own contract and nobody else's. The engine says what a job pays in a given
 * month ({@link JobPayPath.monthlyCentsAt}) and how several one-month adjustments fold together
 * in one ({@link applyJobIncomeOverridesAt}); neither has an opinion about which months a picture
 * of that should sample, and that choice is the whole reason this file exists. Drawn wrong, the
 * arithmetic underneath can be perfect and the chart still lies — a bonus smeared across a
 * quarter, or "now" landing on no sample at all.
 *
 * Pure, and tested in Node (`payChartRows.test.ts`): every claim here is about months and
 * flags, and none of it needs a browser to be true.
 */

import {
  applyJobIncomeOverridesAt,
  payChangeEffectiveMonth,
  type JobIncomeOverride,
  type JobPayChange,
  type JobPayPath,
} from "@finley/engine";

/** One plotted point: the month, what it pays, and whether that figure is a payment or a rate. */
export interface PayChartRow {
  readonly month: number;
  /** Standing pay with every adjustment dated at this month folded over it, in cents. */
  readonly pay: number;
  /** True where a one-month adjustment lands — the tooltip says "this month", not "/mo". */
  readonly adjusted: boolean;
}

/** Every third month, plus the months that mean something. */
export function payChartMonths({
  firstMonth,
  lastMonth,
  path,
  payChanges,
  incomeOverrides,
}: {
  readonly firstMonth: number;
  readonly lastMonth: number;
  readonly path: Pick<JobPayPath, "span">;
  readonly payChanges: readonly JobPayChange[];
  readonly incomeOverrides: readonly JobIncomeOverride[];
}): number[] {
  /**
   * A lifetime is ~1,080 months and the plot is under 1,000px, so one row per month cannot work:
   * the tooltip snaps to the NEAREST row, and with more rows than pixels some are never the
   * nearest — month 0 among them, which made "now" the one month unreadable. Nothing is lost by
   * thinning, because pay is piecewise constant: within a flat stretch every month carries the
   * same figure.
   *
   * So: a quarterly backbone, plus every month that actually MEANS something.
   */
  const months = new Set<number>();
  for (let month = firstMonth; month <= lastMonth; month += 3) months.add(month);
  const keyMonths = [
    firstMonth,
    lastMonth,
    0, // "now" — the seam, and the whole reason this chart exists
    path.span.startMonth,
    path.span.endMonthExclusive,
    ...payChanges.map(payChangeEffectiveMonth),
    // A one-month adjustment needs BOTH its own month and the one after it. Its own, because the
    // quarterly backbone would miss two months in three; the one after, because `stepAfter`
    // holds a sample until the next one — without it the bonus would be drawn as lasting a whole
    // quarter. The pair is what makes the spike exactly one month wide.
    ...incomeOverrides.flatMap((o) => [o.month, o.month + 1]),
  ];
  for (const month of keyMonths) {
    if (month >= firstMonth && month <= lastMonth) months.add(month);
  }
  return [...months].sort((a, b) => a - b);
}

/**
 * The plotted rows, in month order.
 *
 * A one-month adjustment rides the pay series itself, so the shaded region briefly rises and
 * falls back — the same way a bonus reads on the household income charts, where a month that
 * pays more is simply drawn taller. The staircase can carry it because {@link payChartMonths}
 * pins the month AND its successor: the spike is one month wide, which is a blip and not a
 * raise-then-cut.
 *
 * Several adjustments may share a month. They are folded through the engine's own
 * {@link applyJobIncomeOverridesAt}, so the spike is drawn at what the projection pays rather
 * than at whichever one the chart happened to look at last.
 */
export function payChartRows({
  firstMonth,
  lastMonth,
  path,
  payChanges,
  incomeOverrides,
}: {
  readonly firstMonth: number;
  readonly lastMonth: number;
  readonly path: JobPayPath;
  readonly payChanges: readonly JobPayChange[];
  readonly incomeOverrides: readonly JobIncomeOverride[];
}): PayChartRow[] {
  const adjustedMonths = new Set(incomeOverrides.map((o) => o.month));
  return payChartMonths({ firstMonth, lastMonth, path, payChanges, incomeOverrides }).map(
    (month) => ({
      month,
      pay: applyJobIncomeOverridesAt(path.monthlyCentsAt(month), incomeOverrides, month),
      adjusted: adjustedMonths.has(month),
    }),
  );
}

/**
 * The one-month marks, as the chart's data mirror states them: `[month, what it pays]` for the
 * adjusted months only.
 */
export const payChartOneOffMarks = (rows: readonly PayChartRow[]): [number, number][] =>
  rows.filter((r) => r.adjusted).map((r) => [r.month, r.pay]);
