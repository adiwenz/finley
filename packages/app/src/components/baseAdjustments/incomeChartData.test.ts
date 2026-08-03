import { describe, expect, it } from "vitest";
import { dollarsToCents, type ProjectionIncomeSource, type ProjectionSeries } from "@finley/engine";
import { buildIncomeChartData, describeIncomeGap, incomeBandsForMode } from "./incomeChartData";

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
  cashInflowCents: number,
  category: ProjectionIncomeSource["category"],
  label = sourceId,
  // Engine-produced net cash flow (cash inflow − deferral − tax). Defaults to the full
  // inflow (no haircut), so a test names it only when it wants take-home < gross.
  netCashFlowCents = cashInflowCents,
  // Whose income it is — only the two-claimant tests name it.
  ownerId?: string,
): ProjectionIncomeSource => ({
  sourceId,
  label,
  category,
  cashInflowCents,
  netCashFlowCents,
  ...(ownerId !== undefined ? { ownerId } : {}),
});

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

  it("keeps two jobs in one tax bucket as distinct bands", () => {
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
    // The same order Simple reads: wages, the benefit, then the living-off-savings family.
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

  it("keeps savings interest its own band in both views — not folded into living off savings", () => {
    // Savings interest is income the savings EARN (engine-tagged `savingsInterest`), not
    // savings being spent down — and the app never parses the id to decide that.
    const data = buildIncomeChartData(
      seriesOf([
        source("job:a", dollarsToCents(5_000), "wages", "Job A"),
        source("interest:p1:ordinaryIncome", dollarsToCents(50), "savingsInterest", "Savings interest"),
        source("brokerage", dollarsToCents(1_500), "capitalGains", "Brokerage draw"),
        source("savings-drawdown", dollarsToCents(1_000), "savingsDrawdown", "Savings drawdown"),
      ]),
    );
    expect(incomeBandsForMode(data, "advanced").sources.map((s) => s.label)).toEqual([
      "Job A",
      "Savings interest",
      "Brokerage draw",
      "Savings drawdown",
    ]);
    const simple = incomeBandsForMode(data, "simple");
    expect(simple.sources.map((s) => s.label)).toEqual(["Job A", "Savings interest", "Living off savings"]);
    expect(simple.rows[0]!.centsBySource["savings-interest"]).toBe(dollarsToCents(50));
    expect(simple.rows[0]!.centsBySource["living-off-savings"]).toBe(dollarsToCents(2_500));
  });

  it("collapses multiple savings-interest sources into the one Savings interest band (Simple)", () => {
    const data = buildIncomeChartData(
      seriesOf([
        source("interest:p1:ordinaryIncome", dollarsToCents(30), "savingsInterest", "Savings interest"),
        source("interest:p2:ordinaryIncome", dollarsToCents(20), "savingsInterest", "Savings interest"),
      ]),
    );
    const simple = incomeBandsForMode(data, "simple");
    expect(simple.sources.map((s) => s.label)).toEqual(["Savings interest"]);
    expect(simple.rows[0]!.centsBySource["savings-interest"]).toBe(dollarsToCents(50));
  });

  it("breaks savings interest out per account in Advanced — 'Savings interest: <account>'", () => {
    // The engine reports one interest band per cash account; Advanced qualifies each with
    // the kind of income. A merged single line hid a drained buffer that looked like it
    // was still earning its neighbour's interest.
    const data = buildIncomeChartData(
      seriesOf([
        source("interest:savings", dollarsToCents(30), "savingsInterest", "Cash savings"),
        source("interest:goal-emergency", dollarsToCents(20), "savingsInterest", "Emergency fund"),
      ]),
    );
    const advanced = incomeBandsForMode(data, "advanced");
    expect(advanced.sources.map((s) => s.label)).toEqual([
      "Savings interest: Cash savings",
      "Savings interest: Emergency fund",
    ]);
    expect(advanced.rows[0]!.centsBySource["interest:savings"]).toBe(dollarsToCents(30));
    expect(advanced.rows[0]!.centsBySource["interest:goal-emergency"]).toBe(dollarsToCents(20));
    // A single cash account needs no disambiguation.
    const one = buildIncomeChartData(
      seriesOf([source("interest:savings", dollarsToCents(30), "savingsInterest", "Cash savings")]),
    );
    expect(incomeBandsForMode(one, "advanced").sources.map((s) => s.label)).toEqual([
      "Savings interest",
    ]);
  });

  // Two claimants: a benefit band names its kind, never its earner.
  const twoClaimants = () =>
    buildIncomeChartData(
      seriesOf([
        source("job:a", dollarsToCents(5_000), "wages", "Income · Engineer", undefined, "p1"),
        source("benefit:p1", dollarsToCents(2_000), "governmentRetirementBenefit", "Government benefit", undefined, "p1"),
        source("benefit:p-1", dollarsToCents(1_400), "governmentRetirementBenefit", "Government benefit", undefined, "p-1"),
      ]),
    );
  const names = new Map([
    ["p1", "Alex"],
    ["p-1", "Sam"],
  ]);

  it("simple keeps a Social Security band per person, named — two people claim separately", () => {
    // One folded band hid what a two-earner household needs to see: each claims on their
    // own record, at their own age, so the two starts differ.
    const { sources, rows } = incomeBandsForMode(twoClaimants(), "simple", "gross", names);
    expect(sources.map((s) => s.label)).toEqual([
      "Income · Engineer",
      "Social Security · Alex",
      "Social Security · Sam",
    ]);
    expect(rows[0]!.centsBySource["social-security:p1"]).toBe(dollarsToCents(2_000));
    expect(rows[0]!.centsBySource["social-security:p-1"]).toBe(dollarsToCents(1_400));
  });

  it("advanced names the two benefits too — one legend entry repeated says nothing", () => {
    const { sources } = incomeBandsForMode(twoClaimants(), "advanced", "gross", names);
    expect(sources.map((s) => s.label)).toEqual([
      "Income · Engineer",
      "Government benefit · Alex",
      "Government benefit · Sam",
    ]);
  });

  it("leaves a lone claimant's band unnamed — nothing to tell apart", () => {
    const { sources } = incomeBandsForMode(withEverySource(), "simple", "gross", names);
    expect(sources.map((s) => s.label)).toContain("Social Security");
  });

  it("simple sums the asset draw and the cash drawdown into the one Living off savings band", () => {
    const { rows } = incomeBandsForMode(withEverySource(), "simple");
    // Brokerage draw ($1,500) + savings drawdown ($1,000) collapse onto one band's cash.
    expect(rows[0]!.centsBySource["living-off-savings"]).toBe(dollarsToCents(2_500));
    expect(rows[0]!.centsBySource["job:a"]).toBe(dollarsToCents(5_000));
    expect(rows[0]!.centsBySource["job:b"]).toBe(dollarsToCents(2_000));
    expect(rows[0]!.spendingNeedCents).toBe(0);
  });
});

describe("incomeBandsForMode — take-home vs gross basis", () => {
  /**
   * A month whose one source carries a cash inflow and the engine's already-netted
   * take-home. The app reads that net straight through; gross − tax − deferral lives in
   * the engine's `buildFlows` and is covered there.
   */
  function seriesWithNet(cashInflow: number, net: number): ProjectionSeries {
    const months = [
      { month: 0 },
      {
        month: 1,
        flows: {
          incomeSources: [source("job:a", cashInflow, "wages", "Day job", net)],
          expensesCents: 0,
          liabilityPaymentsCents: 0,
        },
      },
    ];
    return { months } as unknown as ProjectionSeries;
  }

  it("take-home (the default) draws the engine's per-source net cash flow", () => {
    // Engine net = 5000 gross − 800 tax − 1000 deferral = 3200; the app displays it as-is.
    const data = buildIncomeChartData(seriesWithNet(dollarsToCents(5_000), dollarsToCents(3_200)));
    expect(data.rows[0]!.centsBySource["job:a"]).toBe(dollarsToCents(5_000)); // cash inflow retained
    expect(data.rows[0]!.netCentsBySource["job:a"]).toBe(dollarsToCents(3_200));
    expect(data.rows[0]!.takeHomeCents).toBe(dollarsToCents(3_200));
    const takeHome = incomeBandsForMode(data, "advanced");
    expect(takeHome.rows[0]!.centsBySource["job:a"]).toBe(dollarsToCents(3_200));
  });

  it("gross basis draws the pre-tax paycheck (the source's cash inflow)", () => {
    const data = buildIncomeChartData(seriesWithNet(dollarsToCents(5_000), dollarsToCents(3_200)));
    const gross = incomeBandsForMode(data, "advanced", "gross");
    expect(gross.rows[0]!.centsBySource["job:a"]).toBe(dollarsToCents(5_000));
  });

  it("take-home equals cash inflow when the engine reports no haircut (net == inflow)", () => {
    const data = buildIncomeChartData(
      seriesOf([source("job:a", dollarsToCents(5_000), "wages", "Day job")]),
    );
    expect(data.rows[0]!.netCentsBySource["job:a"]).toBe(dollarsToCents(5_000));
  });

  it("draws the Social Security band's take-home from the engine's net when SS IS taxed", () => {
    // 6000 inflow → 5100 take-home. In the default plan SS is below the taxable threshold
    // (net == inflow), so only this case proves a taxed benefit is handled.
    const months = [
      { month: 0 },
      {
        month: 1,
        flows: {
          incomeSources: [
            source("benefit:p1", dollarsToCents(6_000), "governmentRetirementBenefit", "Government benefit", dollarsToCents(5_100)),
          ],
          expensesCents: 0,
          liabilityPaymentsCents: 0,
        },
      },
    ];
    const data = buildIncomeChartData({ months } as unknown as ProjectionSeries);
    expect(data.rows[0]!.centsBySource["benefit:p1"]).toBe(dollarsToCents(6_000)); // cash inflow
    expect(data.rows[0]!.netCentsBySource["benefit:p1"]).toBe(dollarsToCents(5_100)); // engine net
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
