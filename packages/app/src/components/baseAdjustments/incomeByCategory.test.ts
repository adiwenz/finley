import { describe, expect, it } from "vitest";
import { dollarsToCents, type ProjectionIncomeSource, type ProjectionSeries } from "@finley/engine";
import { buildIncomeChartData, describeIncomeGap, incomeBandsForMode } from "./incomeByCategory";

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

/** A richer fixture that also carries obligations and the insolvency flag per month. */
function seriesWith(
  ...perMonth: {
    sources: ProjectionIncomeSource[];
    expensesCents?: number;
    liabilityPaymentsCents?: number;
    isInsolvent?: boolean;
  }[]
): ProjectionSeries {
  const months = [
    { month: 0 },
    ...perMonth.map((m, i) => ({
      month: i + 1,
      isInsolvent: m.isInsolvent ?? false,
      flows: {
        incomeSources: m.sources,
        expensesCents: m.expensesCents ?? 0,
        liabilityPaymentsCents: m.liabilityPaymentsCents ?? 0,
      },
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

describe("buildIncomeChartData — spending need & insolvency (the Simple view's overlays)", () => {
  it("sets each row's spending need to expenses + scheduled liability payments", () => {
    const data = buildIncomeChartData(
      seriesWith({
        sources: [source("job:a", dollarsToCents(5_000), "wages", "Job A")],
        expensesCents: dollarsToCents(3_000),
        liabilityPaymentsCents: dollarsToCents(1_200),
      }),
    );
    expect(data.rows[0]!.spendingNeedCents).toBe(dollarsToCents(4_200));
  });

  it("reports a zero spending need when a month carries no obligation flows", () => {
    const data = buildIncomeChartData(
      seriesOf([source("job:a", dollarsToCents(5_000), "wages", "Job A")]),
    );
    expect(data.rows[0]!.spendingNeedCents).toBe(0);
  });

  it("marks the first insolvent month, and stays null while the plan is solvent", () => {
    const data = buildIncomeChartData(
      seriesWith(
        { sources: [source("job:a", dollarsToCents(5_000), "wages", "Job A")] },
        { sources: [source("savings-drawdown", dollarsToCents(3_000), "savingsDrawdown", "Savings drawdown")] },
        { sources: [source("savings-drawdown", dollarsToCents(3_000), "savingsDrawdown", "Savings drawdown")], isInsolvent: true },
        { sources: [source("savings-drawdown", dollarsToCents(3_000), "savingsDrawdown", "Savings drawdown")], isInsolvent: true },
      ),
    );
    expect(data.firstInsolventMonth).toBe(3);
  });

  it("leaves firstInsolventMonth null for a plan that never breaks", () => {
    const data = buildIncomeChartData(
      seriesWith({ sources: [source("job:a", dollarsToCents(5_000), "wages", "Job A")] }),
    );
    expect(data.firstInsolventMonth).toBeNull();
  });
});

describe("incomeBandsForMode", () => {
  const withEverySource = () =>
    buildIncomeChartData(
      seriesOf([
        source("job:a", dollarsToCents(5_000), "wages", "Income · Engineer"),
        source("job:b", dollarsToCents(2_000), "wages", "Income · Barista"),
        source("benefit:p1", dollarsToCents(2_000), "governmentRetirementBenefit", "Government benefit"),
        source("brokerage", dollarsToCents(1_500), "capitalGains", "Brokerage draw"),
        source("savings-drawdown", dollarsToCents(1_000), "savingsDrawdown", "Savings drawdown"),
      ]),
    );

  it("advanced keeps every source as its own band — real income at the base, drawdowns above", () => {
    // Wages, then the benefit (both genuine income), then the living-off-savings family
    // (the asset draw, then the cash drawdown) stacked above — the same order Simple reads.
    const { sources } = incomeBandsForMode(withEverySource(), "advanced");
    expect(sources.map((s) => s.label)).toEqual([
      "Income · Engineer",
      "Income · Barista",
      "Government benefit",
      "Brokerage draw",
      "Savings drawdown",
    ]);
  });

  it("simple keeps wages per job but folds benefit and every draw into two bands", () => {
    const { sources } = incomeBandsForMode(withEverySource(), "simple");
    expect(sources.map((s) => s.label)).toEqual([
      "Income · Engineer",
      "Income · Barista",
      "Social Security",
      "Living off savings",
    ]);
  });

  it("simple sums the asset draw and the cash drawdown into the one Living off savings band", () => {
    const { rows } = incomeBandsForMode(withEverySource(), "simple");
    // Brokerage draw ($1,500) + savings drawdown ($1,000) collapse onto one band's cash.
    expect(rows[0]!.centsBySource["living-off-savings"]).toBe(dollarsToCents(2_500));
    // Wages stay split by job.
    expect(rows[0]!.centsBySource["job:a"]).toBe(dollarsToCents(5_000));
    expect(rows[0]!.centsBySource["job:b"]).toBe(dollarsToCents(2_000));
    // The spending-need line rides through untouched.
    expect(rows[0]!.spendingNeedCents).toBe(0);
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
