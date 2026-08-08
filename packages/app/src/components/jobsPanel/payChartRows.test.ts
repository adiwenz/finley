/**
 * The pay chart's sampling policy — which months it plots, and which of them are payments
 * rather than rates.
 *
 * This is the app's own contract and nothing below it has an opinion on it. What a job pays in a
 * month is the engine's (`job.payPath.test.ts`), and how several adjustments dated at one month
 * fold together is the engine's too (`job.adjustments.test.ts` — `applyJobIncomeOverride`, "the
 * one definition of what an adjustment means"). Neither knows or cares that a picture of it is
 * ~1,000 pixels wide, which is the entire subject here.
 *
 * The stand-in path is deliberately trivial — flat pay, no growth, no seam — so every figure
 * below is about the SAMPLING and never about arithmetic this file does not own. A test that
 * needed a real salary curve to make its point would be a test written at the wrong layer.
 */

import { describe, expect, it } from "vitest";
import { dollarsToCents, type JobIncomeOverride, type JobPayChange, type JobPayPath } from "@finley/engine";
import { payChartMonths, payChartOneOffMarks, payChartRows } from "./payChartRows";

const FLAT = dollarsToCents(5_000);

/** A job paying the same thing every month it runs, and nothing outside its span. */
const flatPath = (startMonth = 0, endMonthExclusive = 360): JobPayPath => ({
  span: { startMonth, endMonthExclusive },
  endedBeforeNow: endMonthExclusive <= 0,
  monthlyCentsAt: (month) => (month >= startMonth && month < endMonthExclusive ? FLAT : 0),
  historyReachMonthlyCents: null,
  monthZeroStepCents: 0,
});

const bonus = (month: number, dollars: number): JobIncomeOverride => ({
  id: `a-${month}-${dollars}`,
  month,
  kind: "addBonus",
  cents: dollarsToCents(dollars),
});

const rowsOf = (
  incomeOverrides: readonly JobIncomeOverride[] = [],
  payChanges: readonly JobPayChange[] = [],
  path = flatPath(),
) => payChartRows({ firstMonth: -120, lastMonth: 600, path, payChanges, incomeOverrides });

describe("payChartMonths — a quarterly backbone, plus the months that mean something", () => {
  const months = (
    incomeOverrides: readonly JobIncomeOverride[] = [],
    payChanges: readonly JobPayChange[] = [],
    path = flatPath(),
  ) => payChartMonths({ firstMonth: -120, lastMonth: 600, path, payChanges, incomeOverrides });

  it("samples every third month across the whole axis, in order", () => {
    const backbone = months();
    expect(backbone[0]).toBe(-120);
    expect(backbone.at(-1)).toBe(600);
    expect([...backbone].sort((a, b) => a - b)).toEqual(backbone);
  });

  it("always samples month 0, whatever the backbone lands on", () => {
    // "Now" is the seam the whole chart exists to draw. A backbone starting anywhere but a
    // multiple of 3 from 0 would step straight over it, and the tooltip would have no row to
    // snap to on the one month that matters most.
    const offAxis = payChartMonths({
      firstMonth: -119,
      lastMonth: 600,
      path: flatPath(),
      payChanges: [],
      incomeOverrides: [],
    });
    expect(offAxis).toContain(0);
  });

  it("samples both ends of the job's own span", () => {
    const withSpan = months([], [], flatPath(7, 401));
    expect(withSpan).toContain(7);
    expect(withSpan).toContain(401);
  });

  it("samples the month a pay change takes force", () => {
    // Month 13 is off the quarterly backbone; a raise drawn at month 12 or 15 is a raise drawn
    // in the wrong month.
    const change: JobPayChange = { id: "p1", month: 13, kind: "setTo", cents: FLAT };
    expect(months([], [change])).toContain(13);
  });

  it("samples a one-off's month AND the month after it — that pair is what makes the spike one month wide", () => {
    // `stepAfter` holds a sample until the next one, so without month+1 a bonus at month 13
    // would be drawn as lasting until the next quarterly sample.
    const sampled = months([bonus(13, 4_000)]);
    expect(sampled).toContain(13);
    expect(sampled).toContain(14);
  });

  it("keeps every sample inside the axis, so nothing is plotted off the end", () => {
    // A bonus in the final month would otherwise pin month+1 past `lastMonth`.
    const sampled = payChartMonths({
      firstMonth: 0,
      lastMonth: 600,
      path: flatPath(),
      payChanges: [{ id: "p1", month: 900, kind: "setTo", cents: FLAT }],
      incomeOverrides: [bonus(600, 1_000)],
    });
    expect(sampled.every((m) => m >= 0 && m <= 600)).toBe(true);
  });

  it("samples each month once, however many things land on it", () => {
    const sampled = months([bonus(12, 4_000), bonus(12, 1_000)], [
      { id: "p1", month: 12, kind: "setTo", cents: FLAT },
    ]);
    expect(sampled.filter((m) => m === 12)).toHaveLength(1);
  });
});

describe("payChartRows — what each plotted month says", () => {
  it("flags exactly the months carrying a one-month adjustment", () => {
    // The flag is what makes the tooltip say "this month" instead of "/mo": the height there is
    // a payment, not a salary.
    const adjusted = rowsOf([bonus(12, 4_000)]).filter((r) => r.adjusted);
    expect(adjusted.map((r) => r.month)).toEqual([12]);
  });

  it("leaves an unadjusted month at the standing pay the path reports", () => {
    const row = rowsOf([bonus(12, 4_000)]).find((r) => r.month === 15);
    expect(row?.pay).toBe(FLAT);
    expect(row?.adjusted).toBe(false);
  });

  it("draws the month after a one-off back at standing pay — the spike falls, it does not hold", () => {
    expect(rowsOf([bonus(12, 4_000)]).find((r) => r.month === 13)?.pay).toBe(FLAT);
  });

  it("folds a month's whole stack through the engine, rather than drawing whichever it saw last", () => {
    // Two adjustments in one month are ONE mark at the folded figure. Drawing only the last
    // would understate a double bonus — and which figure the fold produces is the engine's
    // ("composes by folding, which is the whole of what stacking is").
    const marks = payChartOneOffMarks(rowsOf([bonus(12, 4_000), bonus(12, 1_000)]));
    expect(marks).toHaveLength(1);
    expect(marks[0]![0]).toBe(12);
    expect(marks[0]![1]).toBeGreaterThan(rowsOf([bonus(12, 4_000)])[0]!.pay);
  });

  it("marks nothing at all on a job with no adjustments", () => {
    expect(payChartOneOffMarks(rowsOf())).toEqual([]);
  });

  it("states each mark as [month, what that month pays]", () => {
    expect(payChartOneOffMarks(rowsOf([bonus(12, 4_000)]))).toEqual([
      [12, FLAT + dollarsToCents(4_000)],
    ]);
  });

  it("marks a month the job does not pay in at what the adjustment alone makes it", () => {
    // Outside the span the path pays 0; the chart still has to plot the mark where it was
    // authored rather than dropping the row and leaving a gap in the staircase.
    const outside = payChartOneOffMarks(rowsOf([bonus(500, 1_000)], [], flatPath(0, 360)));
    expect(outside).toEqual([[500, dollarsToCents(1_000)]]);
  });
});
