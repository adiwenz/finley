import { describe, expect, it } from "vitest";
import { dollarsToCents, type ProjectionIncomeSource, type ProjectionSeries } from "@finley/engine";
import { buildIncomeChartData, describeIncomeGap } from "./incomeByCategory";

/** A minimal series fixture: month 0 has no flows; later months carry income sources. */
function seriesOf(...perMonth: ProjectionIncomeSource[][]): ProjectionSeries {
  const months = [
    { month: 0 },
    ...perMonth.map((incomeSources, i) => ({
      month: i + 1,
      flows: { incomeSources },
    })),
  ];
  return { months } as unknown as ProjectionSeries;
}

const source = (
  sourceId: string,
  grossCents: number,
  category: ProjectionIncomeSource["category"],
  label = sourceId,
): ProjectionIncomeSource => ({ sourceId, label, category, grossCents });

describe("buildIncomeChartData", () => {
  it("emits one row per flowed month with income keyed by source", () => {
    const data = buildIncomeChartData(
      seriesOf([source("job:a", dollarsToCents(5_000), "wages", "Job A")]),
    );
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]!.month).toBe(1);
    expect(data.rows[0]!.centsBySource["job:a"]).toBe(dollarsToCents(5_000));
    expect(data.rows[0]!.totalCents).toBe(dollarsToCents(5_000));
  });

  it("keeps two jobs in one tax bucket as distinct bands (the whole point of issue #99)", () => {
    const data = buildIncomeChartData(
      seriesOf([
        source("job:a", dollarsToCents(5_000), "wages", "Job A"),
        source("job:b", dollarsToCents(2_000), "wages", "Job B"),
      ]),
    );
    expect(data.sources.map((s) => s.id)).toEqual(["job:a", "job:b"]);
    expect(data.sources.map((s) => s.label)).toEqual(["Job A", "Job B"]);
  });

  it("drops sources that carry nothing across the whole horizon", () => {
    const data = buildIncomeChartData(
      seriesOf([
        source("job:a", dollarsToCents(5_000), "wages", "Job A"),
        source("brokerage", 0, "capitalGains", "Brokerage"),
      ]),
    );
    expect(data.sources.map((s) => s.id)).toEqual(["job:a"]);
  });

  it("orders sources by provenance, benefit before the savings drawdown", () => {
    const data = buildIncomeChartData(
      seriesOf([
        source("savings-drawdown", dollarsToCents(1_000), "savingsDrawdown", "Savings drawdown"),
        source("benefit:p1", dollarsToCents(2_000), "governmentRetirementBenefit", "Government benefit"),
        source("job:a", dollarsToCents(5_000), "wages", "Job A"),
      ]),
    );
    expect(data.sources.map((s) => s.id)).toEqual(["job:a", "benefit:p1", "savings-drawdown"]);
  });

  it("finds the first savings-drawdown month — living off savings, not zero income", () => {
    const data = buildIncomeChartData(
      seriesOf(
        [source("job:a", dollarsToCents(5_000), "wages", "Job A")],
        [source("savings-drawdown", dollarsToCents(3_000), "savingsDrawdown", "Savings drawdown")],
        [source("benefit:p1", dollarsToCents(2_000), "governmentRetirementBenefit", "Government benefit")],
      ),
    );
    expect(data.firstSavingsDrawdownMonth).toBe(2);
    // A month with a drawdown band is NOT a no-income month.
    expect(data.firstMonthWithNoIncome).toBeNull();
  });

  it("flags a genuine zero month only when nothing at all covers spending", () => {
    const data = buildIncomeChartData(
      seriesOf([source("job:a", dollarsToCents(5_000), "wages", "Job A")], []),
    );
    expect(data.firstMonthWithNoIncome).toBe(2);
    expect(data.firstSavingsDrawdownMonth).toBeNull();
  });
});

describe("describeIncomeGap", () => {
  it("returns null when income runs continuously with no drawdown", () => {
    expect(
      describeIncomeGap(
        buildIncomeChartData(seriesOf([source("job:a", dollarsToCents(5_000), "wages")])),
      ),
    ).toBeNull();
  });

  it("names the year the household starts living off savings", () => {
    const data = buildIncomeChartData(
      seriesOf(
        [source("job:a", dollarsToCents(5_000), "wages")],
        [source("savings-drawdown", dollarsToCents(3_000), "savingsDrawdown", "Savings drawdown")],
      ),
    );
    expect(describeIncomeGap(data)).toMatch(/living off savings/i);
  });
});
