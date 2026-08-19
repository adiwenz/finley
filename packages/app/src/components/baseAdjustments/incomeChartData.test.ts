import { describe, expect, it } from "vitest";
import { dollarsToCents, type ProjectionCashFlowIncomeSource, type ProjectionSeries } from "@finley/engine";
import { buildIncomeChartData, describeIncomeGap, incomeBandsForMode } from "./incomeChartData";

/** A minimal series fixture: month 0 has no flows; later months carry income sources. */
function seriesOf(...perMonth: ProjectionCashFlowIncomeSource[][]): ProjectionSeries {
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
    sources: ProjectionCashFlowIncomeSource[];
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
  category: ProjectionCashFlowIncomeSource["category"],
  label = sourceId,
  // Engine-produced net cash flow (cash inflow − deferral − tax). Defaults to the full
  // inflow (no haircut), so a test names it only when it wants take-home < gross.
  netCashFlowCents = cashInflowCents,
  // Whose income it is — only the two-claimant tests name it.
  ownerId?: string,
): ProjectionCashFlowIncomeSource => ({
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

  it("leaves savings interest off the chart — it is credited to the account, never paid out", () => {
    // Interest raises the balance of the account that earned it; nothing arrives for the month
    // to spend. Banding it counted the same dollar twice — once going into the account, again
    // inside the draw that later takes it out — so a month drawing $1,500 from a fund just
    // credited $50 of interest read as $1,550 of cash the household never had.
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
      "Brokerage draw",
      "Savings drawdown",
    ]);
    const simple = incomeBandsForMode(data, "simple");
    expect(simple.sources.map((s) => s.label)).toEqual(["Job A", "Living off savings"]);
    // Not quietly rolled into the drawdown either — it is absent, not relabelled.
    expect(simple.rows[0]!.centsBySource["living-off-savings"]).toBe(dollarsToCents(2_500));
    expect(data.rows[0]!.totalCents).toBe(dollarsToCents(7_500));
  });

  it("drops it from the gross view too, where the double-count is largest", () => {
    // Gross reads "raw earning power", which is the arguable case for keeping it — but a band
    // that appears and vanishes with a checkbox reads worse than either consistent answer.
    const data = buildIncomeChartData(
      seriesOf([
        source("job:a", dollarsToCents(5_000), "wages", "Job A"),
        source("interest:savings", dollarsToCents(30), "savingsInterest", "Cash savings"),
      ]),
    );
    for (const basis of ["gross", "takeHome"] as const) {
      const { sources, rows } = incomeBandsForMode(data, "advanced", basis);
      expect(sources.map((s) => s.label)).toEqual(["Job A"]);
      expect(rows[0]!.totalCents).toBe(dollarsToCents(5_000));
    }
  });

  it("keeps the tax the dropped band bore, moving it onto the bands that remain", () => {
    // The band goes; the tax does not. It was really charged, so letting it leave with the band
    // would hand the household back money it paid and put the overstatement straight back.
    // $50 of interest bearing $10 of tax, beside $1,000 of wages and $1,000 of brokerage: the
    // $10 splits evenly across the two survivors.
    const data = buildIncomeChartData(
      seriesOf([
        source("job:a", dollarsToCents(1_000), "wages", "Job A"),
        source("brokerage", dollarsToCents(1_000), "capitalGains", "Brokerage draw"),
        source(
          "interest:savings",
          dollarsToCents(50),
          "savingsInterest",
          "Cash savings",
          dollarsToCents(40), // $10 of tax
        ),
      ]),
    );
    const row = data.rows[0]!;
    expect(row.netCentsBySource["job:a"]).toBe(dollarsToCents(995));
    expect(row.netCentsBySource["brokerage"]).toBe(dollarsToCents(995));
    // The invariant: what the stack adds up to is what the month can actually spend.
    expect(row.takeHomeCents).toBe(dollarsToCents(1_990));
  });

  it("splits that tax to the exact cent across uneven bands", () => {
    const data = buildIncomeChartData(
      seriesOf([
        source("job:a", dollarsToCents(1_000), "wages", "Job A"),
        source("brokerage", 33_33, "capitalGains", "Brokerage draw"),
        source("interest:savings", dollarsToCents(50), "savingsInterest", "Cash savings", dollarsToCents(50) - 7),
      ]),
    );
    const row = data.rows[0]!;
    expect(row.takeHomeCents).toBe(dollarsToCents(1_000) + 33_33 - 7);
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

/**
 * Where a refund belongs. The tax chart is a record of money paid, so a refund cannot appear
 * there without drawing a negative band or quietly cancelling withholding that really happened.
 * It is cash arriving, so it appears here.
 */
describe("buildIncomeChartData — the April refund", () => {
  /**
   * A filing month: income sources whose `netCashFlowCents` the engine has ALREADY raised by the
   * refund (that is what a signed settlement does to take-home), plus the signed settlement
   * itself. The band has to be carved out of those nets, not stacked on top of them.
   */
  function refundMonth(spec: {
    readonly sources: ProjectionCashFlowIncomeSource[];
    readonly refundCents: number;
  }): ProjectionSeries {
    const months = [
      { month: 0 },
      {
        month: 1,
        flows: {
          incomeSources: spec.sources,
          expensesCents: 0,
          liabilityPaymentsCents: 0,
          taxSettlementCents: -spec.refundCents,
        },
      },
    ];
    return { months } as unknown as ProjectionSeries;
  }

  it("bands the refund as its own positive inflow", () => {
    const data = buildIncomeChartData(
      refundMonth({
        // $5,000 gross, $1,500 of it withheld, plus the $3,000 refund the engine already added.
        sources: [source("job-a", dollarsToCents(5000), "wages", "Day job", dollarsToCents(6500))],
        refundCents: dollarsToCents(3000),
      }),
    );
    expect(data.sources.map((s) => ({ id: s.id, label: s.label }))).toContainEqual({
      id: "tax-refund",
      label: "Tax refund",
    });
    expect(data.rows[0]!.netCentsBySource["tax-refund"]).toBe(dollarsToCents(3000));
  });

  it("moves the refund off the sources the engine netted it into, rather than counting it twice", () => {
    const row = buildIncomeChartData(
      refundMonth({
        sources: [source("job-a", dollarsToCents(5000), "wages", "Day job", dollarsToCents(6500))],
        refundCents: dollarsToCents(3000),
      }),
    ).rows[0]!;
    // The job's take-home goes back to the $3,500 the paycheck actually delivered...
    expect(row.netCentsBySource["job-a"]).toBe(dollarsToCents(3500));
    // ...and the household total is unchanged, because the money only moved bands.
    expect(row.takeHomeCents).toBe(dollarsToCents(6500));
  });

  it("is the only place the money appears for a retiree with no income that month", () => {
    const data = buildIncomeChartData(
      refundMonth({ sources: [], refundCents: dollarsToCents(3000) }),
    );
    const row = data.rows[0]!;
    expect(row.netCentsBySource).toEqual({ "tax-refund": dollarsToCents(3000) });
    expect(row.takeHomeCents).toBe(dollarsToCents(3000));
    // Gross too: a refund is cash from a filing, and was never in a paycheck to begin with.
    expect(row.centsBySource["tax-refund"]).toBe(dollarsToCents(3000));
  });

  it("keeps the refund its own band in Simple view, not swept into Living off savings", () => {
    const data = buildIncomeChartData(
      refundMonth({
        sources: [source("acct", dollarsToCents(2000), "savingsDrawdown", "Savings")],
        refundCents: dollarsToCents(3000),
      }),
    );
    const simple = incomeBandsForMode(data, "simple");
    expect(simple.sources.map((s) => s.label)).toEqual(["Living off savings", "Tax refund"]);
  });

  it("bands nothing in a month whose filing produced a balance due instead", () => {
    const months = [
      { month: 0 },
      {
        month: 1,
        flows: {
          incomeSources: [source("job-a", dollarsToCents(5000), "wages")],
          expensesCents: 0,
          liabilityPaymentsCents: 0,
          taxSettlementCents: dollarsToCents(1828.38),
        },
      },
    ];
    const data = buildIncomeChartData({ months } as unknown as ProjectionSeries);
    expect(data.sources.map((s) => s.id)).toEqual(["job-a"]);
  });
});
