import { describe, expect, it } from "vitest";
import { dollarsToCents, type ProjectionSeries } from "@finley/engine";
import { buildPerLineBudgetData, describeInsolvency, type ChartLine } from "./perLineBudget";

const LINES: ChartLine[] = [
  { id: "line:rent", label: "Rent" },
  { id: "line:fun", label: "Fun" },
];

/** A minimal series fixture: month 0 has no flows; later months carry a per-line map. */
function seriesOf(
  monthly: Record<string, number>[],
  insolventFrom?: number,
): ProjectionSeries {
  const months = [
    { month: 0, isInsolvent: false },
    ...monthly.map((lineMonthlyCents, i) => ({
      month: i + 1,
      isInsolvent: insolventFrom !== undefined && i + 1 >= insolventFrom,
      flows: { lineMonthlyCents },
    })),
  ];
  return { months } as unknown as ProjectionSeries;
}

describe("buildPerLineBudgetData — per-line monthly budget graph data (AC2)", () => {
  it("emits one row per flowed month with each line's monthly amount", () => {
    const data = buildPerLineBudgetData(
      seriesOf([{ "line:rent": dollarsToCents(4_000), "line:fun": dollarsToCents(2_000) }]),
      LINES,
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
      LINES,
    );
    const brokeRow = data.rows.find((r) => r.month === 2)!;
    expect(brokeRow.centsByLine["line:fun"]).toBe(dollarsToCents(2_000));
    expect(brokeRow.totalCents).toBe(dollarsToCents(6_000));
  });

  it("reports the month the plan stops being financeable", () => {
    const data = buildPerLineBudgetData(
      seriesOf([{ "line:rent": dollarsToCents(4_000) }, { "line:rent": dollarsToCents(4_000) }], 2),
      LINES,
    );
    expect(data.insolventFromMonth).toBe(2);
  });

  it("treats a missing entry as 0 (the line is not active that month)", () => {
    const data = buildPerLineBudgetData(seriesOf([{ "line:rent": dollarsToCents(4_000) }]), LINES);
    expect(data.rows[0]!.centsByLine["line:fun"]).toBe(0);
  });
});

describe("describeInsolvency — the a11y / summary line (AC2)", () => {
  it("returns null when the plan finances the budget throughout", () => {
    const data = buildPerLineBudgetData(
      seriesOf([{ "line:rent": dollarsToCents(4_000), "line:fun": dollarsToCents(2_000) }]),
      LINES,
    );
    expect(describeInsolvency(data)).toBeNull();
  });

  it("names the year the plan runs out, without prescribing what to cut", () => {
    const data = buildPerLineBudgetData(
      seriesOf([{ "line:rent": dollarsToCents(4_000) }, { "line:rent": dollarsToCents(4_000) }], 2),
      LINES,
    );
    const summary = describeInsolvency(data) ?? "";
    expect(summary).toMatch(/Year 1/);
    expect(summary).toMatch(/no longer financeable/i);
    // It must not tell the user which line to give up — that is their decision.
    expect(summary).not.toMatch(/Rent|Fun|starv/i);
  });
});
