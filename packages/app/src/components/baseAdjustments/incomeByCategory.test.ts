import { describe, expect, it } from "vitest";
import { dollarsToCents, type ProjectionSeries } from "@finley/engine";
import { buildIncomeChartData, describeIncomeGap } from "./incomeByCategory";

/** A minimal series fixture: month 0 has no flows; later months carry income buckets. */
function seriesOf(...byCategory: Record<string, number>[]): ProjectionSeries {
  const months = [
    { month: 0 },
    ...byCategory.map((incomeByCategoryCents, i) => ({
      month: i + 1,
      flows: { incomeByCategoryCents },
    })),
  ];
  return { months } as unknown as ProjectionSeries;
}

describe("buildIncomeChartData", () => {
  it("emits one row per flowed month with income bucketed by category", () => {
    const data = buildIncomeChartData(
      seriesOf({ ordinaryIncome: dollarsToCents(5_000), taxExempt: dollarsToCents(200) }),
    );
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]!.month).toBe(1);
    expect(data.rows[0]!.centsByCategory.ordinaryIncome).toBe(dollarsToCents(5_000));
    expect(data.rows[0]!.totalCents).toBe(dollarsToCents(5_200));
  });

  it("drops categories that carry nothing across the whole horizon", () => {
    // An empty band would show a legend entry for money the household never receives.
    const data = buildIncomeChartData(
      seriesOf({ ordinaryIncome: dollarsToCents(5_000), capitalGains: 0 }),
    );
    expect(data.categories.map((c) => c.id)).toEqual(["ordinaryIncome"]);
  });

  it("names each category for a human, and orders the benefit last", () => {
    const data = buildIncomeChartData(
      seriesOf({
        governmentRetirementBenefit: dollarsToCents(2_000),
        ordinaryIncome: dollarsToCents(5_000),
      }),
    );
    expect(data.categories).toEqual([
      { id: "ordinaryIncome", label: "Pre-tax withdrawals" },
      { id: "governmentRetirementBenefit", label: "Government benefit" },
    ]);
  });

  it("finds the retirement gap: the first month with no income at all", () => {
    const data = buildIncomeChartData(
      seriesOf(
        { ordinaryIncome: dollarsToCents(5_000) },
        {}, // retired, benefit not yet claimed
        { governmentRetirementBenefit: dollarsToCents(2_000) },
      ),
    );
    expect(data.firstMonthWithNoIncome).toBe(2);
  });

  it("reports no gap when income never stops", () => {
    const data = buildIncomeChartData(
      seriesOf({ ordinaryIncome: dollarsToCents(5_000) }, { ordinaryIncome: dollarsToCents(5_100) }),
    );
    expect(data.firstMonthWithNoIncome).toBeNull();
  });
});

describe("describeIncomeGap", () => {
  it("returns null when income continues throughout", () => {
    expect(
      describeIncomeGap(buildIncomeChartData(seriesOf({ ordinaryIncome: dollarsToCents(5_000) }))),
    ).toBeNull();
  });

  it("names the year income stops", () => {
    const data = buildIncomeChartData(seriesOf({ ordinaryIncome: dollarsToCents(5_000) }, {}));
    expect(describeIncomeGap(data)).toMatch(/No income from Year 1/);
  });
});
