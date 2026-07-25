import { describe, expect, it } from "vitest";
import { dollarsToCents, type ProjectionSeries } from "@finley/engine";
import { buildPerLineBudgetData, describeInsolvency, type ChartLine } from "./perLineBudget";

const LINES: ChartLine[] = [
  { id: "line:rent", label: "Rent" },
  { id: "line:fun", label: "Fun" },
];

/**
 * A minimal series fixture: month 0 has no flows; later months carry a per-line map and,
 * where a scenario has debts, that month's applied payments keyed by liability id (the
 * shape `liabilityPaymentRecords` has on a real month).
 */
function seriesOf(
  monthly: Record<string, number>[],
  insolventFrom?: number,
  payments: Record<string, number>[] = [],
): ProjectionSeries {
  const recordsAt = (i: number) =>
    Object.fromEntries(
      Object.entries(payments[i] ?? {}).map(([id, cents]) => [
        id,
        { paymentStatus: "full", amountAppliedCents: cents, loanStatus: "current" },
      ]),
    );
  const months = [
    { month: 0, isInsolvent: false, liabilityPaymentRecords: {} },
    ...monthly.map((lineMonthlyCents, i) => ({
      month: i + 1,
      isInsolvent: insolventFrom !== undefined && i + 1 >= insolventFrom,
      flows: { lineMonthlyCents },
      liabilityPaymentRecords: recordsAt(i),
    })),
  ];
  return { months } as unknown as ProjectionSeries;
}

describe("buildPerLineBudgetData — per-line monthly budget graph data (AC2)", () => {
  it("emits one row per flowed month with each line's monthly amount", () => {
    const data = buildPerLineBudgetData(
      seriesOf([{ "line:rent": dollarsToCents(4_000), "line:fun": dollarsToCents(2_000) }]),
      { lines: LINES },
    );
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]!.month).toBe(1);
    expect(data.rows[0]!.centsByLine["line:fun"]).toBe(dollarsToCents(2_000));
    expect(data.rows[0]!.totalCents).toBe(dollarsToCents(6_000));
    expect(data.insolventFromMonth).toBeNull();
  });

  it("draws every line at its full amount even in a month the plan cannot afford", () => {
    // The engine reports the budget as authored; a tight month is absorbed by savings
    // and then credit, so nothing is rationed away behind the user's back.
    const data = buildPerLineBudgetData(
      seriesOf(
        [
          { "line:rent": dollarsToCents(4_000), "line:fun": dollarsToCents(2_000) },
          { "line:rent": dollarsToCents(4_000), "line:fun": dollarsToCents(2_000) },
        ],
        2,
      ),
      { lines: LINES },
    );
    const brokeRow = data.rows.find((r) => r.month === 2)!;
    expect(brokeRow.centsByLine["line:fun"]).toBe(dollarsToCents(2_000));
    expect(brokeRow.totalCents).toBe(dollarsToCents(6_000));
  });

  it("reports the month the plan stops being financeable", () => {
    const data = buildPerLineBudgetData(
      seriesOf([{ "line:rent": dollarsToCents(4_000) }, { "line:rent": dollarsToCents(4_000) }], 2),
      { lines: LINES },
    );
    expect(data.insolventFromMonth).toBe(2);
  });

  it("treats a missing entry as 0 (the line is not active that month)", () => {
    const data = buildPerLineBudgetData(seriesOf([{ "line:rent": dollarsToCents(4_000) }]), { lines: LINES });
    expect(data.rows[0]!.centsByLine["line:fun"]).toBe(0);
  });

  it("draws each debt being serviced as its own band, inside the month's total", () => {
    // A debt payment is money out the door that no budget line authors (§3), so a chart
    // of lines alone understates what the month costs.
    const data = buildPerLineBudgetData(
      seriesOf(
        [{ "line:rent": dollarsToCents(4_000) }],
        undefined,
        [{ "loan-student": dollarsToCents(500) }],
      ),
      { lines: LINES, debtLabels: { "loan-student": "Student loan payment" } },
    );
    expect(data.lines.map((b) => [b.label, b.kind])).toEqual([
      ["Rent", "line"],
      ["Fun", "line"],
      ["Student loan payment", "debt"],
    ]);
    expect(data.rows[0]!.centsByLine["debt:loan-student"]).toBe(dollarsToCents(500));
    expect(data.rows[0]!.totalCents).toBe(dollarsToCents(4_500));
  });

  it("keeps a debt band across the horizon and drops its amount once it is paid off", () => {
    const data = buildPerLineBudgetData(
      seriesOf(
        [{ "line:rent": dollarsToCents(4_000) }, { "line:rent": dollarsToCents(4_000) }],
        undefined,
        [{ "loan-student": dollarsToCents(500) }, {}],
      ),
      { lines: LINES, debtLabels: { "loan-student": "Student loan payment" } },
    );
    // The band survives (one series across the whole chart) but pays nothing after payoff.
    expect(data.lines.filter((b) => b.kind === "debt")).toHaveLength(1);
    expect(data.rows[1]!.centsByLine["debt:loan-student"]).toBeUndefined();
    expect(data.rows[1]!.totalCents).toBe(dollarsToCents(4_000));
  });

  it("still draws a debt the app has no name for, rather than dropping it from the total", () => {
    const data = buildPerLineBudgetData(
      seriesOf([{ "line:rent": dollarsToCents(4_000) }], undefined, [{ "mystery-debt": 12_300 }]),
      { lines: LINES },
    );
    expect(data.lines.at(-1)).toEqual({ id: "debt:mystery-debt", label: "Debt payment", kind: "debt" });
    expect(data.rows[0]!.totalCents).toBe(dollarsToCents(4_000) + 12_300);
  });
});

describe("describeInsolvency — the a11y / summary line (AC2)", () => {
  it("returns null when the plan finances the budget throughout", () => {
    const data = buildPerLineBudgetData(
      seriesOf([{ "line:rent": dollarsToCents(4_000), "line:fun": dollarsToCents(2_000) }]),
      { lines: LINES },
    );
    expect(describeInsolvency(data)).toBeNull();
  });

  it("names the year the plan runs out, without prescribing what to cut", () => {
    const data = buildPerLineBudgetData(
      seriesOf([{ "line:rent": dollarsToCents(4_000) }, { "line:rent": dollarsToCents(4_000) }], 2),
      { lines: LINES },
    );
    const summary = describeInsolvency(data) ?? "";
    expect(summary).toMatch(/Year 1/);
    expect(summary).toMatch(/no longer financeable/i);
    // It must not tell the user which line to give up — that is their decision.
    expect(summary).not.toMatch(/Rent|Fun|starv/i);
  });
});

describe("buildPerLineBudgetData — spending that authors no budget line", () => {
  const health = (cents: number) => ({
    id: "health",
    label: "Healthcare",
    monthlyCentsAt: () => cents,
  });

  it("draws health care and timeline expenses as their own bands, inside the total", () => {
    const data = buildPerLineBudgetData(seriesOf([{ "line:rent": dollarsToCents(4_000) }]), {
      lines: LINES,
      otherSpending: [health(dollarsToCents(450))],
    });
    expect(data.lines.map((b) => [b.label, b.kind])).toEqual([
      ["Rent", "line"],
      ["Fun", "line"],
      ["Healthcare", "other"],
    ]);
    expect(data.rows[0]!.centsByLine["spend:health"]).toBe(dollarsToCents(450));
    expect(data.rows[0]!.totalCents).toBe(dollarsToCents(4_450));
  });

  it("drops a stream that costs nothing all horizon, rather than drawing an empty band", () => {
    const data = buildPerLineBudgetData(seriesOf([{ "line:rent": dollarsToCents(4_000) }]), {
      lines: LINES,
      otherSpending: [health(0)],
    });
    expect(data.lines.every((b) => b.kind !== "other")).toBe(true);
  });
});
