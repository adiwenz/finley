/**
 * The cash-flow chart's data layer: what counts as arriving, what counts as leaving, and the
 * single signed figure between them.
 *
 * The contract these hold is the one the whole redesign exists for — every band on both sides is
 * positive, so nothing is ever clamped and nothing is ever charged on pro rata. A test that
 * finds a negative band here has found the bug back.
 */

import { describe, expect, it } from "vitest";
import {
  Projection,
  dollarsToCents,
  type ProjectionCashFlowIncomeSource,
  type ProjectionSeries,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { presetById, presetState } from "../../presets";
import {
  TAX_INCOME_BAND_ID,
  TAX_PAYROLL_BAND_ID,
  TAX_REFUND_BAND_ID,
  TAX_SETTLEMENT_BAND_ID,
  buildCashFlowChartData,
  cashFlowBandsForView,
  describeCashFlowGap,
} from "./cashFlowChartData";

interface MonthSpec {
  readonly sources?: ProjectionCashFlowIncomeSource[];
  readonly obligations?: { id: string; label: string; category: string; amountCents: number }[];
  readonly taxCents?: number;
  readonly payrollTaxCents?: number;
  readonly taxSettlementCents?: number;
  readonly expensesCents?: number;
  readonly liabilityPaymentsCents?: number;
  readonly isInsolvent?: boolean;
}

/** Month 0 carries no flows — the flow-free "now" — so the first row is month 1. */
function seriesOf(...perMonth: MonthSpec[]): ProjectionSeries {
  const months = [
    { month: 0 },
    ...perMonth.map((m, i) => ({
      month: i + 1,
      isInsolvent: m.isInsolvent ?? false,
      flows: {
        incomeSources: m.sources ?? [],
        obligations: m.obligations ?? [],
        taxCents: m.taxCents ?? 0,
        payrollTaxCents: m.payrollTaxCents ?? 0,
        taxSettlementCents: m.taxSettlementCents ?? 0,
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
  ownerId?: string,
): ProjectionCashFlowIncomeSource =>
  ({
    sourceId,
    label,
    category,
    cashInflowCents,
    // Deliberately absurd: the inflow side must never read it. The engine's signed per-source
    // net is what the old chart consumed, and consuming it is what needed the clamp.
    netCashFlowCents: -999_999_99,
    ...(ownerId !== undefined ? { ownerId } : {}),
  }) as ProjectionCashFlowIncomeSource;

const bill = (id: string, label: string, category: string, dollars: number) => ({
  id,
  label,
  category,
  amountCents: dollarsToCents(dollars),
});

/**
 * Cash out of one of the household's own accounts. The engine flags every one of these —
 * a cash-buffer draw, a brokerage sale, an IRA draw, an RMD — and the category is deliberately
 * varied across these tests, because the category is exactly what CANNOT be relied on.
 */
const withdrawal = (
  sourceId: string,
  cashInflowCents: number,
  category: ProjectionCashFlowIncomeSource["category"],
  label = sourceId,
): ProjectionCashFlowIncomeSource =>
  ({ ...source(sourceId, cashInflowCents, category, label), fromAccountWithdrawal: true }) as
    ProjectionCashFlowIncomeSource;

const JOB = source("job:a", dollarsToCents(5_000), "wages", "Job A");

describe("buildCashFlowChartData — what arrives", () => {
  it("emits one row per flowed month, banding each source's GROSS cash", () => {
    const data = buildCashFlowChartData(seriesOf({ sources: [JOB] }));
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]!.month).toBe(1);
    expect(data.rows[0]!.inflowCentsByBand["job:a"]).toBe(dollarsToCents(5_000));
    expect(data.rows[0]!.inflowTotalCents).toBe(dollarsToCents(5_000));
  });

  it("keeps two jobs in one tax bucket as distinct bands", () => {
    const data = buildCashFlowChartData(
      seriesOf({ sources: [JOB, source("job:b", dollarsToCents(2_000), "wages", "Job B")] }),
    );
    expect(data.inflowBands.map((b) => b.id)).toEqual(["job:a", "job:b"]);
    expect(data.inflowBands.map((b) => b.label)).toEqual(["Job A", "Job B"]);
  });

  it("drops a source that carries nothing across the whole horizon", () => {
    const data = buildCashFlowChartData(
      seriesOf({ sources: [JOB, source("brokerage", 0, "capitalGains", "Brokerage")] }),
    );
    expect(data.inflowBands.map((b) => b.id)).toEqual(["job:a"]);
  });

  it("never bands an account withdrawal, whatever tax category it wears", () => {
    const data = buildCashFlowChartData(
      seriesOf({
        sources: [
          JOB,
          withdrawal("cash", dollarsToCents(3_000), "savingsDrawdown", "Cash savings"),
          withdrawal("retirement", dollarsToCents(4_000), "ordinaryIncome", "IRA draw"),
          withdrawal("rmd:p1", dollarsToCents(2_000), "ordinaryIncome", "Required distribution"),
          withdrawal("brokerage:gains", dollarsToCents(900), "capitalGains", "Brokerage gains"),
        ],
      }),
    );
    expect(data.inflowBands.map((b) => b.id)).toEqual(["job:a"]);
    expect(data.rows[0]!.inflowTotalCents).toBe(dollarsToCents(5_000));
  });

  it("still bands external income that shares a withdrawal's tax category", () => {
    // A freelance series and an IRA draw are both `ordinaryIncome`. Only one is money from
    // outside the household, and only the engine's flag can tell them apart.
    const data = buildCashFlowChartData(
      seriesOf({
        sources: [
          source("series:freelance", dollarsToCents(1_200), "ordinaryIncome", "Freelance"),
          withdrawal("retirement", dollarsToCents(4_000), "ordinaryIncome", "IRA draw"),
        ],
      }),
    );
    expect(data.inflowBands.map((b) => b.id)).toEqual(["series:freelance"]);
    expect(data.rows[0]!.inflowTotalCents).toBe(dollarsToCents(1_200));
  });

  it("still records the month the household first lived off savings, so the summary can name it", () => {
    const data = buildCashFlowChartData(
      seriesOf(
        { sources: [JOB], obligations: [bill("rent", "Rent", "needs", 3_000)] },
        {
          sources: [withdrawal("cash", dollarsToCents(3_000), "savingsDrawdown", "Cash savings")],
          obligations: [bill("rent", "Rent", "needs", 3_000)],
        },
      ),
    );
    expect(data.firstHouseholdDrawdownMonth).toBe(2);
    expect(data.firstMonthWithNoIncome).toBeNull();
  });

  it("never bands savings interest, which is credited to the account and not to the month", () => {
    const data = buildCashFlowChartData(
      seriesOf({ sources: [JOB, source("interest:savings", dollarsToCents(40), "savingsInterest")] }),
    );
    expect(data.inflowBands.map((b) => b.id)).toEqual(["job:a"]);
  });

  it("orders bands by provenance: earnings, then benefits, then a refund", () => {
    const data = buildCashFlowChartData(
      seriesOf({
        sources: [
          source("benefit:p1", dollarsToCents(2_000), "governmentRetirementBenefit", "Benefit"),
          JOB,
        ],
        taxSettlementCents: -dollarsToCents(1_000),
      }),
    );
    expect(data.inflowBands.map((b) => b.id)).toEqual([
      "job:a",
      "benefit:p1",
      TAX_REFUND_BAND_ID,
    ]);
  });
});

describe("buildCashFlowChartData — the tax refund", () => {
  it("bands a refund whole, taking nothing off any other source to make room", () => {
    const data = buildCashFlowChartData(
      seriesOf({ sources: [JOB], taxCents: -dollarsToCents(1_000), taxSettlementCents: -dollarsToCents(3_000) }),
    );
    const row = data.rows[0]!;
    expect(row.inflowCentsByBand[TAX_REFUND_BAND_ID]).toBe(dollarsToCents(3_000));
    // The paycheque is untouched — a refund is not a negative wage.
    expect(row.inflowCentsByBand["job:a"]).toBe(dollarsToCents(5_000));
    expect(row.inflowTotalCents).toBe(dollarsToCents(8_000));
  });

  it("shows a refund in a month with no income at all to hide it in", () => {
    const data = buildCashFlowChartData(
      seriesOf({ sources: [], taxSettlementCents: -dollarsToCents(3_000) }),
    );
    expect(data.rows[0]!.inflowCentsByBand[TAX_REFUND_BAND_ID]).toBe(dollarsToCents(3_000));
    expect(data.rows[0]!.inflowTotalCents).toBe(dollarsToCents(3_000));
  });

  it("draws no refund band when the settlement is a bill", () => {
    const data = buildCashFlowChartData(
      seriesOf({ sources: [JOB], taxCents: dollarsToCents(2_000), taxSettlementCents: dollarsToCents(1_000) }),
    );
    expect(data.rows[0]!.inflowCentsByBand[TAX_REFUND_BAND_ID]).toBeUndefined();
    expect(data.inflowBands.map((b) => b.id)).toEqual(["job:a"]);
  });
});

describe("buildCashFlowChartData — what leaves", () => {
  it("splits the month's tax into withholding, FICA and a settled balance", () => {
    const data = buildCashFlowChartData(
      seriesOf({
        sources: [JOB],
        taxCents: dollarsToCents(1_200), // withholding 900 + settlement 300
        taxSettlementCents: dollarsToCents(300),
        payrollTaxCents: dollarsToCents(380),
      }),
    );
    const out = data.rows[0]!.outflowCentsByBand;
    expect(out[TAX_INCOME_BAND_ID]).toBe(dollarsToCents(900));
    expect(out[TAX_PAYROLL_BAND_ID]).toBe(dollarsToCents(380));
    expect(out[TAX_SETTLEMENT_BAND_ID]).toBe(dollarsToCents(300));
    expect(data.rows[0]!.outflowTotalCents).toBe(dollarsToCents(1_580));
  });

  it("recovers withholding as a POSITIVE band in a refund month, and draws no settlement", () => {
    const data = buildCashFlowChartData(
      seriesOf({
        sources: [JOB],
        // Withholding 1,500, refund 3,000 — the month's income-tax cash is NEGATIVE.
        taxCents: -dollarsToCents(1_500),
        taxSettlementCents: -dollarsToCents(3_000),
      }),
    );
    const out = data.rows[0]!.outflowCentsByBand;
    expect(out[TAX_INCOME_BAND_ID]).toBe(dollarsToCents(1_500));
    expect(out[TAX_SETTLEMENT_BAND_ID]).toBeUndefined();
  });

  it("bands every obligation the engine reports, by its own id and label", () => {
    const data = buildCashFlowChartData(
      seriesOf({
        sources: [JOB],
        obligations: [
          bill("line:rent", "Housing", "needs", 1_600),
          bill("liab:card", "Credit card", "debtService", 240),
        ],
      }),
    );
    expect(data.outflowBands.map((b) => b.label)).toEqual(["Housing", "Credit card"]);
    expect(data.rows[0]!.outflowTotalCents).toBe(dollarsToCents(1_840));
  });

  it("orders outflows tax-first, then needs, healthcare, wants, debt", () => {
    const data = buildCashFlowChartData(
      seriesOf({
        sources: [JOB],
        taxCents: dollarsToCents(900),
        obligations: [
          bill("liab:card", "Credit card", "debtService", 240),
          bill("line:fun", "Dining", "wants", 400),
          bill("line:rent", "Housing", "needs", 1_600),
          bill("line:med", "Healthcare", "healthcare", 300),
        ],
      }),
    );
    expect(data.outflowBands.map((b) => b.label)).toEqual([
      "Income tax",
      "Housing",
      "Healthcare",
      "Dining",
      "Credit card",
    ]);
  });

  it("drops an obligation that never costs anything, and leaves no zero behind in the rows", () => {
    const data = buildCashFlowChartData(
      seriesOf({ sources: [JOB], obligations: [bill("line:dormant", "Dormant", "wants", 0)] }),
    );
    expect(data.outflowBands).toEqual([]);
    expect(data.rows[0]!.outflowCentsByBand).toEqual({});
  });

  it("keeps a dormant month of a line that pays in another, so the stack has no gap", () => {
    const data = buildCashFlowChartData(
      seriesOf(
        { sources: [JOB], obligations: [bill("line:tax-prep", "Tax prep", "wants", 0)] },
        { sources: [JOB], obligations: [bill("line:tax-prep", "Tax prep", "wants", 300)] },
      ),
    );
    expect(data.outflowBands.map((b) => b.id)).toEqual(["line:tax-prep"]);
    expect(data.rows[0]!.outflowCentsByBand["line:tax-prep"]).toBe(0);
  });
});

describe("buildCashFlowChartData — every band is positive", () => {
  it("never emits a negative band on either side, however the settlement points", () => {
    const data = buildCashFlowChartData(
      seriesOf(
        { sources: [JOB], taxCents: -dollarsToCents(1_500), taxSettlementCents: -dollarsToCents(3_000) },
        { sources: [JOB], taxCents: dollarsToCents(4_000), taxSettlementCents: dollarsToCents(3_100) },
      ),
    );
    for (const row of data.rows) {
      for (const cents of Object.values(row.inflowCentsByBand)) expect(cents).toBeGreaterThan(0);
      for (const cents of Object.values(row.outflowCentsByBand)) expect(cents).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("buildCashFlowChartData — the net", () => {
  it("is what came in less what went out", () => {
    const data = buildCashFlowChartData(
      seriesOf({
        sources: [JOB],
        taxCents: dollarsToCents(900),
        payrollTaxCents: dollarsToCents(380),
        obligations: [bill("line:rent", "Housing", "needs", 1_600)],
      }),
    );
    expect(data.rows[0]!.netCents).toBe(dollarsToCents(5_000 - 900 - 380 - 1_600));
  });

  it("goes negative in a month living off savings — which is the gap, drawn honestly", () => {
    const data = buildCashFlowChartData(
      seriesOf({
        sources: [
          source("benefit:p1", dollarsToCents(2_000), "governmentRetirementBenefit", "Benefit"),
          withdrawal("cash", dollarsToCents(3_000), "savingsDrawdown", "Cash savings"),
        ],
        obligations: [bill("line:rent", "Housing", "needs", 5_000)],
      }),
    );
    expect(data.rows[0]!.netCents).toBe(-dollarsToCents(3_000));
  });

  it("counts a refund as arriving, so April's net is better by exactly the refund", () => {
    const [ordinary, april] = buildCashFlowChartData(
      seriesOf(
        { sources: [JOB], taxCents: dollarsToCents(900) },
        { sources: [JOB], taxCents: dollarsToCents(900) - dollarsToCents(3_000), taxSettlementCents: -dollarsToCents(3_000) },
      ),
    ).rows;
    expect(april!.netCents - ordinary!.netCents).toBe(dollarsToCents(3_000));
  });
});

describe("cashFlowBandsForView", () => {
  const rich = () =>
    buildCashFlowChartData(
      seriesOf({
        sources: [
          JOB,
          source("job:b", dollarsToCents(2_000), "wages", "Job B"),
          source("benefit:p1", dollarsToCents(1_000), "governmentRetirementBenefit", "Benefit", "p1"),
          source("benefit:p2", dollarsToCents(900), "governmentRetirementBenefit", "Benefit", "p2"),
        ],
        taxCents: dollarsToCents(1_200),
        taxSettlementCents: dollarsToCents(300),
        payrollTaxCents: dollarsToCents(380),
        obligations: [
          bill("line:rent", "Housing", "needs", 1_600),
          bill("line:food", "Groceries", "needs", 700),
          bill("line:fun", "Dining", "wants", 400),
        ],
      }),
    );

  it("keeps every job its own band in both modes", () => {
    for (const mode of ["simple", "advanced"] as const) {
      const view = cashFlowBandsForView(rich(), "inflows", mode);
      expect(view.bands.map((b) => b.id)).toEqual(expect.arrayContaining(["job:a", "job:b"]));
    }
  });

  it("collapses two claimants' benefits onto one band per person, named by earner", () => {
    const view = cashFlowBandsForView(
      rich(),
      "inflows",
      "simple",
      new Map([
        ["p1", "Alex"],
        ["p2", "Sam"],
      ]),
    );
    expect(view.bands.map((b) => b.label)).toEqual([
      "Job A",
      "Job B",
      "Social Security · Alex",
      "Social Security · Sam",
    ]);
  });

  it("folds all three tax bands into one in Simple, and splits them in Advanced", () => {
    const simple = cashFlowBandsForView(rich(), "outflows", "simple");
    expect(simple.bands.filter((b) => b.category === "tax").map((b) => b.label)).toEqual(["Taxes"]);
    expect(simple.rows[0]!.centsByBand["tax"]).toBe(dollarsToCents(1_580));

    const advanced = cashFlowBandsForView(rich(), "outflows", "advanced");
    expect(advanced.bands.filter((b) => b.category === "tax").map((b) => b.label)).toEqual([
      "Income tax",
      "Payroll tax (FICA)",
      "Tax settlement",
    ]);
  });

  it("folds spending onto its category in Simple, and keeps every line in Advanced", () => {
    const simple = cashFlowBandsForView(rich(), "outflows", "simple");
    expect(simple.bands.map((b) => b.label)).toEqual(["Taxes", "Needs", "Wants"]);
    expect(simple.rows[0]!.centsByBand["spend:needs"]).toBe(dollarsToCents(2_300));

    const advanced = cashFlowBandsForView(rich(), "outflows", "advanced");
    expect(advanced.bands.map((b) => b.label)).toEqual([
      "Income tax",
      "Payroll tax (FICA)",
      "Tax settlement",
      "Housing",
      "Groceries",
      "Dining",
    ]);
  });

  it("totals the same either way — collapsing bands never moves money", () => {
    for (const view of ["inflows", "outflows"] as const) {
      const simple = cashFlowBandsForView(rich(), view, "simple").rows[0]!;
      const advanced = cashFlowBandsForView(rich(), view, "advanced").rows[0]!;
      expect(simple.totalCents).toBe(advanced.totalCents);
    }
  });

  it("gives the net view no bands at all — one signed figure, stacked against nothing", () => {
    const view = cashFlowBandsForView(rich(), "net");
    expect(view.bands).toEqual([]);
    expect(view.rows[0]!.centsByBand).toEqual({});
    expect(view.rows[0]!.totalCents).toBe(view.rows[0]!.netCents);
  });

  it("carries the same net through every view, so toggling never changes the arithmetic", () => {
    const data = rich();
    const nets = (["inflows", "outflows", "net"] as const).map(
      (v) => cashFlowBandsForView(data, v).rows[0]!.netCents,
    );
    expect(new Set(nets).size).toBe(1);
  });
});

describe("describeCashFlowGap", () => {
  it("names the year savings start covering the gap", () => {
    const data = buildCashFlowChartData(
      seriesOf(
        { sources: [JOB], obligations: [bill("rent", "Rent", "needs", 3_000)] },
        {
          sources: [withdrawal("cash", dollarsToCents(3_000), "savingsDrawdown", "Cash savings")],
          obligations: [bill("rent", "Rent", "needs", 3_000)],
        },
      ),
    );
    expect(describeCashFlowGap(data)).toContain("Year 1");
    expect(describeCashFlowGap(data)).toContain("living off savings");
  });

  it("says nothing at all when income covers spending throughout", () => {
    expect(describeCashFlowGap(buildCashFlowChartData(seriesOf({ sources: [JOB] })))).toBeNull();
  });
});

/**
 * The per-person net figure, end to end against the real engine rather than a hand-built series.
 * The toggle it feeds rests on one promise — the two partners' lines add up to the household
 * line above them — and that promise spans the waterfall, the flows record and this data layer,
 * so only a real projection can hold it.
 */
describe("buildCashFlowChartData — per-person net, against a real projection", () => {
  const series = Projection.fromState(
    presetState(presetById("partner-uneven-split")),
    usJurisdiction,
  ).run(usJurisdiction).series;
  const data = buildCashFlowChartData(series);

  it("reports a figure for both partners", () => {
    expect(data.netOwners).toHaveLength(2);
  });

  it("sums both partners' net to the household's, to the cent, in every month", () => {
    // Not a spot check: the deferral bridge and the shared-obligation split both move month to
    // month, and a discrepancy that only opens in year 12 is exactly the kind a spot check
    // misses. Every flowed month, or the toggle is showing money that appears or vanishes.
    const off = data.rows.filter((r) => {
      const parts = Object.values(r.netCentsByPerson).reduce((sum, cents) => sum + cents, 0);
      return parts !== r.netCents;
    });
    expect(off).toEqual([]);
  });

  it("gives the partners genuinely different figures, not one household number twice", () => {
    // The preset is two unequal paychecks against one shared budget. If the split were ever
    // reduced to halves — or to the household total repeated — this is what would catch it.
    const first = data.rows[0]!;
    const [a, b] = Object.values(first.netCentsByPerson);
    expect(a).not.toBe(b);
    expect(a).not.toBe(first.netCents);
  });
});
