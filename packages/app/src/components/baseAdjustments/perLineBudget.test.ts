import { describe, expect, it } from "vitest";
import { dollarsToCents, type ProjectionSeries } from "@finley/engine";
import {
  buildPerLineBudgetData,
  describeStarvation,
  type ChartLine,
} from "./perLineBudget";

const LINES: ChartLine[] = [
  { id: "line:rent", label: "Rent", intendedCents: dollarsToCents(4_000) },
  { id: "line:fun", label: "Fun", intendedCents: dollarsToCents(2_000) },
];

/** A minimal series fixture: month 0 has no flows; later months carry a funded map. */
function seriesOf(...funded: Record<string, number>[]): ProjectionSeries {
  const months = [
    { month: 0 },
    ...funded.map((lineFundedCents, i) => ({
      month: i + 1,
      flows: { lineFundedCents },
    })),
  ];
  return { months } as unknown as ProjectionSeries;
}

describe("buildPerLineBudgetData — per-line monthly budget graph data (AC2)", () => {
  it("emits one row per flowed month with each line's funded amount", () => {
    const data = buildPerLineBudgetData(
      seriesOf({ "line:rent": dollarsToCents(4_000), "line:fun": dollarsToCents(2_000) }),
      LINES,
    );
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0].month).toBe(1);
    expect(data.rows[0].fundedByLine["line:fun"]).toBe(dollarsToCents(2_000));
    expect(data.rows[0].starved).toBe(false);
    expect(data.hasShortfall).toBe(false);
  });

  it("flags a shortfall month and names the starved line (funded below intent)", () => {
    const data = buildPerLineBudgetData(
      seriesOf(
        { "line:rent": dollarsToCents(4_000), "line:fun": dollarsToCents(2_000) }, // month 1 ok
        { "line:rent": dollarsToCents(3_000), "line:fun": 0 }, // month 2 shortfall: fun starved, rent short
      ),
      LINES,
    );
    expect(data.hasShortfall).toBe(true);
    expect(data.starvedMonths).toEqual([2]);
    const shortfallRow = data.rows.find((r) => r.month === 2)!;
    expect(shortfallRow.starved).toBe(true);
    expect(shortfallRow.starvedLineIds).toEqual(["line:rent", "line:fun"]);
  });

  it("treats a missing funded entry as 0 (fully starved)", () => {
    const data = buildPerLineBudgetData(seriesOf({ "line:rent": dollarsToCents(4_000) }), LINES);
    expect(data.rows[0].fundedByLine["line:fun"]).toBe(0);
    expect(data.rows[0].starvedLineIds).toContain("line:fun");
  });
});

describe("describeStarvation — the a11y / summary line (AC2)", () => {
  it("returns null when the budget is fully funded throughout", () => {
    const data = buildPerLineBudgetData(
      seriesOf({ "line:rent": dollarsToCents(4_000), "line:fun": dollarsToCents(2_000) }),
      LINES,
    );
    expect(describeStarvation(data)).toBeNull();
  });

  it("names the first starved month and its starved lines", () => {
    const data = buildPerLineBudgetData(
      seriesOf(
        { "line:rent": dollarsToCents(4_000), "line:fun": dollarsToCents(2_000) },
        { "line:rent": dollarsToCents(4_000), "line:fun": 0 },
      ),
      LINES,
    );
    const summary = describeStarvation(data);
    expect(summary).toMatch(/Fun/);
    expect(summary).toMatch(/starved|shortfall/i);
  });
});
