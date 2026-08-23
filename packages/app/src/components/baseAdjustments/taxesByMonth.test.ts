import { describe, expect, it } from "vitest";
import { dollarsToCents, type ProjectionSeries } from "@finley/engine";
import { buildTaxChartData, describeTaxes } from "./taxesByMonth";

/**
 * A minimal series fixture: month 0 has no flows; later months carry a tax figure and the
 * always-present per-source breakdown — empty here, since these fixtures test only the
 * total-tax aggregation.
 */
function seriesOf(...taxCents: number[]): ProjectionSeries {
  const months = [
    { month: 0 },
    ...taxCents.map((tax, i) => ({ month: i + 1, flows: { taxCents: tax, taxBySourceCents: {} } })),
  ];
  return { months } as unknown as ProjectionSeries;
}

/** A tax-bearing source for a month fixture: its id, human label, provenance category, tax. */
interface SrcSpec {
  readonly id: string;
  readonly label: string;
  readonly category: string;
  readonly cents: number;
}

/**
 * A fixture whose flowed months carry a per-SOURCE tax breakdown plus the matching
 * `incomeSources`, so the chart can learn each source's label. One list per month.
 */
function seriesWithBreakdown(...months: readonly SrcSpec[][]): ProjectionSeries {
  const rows = [
    { month: 0 },
    ...months.map((sources, i) => ({
      month: i + 1,
      flows: {
        taxCents: sources.reduce((s, x) => s + x.cents, 0),
        taxBySourceCents: Object.fromEntries(sources.map((x) => [x.id, x.cents])),
        incomeSources: sources.map((x) => ({
          sourceId: x.id,
          label: x.label,
          category: x.category,
          cashInflowCents: Math.max(x.cents, 1),
          netCashFlowCents: Math.max(x.cents - x.cents, 0),
        })),
      },
    })),
  ];
  return { months: rows } as unknown as ProjectionSeries;
}

describe("buildTaxChartData", () => {
  it("emits one row per flowed month, skipping the flow-free month 0", () => {
    const data = buildTaxChartData(seriesOf(dollarsToCents(300), dollarsToCents(420)));
    expect(data.rows).toHaveLength(2);
    expect(data.rows[0]!.month).toBe(1);
    expect(data.rows[0]!.taxCents).toBe(dollarsToCents(300));
  });

  it("sums the lifetime total across every flowed month", () => {
    const data = buildTaxChartData(seriesOf(dollarsToCents(300), dollarsToCents(420), 0));
    expect(data.totalCents).toBe(dollarsToCents(720));
  });

  it("finds the peak month and its amount", () => {
    const data = buildTaxChartData(
      seriesOf(dollarsToCents(300), dollarsToCents(900), dollarsToCents(420)),
    );
    expect(data.peakMonthlyCents).toBe(dollarsToCents(900));
    expect(data.peakMonth).toBe(2);
  });

  it("clamps a negative tax figure to zero (a credit is not a payment on this chart)", () => {
    const data = buildTaxChartData(seriesOf(-dollarsToCents(50), dollarsToCents(100)));
    expect(data.rows[0]!.taxCents).toBe(0);
    expect(data.totalCents).toBe(dollarsToCents(100));
  });

  it("reports no tax when the plan pays none anywhere (e.g. a null jurisdiction)", () => {
    const data = buildTaxChartData(seriesOf(0, 0));
    expect(data.hasAnyTax).toBe(false);
    expect(data.totalCents).toBe(0);
  });
});

describe("buildTaxChartData — per-source stacking", () => {
  it("reports no per-source bands when no tax is attributed to any source (empty breakdown)", () => {
    const data = buildTaxChartData(seriesOf(dollarsToCents(300), dollarsToCents(420)));
    expect(data.hasSourceBreakdown).toBe(false);
    expect(data.sources).toEqual([]);
  });

  it("splits wages into a band per job, naming each from its income source", () => {
    const data = buildTaxChartData(
      seriesWithBreakdown([
        { id: "job-a", label: "Day job", category: "wages", cents: dollarsToCents(400) },
        { id: "job-b", label: "Side gig", category: "wages", cents: dollarsToCents(200) },
      ]),
    );
    expect(data.hasSourceBreakdown).toBe(true);
    // Two distinct wage bands, each carrying its own job's name — not one lumped band.
    expect(data.sources.map((s) => s.id)).toEqual(["job-a", "job-b"]);
    expect(data.sources.map((s) => s.label)).toEqual(["Day job", "Side gig"]);
  });

  it("orders bands by provenance category, wages before benefit before gains", () => {
    const data = buildTaxChartData(
      seriesWithBreakdown(
        [
          { id: "job-a", label: "Day job", category: "wages", cents: dollarsToCents(200) },
          { id: "draw", label: "Brokerage", category: "capitalGains", cents: dollarsToCents(50) },
        ],
        [
          { id: "job-a", label: "Day job", category: "wages", cents: dollarsToCents(180) },
          { id: "ss", label: "Social Security", category: "governmentRetirementBenefit", cents: dollarsToCents(40) },
        ],
      ),
    );
    expect(data.sources.map((s) => s.category)).toEqual([
      "wages",
      "governmentRetirementBenefit",
      "capitalGains",
    ]);
  });

  it("keeps each month's per-source cents, and the bands sum to the month total", () => {
    const data = buildTaxChartData(
      seriesWithBreakdown([
        { id: "job-a", label: "Day job", category: "wages", cents: dollarsToCents(200) },
        { id: "draw", label: "Brokerage", category: "capitalGains", cents: dollarsToCents(50) },
      ]),
    );
    const row = data.rows[0]!;
    expect(row.centsBySource["job-a"]).toBe(dollarsToCents(200));
    expect(row.centsBySource["draw"]).toBe(dollarsToCents(50));
    const banded = Object.values(row.centsBySource).reduce((s, c) => s + c, 0);
    expect(banded).toBe(row.taxCents);
  });

  it("drops a source that carries no tax anywhere (no empty legend band)", () => {
    const data = buildTaxChartData(
      seriesWithBreakdown([
        { id: "job-a", label: "Day job", category: "wages", cents: dollarsToCents(200) },
        { id: "job-b", label: "Side gig", category: "wages", cents: 0 },
      ]),
    );
    expect(data.sources.map((s) => s.id)).toEqual(["job-a"]);
  });

  it("labels a category-keyed fallback source (an untitled stream) in English", () => {
    // The engine keys an id-less source by its tax category; with no income band to name
    // it, the chart still reads a category label rather than the raw key.
    const months = [
      { month: 0 },
      { month: 1, flows: { taxCents: dollarsToCents(300), taxBySourceCents: { wages: dollarsToCents(300) } } },
    ];
    const data = buildTaxChartData({ months } as unknown as ProjectionSeries);
    expect(data.sources).toEqual([{ id: "wages", label: "Wages", category: "wages", kind: "incomeTax" }]);
  });

  it("labels the savings-interest tax band from its income source's explicit provenance", () => {
    // Savings interest appears on the income side too, so the tax band borrows its label
    // and explicit `savingsInterest` provenance from the registry — the chart never parses
    // the `interest:` id to decide what the band is.
    const months = [
      { month: 0 },
      {
        month: 1,
        flows: {
          taxCents: dollarsToCents(50),
          taxBySourceCents: { "interest:p1:ordinaryIncome": dollarsToCents(50) },
          incomeSources: [
            {
              sourceId: "interest:p1:ordinaryIncome",
              label: "Savings interest",
              category: "savingsInterest",
              cashInflowCents: dollarsToCents(500),
              netCashFlowCents: dollarsToCents(450),
            },
          ],
        },
      },
    ];
    const data = buildTaxChartData({ months } as unknown as ProjectionSeries);
    expect(data.sources).toEqual([
      {
        id: "interest:p1:ordinaryIncome",
        label: "Savings interest",
        category: "savingsInterest",
        kind: "incomeTax",
      },
    ]);
  });

  it("still totals and peaks correctly off the breakdown months", () => {
    const data = buildTaxChartData(
      seriesWithBreakdown(
        [{ id: "job-a", label: "Day job", category: "wages", cents: dollarsToCents(300) }],
        [
          { id: "job-a", label: "Day job", category: "wages", cents: dollarsToCents(500) },
          { id: "draw", label: "Brokerage", category: "capitalGains", cents: dollarsToCents(400) },
        ],
      ),
    );
    expect(data.totalCents).toBe(dollarsToCents(1200));
    expect(data.peakMonthlyCents).toBe(dollarsToCents(900));
    expect(data.peakMonth).toBe(2);
  });
});

describe("describeTaxes", () => {
  it("returns null when no tax is paid (nothing to describe)", () => {
    expect(describeTaxes(buildTaxChartData(seriesOf(0, 0)))).toBeNull();
  });

  it("names the lifetime total and the peak year", () => {
    // Peak in month 13 → Year 1 (months 0-11 are Year 0, matching every other tooltip's
    // convention — see `format.ts`'s `yearOf`).
    const rows = Array.from({ length: 13 }, (_, i) => (i === 12 ? dollarsToCents(900) : dollarsToCents(300)));
    const summary = describeTaxes(buildTaxChartData(seriesOf(...rows)));
    expect(summary).toMatch(/in tax over the plan/);
    expect(summary).toMatch(/Year 1\b/);
    expect(summary).toMatch(/Federal income and payroll \(FICA\) tax only/);
  });
});

describe("buildTaxChartData — payroll tax (FICA) bands", () => {
  /**
   * A fixture whose flowed months carry both a per-source INCOME tax breakdown and a
   * per-source PAYROLL tax breakdown, plus the matching `incomeSources` for labels.
   */
  function seriesWithPayroll(
    ...months: readonly {
      readonly incomeTax: readonly SrcSpec[];
      readonly payrollTax?: readonly SrcSpec[];
    }[]
  ): ProjectionSeries {
    const rows = [
      { month: 0 },
      ...months.map(({ incomeTax, payrollTax = [] }, i) => ({
        month: i + 1,
        flows: {
          taxCents: incomeTax.reduce((s, x) => s + x.cents, 0),
          payrollTaxCents: payrollTax.reduce((s, x) => s + x.cents, 0),
          taxBySourceCents: Object.fromEntries(incomeTax.map((x) => [x.id, x.cents])),
          payrollTaxBySourceCents: Object.fromEntries(payrollTax.map((x) => [x.id, x.cents])),
          incomeSources: [...incomeTax, ...payrollTax]
            .filter((x, idx, arr) => arr.findIndex((y) => y.id === x.id) === idx)
            .map((x) => ({
              sourceId: x.id,
              label: x.label,
              category: x.category,
              cashInflowCents: Math.max(x.cents, 1),
              netCashFlowCents: 0,
            })),
        },
      })),
    ];
    return { months: rows } as unknown as ProjectionSeries;
  }

  it("draws a separate FICA band alongside the income-tax band for a wage source charging both", () => {
    const data = buildTaxChartData(
      seriesWithPayroll({
        incomeTax: [{ id: "job-a", label: "Day job", category: "wages", cents: dollarsToCents(200) }],
        payrollTax: [{ id: "job-a", label: "Day job", category: "wages", cents: dollarsToCents(76.5) }],
      }),
    );
    expect(data.sources.map((s) => ({ id: s.id, label: s.label, kind: s.kind }))).toEqual([
      { id: "job-a", label: "Day job", kind: "incomeTax" },
      { id: "job-a::fica", label: "Day job — FICA", kind: "payrollTax" },
    ]);
    const row = data.rows[0]!;
    expect(row.centsBySource["job-a"]).toBe(dollarsToCents(200));
    expect(row.centsBySource["job-a::fica"]).toBe(dollarsToCents(76.5));
  });

  it("totals taxCents as income tax PLUS payroll tax, reconciling to the summed bands", () => {
    const data = buildTaxChartData(
      seriesWithPayroll({
        incomeTax: [{ id: "job-a", label: "Day job", category: "wages", cents: dollarsToCents(200) }],
        payrollTax: [{ id: "job-a", label: "Day job", category: "wages", cents: dollarsToCents(76.5) }],
      }),
    );
    const row = data.rows[0]!;
    expect(row.taxCents).toBe(dollarsToCents(276.5));
    const banded = Object.values(row.centsBySource).reduce((s, c) => s + c, 0);
    expect(banded).toBe(row.taxCents);
  });

  it("draws no FICA band for a source that charges only income tax (e.g. a retirement withdrawal)", () => {
    const data = buildTaxChartData(
      seriesWithPayroll({
        incomeTax: [
          { id: "draw", label: "Brokerage", category: "capitalGains", cents: dollarsToCents(50) },
        ],
      }),
    );
    expect(data.sources).toEqual([
      { id: "draw", label: "Brokerage", category: "capitalGains", kind: "incomeTax" },
    ]);
  });

  it("labels a category-keyed FICA fallback (an untitled wage stream) in English", () => {
    const months = [
      { month: 0 },
      {
        month: 1,
        flows: {
          taxCents: 0,
          payrollTaxCents: dollarsToCents(76.5),
          taxBySourceCents: {},
          payrollTaxBySourceCents: { wages: dollarsToCents(76.5) },
        },
      },
    ];
    const data = buildTaxChartData({ months } as unknown as ProjectionSeries);
    expect(data.sources).toEqual([
      { id: "wages::fica", label: "Wages — FICA", category: "wages", kind: "payrollTax" },
    ]);
  });
});

/**
 * April, the one month whose tax is not what a paycheck withheld.
 *
 * The chart's contract is TAX PAID. `flows.taxCents` is not that in a filing month: it carries a
 * signed settlement, and `taxBySourceCents` carries that settlement's proportional attribution —
 * which goes negative on whichever job the multiple-jobs correction had been concentrating
 * withholding on. Clamping those bands at zero and stacking the rest is how a real $1,828.38
 * balance came to be drawn as $3,665.00.
 */
describe("buildTaxChartData — April, and what a settlement is allowed to draw", () => {
  /**
   * A filing month as the engine really reports one: `taxCents` is the month's withholding plus
   * the SIGNED settlement, `taxBySourceCents` is that same total apportioned, and
   * `taxSettlementBySourceCents` is the settlement's own slice of it — signed, and summing to
   * `taxSettlementCents`.
   */
  function filingMonth(spec: {
    readonly withholding: Readonly<Record<string, number>>;
    readonly settlementBySource?: Readonly<Record<string, number>>;
    readonly payrollTax?: Readonly<Record<string, number>>;
    readonly labels?: Readonly<Record<string, string>>;
  }): ProjectionSeries {
    const settlementBySource = spec.settlementBySource ?? {};
    const payrollTax = spec.payrollTax ?? {};
    const settlementCents = Object.values(settlementBySource).reduce((s, c) => s + c, 0);
    const taxBySourceCents: Record<string, number> = { ...spec.withholding };
    for (const [id, cents] of Object.entries(settlementBySource)) {
      taxBySourceCents[id] = (taxBySourceCents[id] ?? 0) + cents;
    }
    const withheld = Object.values(spec.withholding).reduce((s, c) => s + c, 0);
    const ids = [...new Set([...Object.keys(taxBySourceCents), ...Object.keys(payrollTax)])];
    const months = [
      { month: 0 },
      {
        month: 1,
        flows: {
          taxCents: withheld + settlementCents,
          payrollTaxCents: Object.values(payrollTax).reduce((s, c) => s + c, 0),
          taxBySourceCents,
          payrollTaxBySourceCents: payrollTax,
          taxSettlementCents: settlementCents,
          taxSettlementBySourceCents: settlementBySource,
          incomeSources: ids.map((id) => ({
            sourceId: id,
            label: spec.labels?.[id] ?? id,
            category: id.startsWith("job") ? "wages" : "savingsInterest",
            cashInflowCents: dollarsToCents(1),
            netCashFlowCents: 0,
          })),
        },
      },
    ];
    return { months } as unknown as ProjectionSeries;
  }

  /** The real two-jobs April: a $1,828.38 bill whose attribution swings ±$3,400. */
  const twoJobsApril = () =>
    filingMonth({
      withholding: { "job:job-1": 157249, "job:job-2": 18463 },
      settlementBySource: { "job:job-1": -340911, "job:job-2": 343439, "interest:savings": 4598 },
      payrollTax: { "job:job-1": 63036, "job:job-2": 23638 },
      labels: { "job:job-1": "Main job", "job:job-2": "Second job", "interest:savings": "Savings" },
    });

  it("draws a balance due as ONE settlement band of the amount actually paid", () => {
    const row = buildTaxChartData(twoJobsApril()).rows[0]!;
    expect(row.centsBySource["tax-settlement"]).toBe(7126);
    expect(row.settlementCents).toBe(7126);
    expect(row.settlementPaidCents).toBe(7126);
    expect(row.refundCents).toBe(0);
  });

  it("never bands the settlement's per-source attribution — the negative one included", () => {
    const data = buildTaxChartData(twoJobsApril());
    const row = data.rows[0]!;
    // The wrong answer is job-2 at $3,619.02 and savings at $45.98: the positive attribution
    // pieces, stacked, with the −$3,409.11 dropped by the clamp.
    expect(row.centsBySource["job:job-2"]).toBe(18463);
    expect(row.centsBySource["interest:savings"]).toBeUndefined();
    expect(data.sources.map((s) => s.id)).not.toContain("interest:savings");
    expect(Object.values(row.centsBySource).every((c) => c >= 0)).toBe(true);
  });

  it("stacks to the tax the household ACTUALLY paid, not to the clamped attribution", () => {
    const row = buildTaxChartData(twoJobsApril()).rows[0]!;
    const banded = Object.values(row.centsBySource).reduce((s, c) => s + c, 0);
    // Withholding 1,757.12 + FICA 866.74 + settlement 71.26. The clamped stack read 3,665.00
    // for the income-tax half alone, against 1,828.38 really charged.
    expect(banded).toBe(157249 + 18463 + 63036 + 23638 + 7126);
    expect(row.taxCents).toBe(banded);
    const incomeTaxBands = 157249 + 18463 + 7126;
    expect(incomeTaxBands).toBe(182838); // === flows.taxCents, to the cent
  });

  it("keeps the signed attribution on the row for the tooltip and for reconciliation", () => {
    const data = buildTaxChartData(twoJobsApril());
    const row = data.rows[0]!;
    expect(row.settlementBySourceCents).toEqual({
      "job:job-1": -340911,
      "job:job-2": 343439,
      "interest:savings": 4598,
    });
    const net = Object.values(row.settlementBySourceCents).reduce((s, c) => s + c, 0);
    expect(net).toBe(row.settlementCents);
    // And it can be named, even for a source carrying no band this month.
    expect(data.sourceLabels["interest:savings"]).toBe("Savings");
  });

  it("contributes NOTHING to the tax chart when the filing produces a refund", () => {
    const row = buildTaxChartData(
      filingMonth({
        withholding: { "job:job-1": dollarsToCents(1500) },
        settlementBySource: { "job:job-1": dollarsToCents(-3000) },
      }),
    ).rows[0]!;
    expect(row.centsBySource["tax-settlement"]).toBeUndefined();
    expect(row.settlementPaidCents).toBe(0);
    expect(row.refundCents).toBe(dollarsToCents(3000));
  });

  it("leaves April's own withholding and FICA fully visible behind a refund", () => {
    const row = buildTaxChartData(
      filingMonth({
        withholding: { "job:job-1": dollarsToCents(1100) },
        payrollTax: { "job:job-1": dollarsToCents(400) },
        settlementBySource: { "job:job-1": dollarsToCents(-3000) },
      }),
    ).rows[0]!;
    // The refund does not net against the paycheck: $1,500 really left the household.
    expect(row.centsBySource["job:job-1"]).toBe(dollarsToCents(1100));
    expect(row.centsBySource["job:job-1::fica"]).toBe(dollarsToCents(400));
    expect(row.taxCents).toBe(dollarsToCents(1500));
  });

  it("draws flat zero for a retiree whose April is a refund and nothing else", () => {
    const row = buildTaxChartData(
      filingMonth({ withholding: {}, settlementBySource: { "interest:savings": dollarsToCents(-3000) } }),
    ).rows[0]!;
    expect(row.taxCents).toBe(0);
    expect(row.centsBySource).toEqual({});
    expect(row.refundCents).toBe(dollarsToCents(3000));
  });

  it("leaves an ordinary non-filing month exactly as it was", () => {
    const row = buildTaxChartData(
      filingMonth({
        withholding: { "job:job-1": 157249, "job:job-2": 18463 },
        payrollTax: { "job:job-1": 63036 },
      }),
    ).rows[0]!;
    expect(row.centsBySource).toEqual({
      "job:job-1": 157249,
      "job:job-2": 18463,
      "job:job-1::fica": 63036,
    });
    expect(row.settlementCents).toBe(0);
    expect(row.refundCents).toBe(0);
    expect(row.taxCents).toBe(157249 + 18463 + 63036);
  });

  it("keeps federal withholding banded per job through a filing month", () => {
    const data = buildTaxChartData(twoJobsApril());
    const federal = data.sources.filter((s) => s.kind === "incomeTax");
    expect(federal.map((s) => s.label)).toEqual(["Main job", "Second job"]);
    const row = data.rows[0]!;
    expect(row.centsBySource["job:job-1"]).toBe(157249);
    expect(row.centsBySource["job:job-2"]).toBe(18463);
  });

  it("keeps FICA banded per job, apart from both withholding and the settlement", () => {
    const data = buildTaxChartData(twoJobsApril());
    expect(data.sources.filter((s) => s.kind === "payrollTax").map((s) => s.label)).toEqual([
      "Main job — FICA",
      "Second job — FICA",
    ]);
    const settlement = data.sources.filter((s) => s.kind === "settlement");
    expect(settlement).toEqual([
      { id: "tax-settlement", label: "Tax settlement", category: "tax-settlement", kind: "settlement" },
    ]);
    // Last in the stack: a once-a-year event reads as one, on top.
    expect(data.sources[data.sources.length - 1]!.kind).toBe("settlement");
  });

  it("counts only tax paid in the lifetime total and the peak, so a refund inflates neither", () => {
    const data = buildTaxChartData(
      filingMonth({
        withholding: { "job:job-1": dollarsToCents(1500) },
        settlementBySource: { "job:job-1": dollarsToCents(-3000) },
      }),
    );
    expect(data.totalCents).toBe(dollarsToCents(1500));
    expect(data.peakMonthlyCents).toBe(dollarsToCents(1500));
  });
});
