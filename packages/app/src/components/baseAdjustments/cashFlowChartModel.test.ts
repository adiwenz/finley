/**
 * The cash-flow chart's view model: bands, colours, render-ready rows, the markers, and the
 * nonvisual table a screen reader reads instead of the SVG.
 *
 * There is no clamp left to test. What replaces those cases is the pair at the bottom: every
 * drawn figure on a stacked view is the data layer's own, unmodified, and the net view draws one
 * signed series and nothing else.
 */

import { describe, expect, it } from "vitest";
import { dollarsToCents, type ProjectionCashFlowIncomeSource, type ProjectionSeries } from "@finley/engine";
import { buildCashFlowChartData } from "./cashFlowChartData";
import { NET_KEY, SPENDING_NEED_KEY, buildCashFlowChartModel } from "./cashFlowChartModel";

interface MonthSpec {
  readonly sources?: ProjectionCashFlowIncomeSource[];
  readonly obligations?: { id: string; label: string; category: string; amountCents: number }[];
  readonly taxCents?: number;
  readonly payrollTaxCents?: number;
  readonly taxSettlementCents?: number;
  readonly expensesCents?: number;
  readonly isInsolvent?: boolean;
}

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
        liabilityPaymentsCents: 0,
      },
    })),
  ];
  return { months } as unknown as ProjectionSeries;
}

function source(
  sourceId: string,
  cashInflowCents: number,
  category: ProjectionCashFlowIncomeSource["category"],
  extra: Partial<ProjectionCashFlowIncomeSource> = {},
): ProjectionCashFlowIncomeSource {
  return {
    sourceId,
    label: sourceId,
    category,
    cashInflowCents,
    netCashFlowCents: cashInflowCents,
    ...extra,
  } as ProjectionCashFlowIncomeSource;
}

const wages = source("job:a", dollarsToCents(5_000), "wages");
const rent = { id: "line:rent", label: "Housing", category: "needs", amountCents: dollarsToCents(1_600) };

describe("buildCashFlowChartModel — bands and rows", () => {
  it("renders one band per source with a stable id, label and colour", () => {
    const model = buildCashFlowChartModel(buildCashFlowChartData(seriesOf({ sources: [wages] })), {
      view: "inflows",
      mode: "advanced",
    });
    const band = model.bands.find((b) => b.id === "job:a");
    expect(band).toBeDefined();
    expect(band!.label).toBe("job:a");
    expect(band!.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("puts the month on the shared axis and the spending need under its namespaced key", () => {
    const model = buildCashFlowChartModel(
      buildCashFlowChartData(seriesOf({ sources: [wages], expensesCents: dollarsToCents(1_600) })),
      { view: "inflows", mode: "advanced" },
    );
    // The flow-free "now" reserves axis x = 0, so the first flowed month sits one slot along.
    expect(model.rows[0]!["month"]).toBe(2);
    expect(model.rows[0]![SPENDING_NEED_KEY]).toBe(dollarsToCents(1_600));
    expect(model.rows[0]!["job:a"]).toBe(dollarsToCents(5_000));
  });

  it("carries every band in every row, so a once-a-year band still draws a spike", () => {
    // An RMD pays in one month and nothing in the eleven around it. Left absent from those
    // rows, its stacked area has no neighbouring points and Recharts draws it zero-width —
    // invisible, while the y-axis still stretches to it.
    const model = buildCashFlowChartModel(
      buildCashFlowChartData(
        seriesOf(
          { sources: [wages] },
          { sources: [wages, source("rmd:p1", dollarsToCents(80_000), "ordinaryIncome")] },
          { sources: [wages] },
        ),
      ),
      { view: "inflows", mode: "advanced" },
    );
    expect(model.rows.map((r) => r["rmd:p1"])).toEqual([0, dollarsToCents(80_000), 0]);
  });

  it("draws each side's own bands, and never mixes them", () => {
    const data = buildCashFlowChartData(
      seriesOf({ sources: [wages], taxCents: dollarsToCents(900), obligations: [rent] }),
    );
    const inflows = buildCashFlowChartModel(data, { view: "inflows", mode: "advanced" });
    const outflows = buildCashFlowChartModel(data, { view: "outflows", mode: "advanced" });
    expect(inflows.bands.map((b) => b.label)).toEqual(["job:a"]);
    expect(outflows.bands.map((b) => b.label)).toEqual(["Income tax", "Housing"]);
  });
});

describe("buildCashFlowChartModel — the net view", () => {
  const data = () =>
    buildCashFlowChartData(
      seriesOf({
        sources: [wages],
        taxCents: dollarsToCents(900),
        obligations: [rent],
        expensesCents: dollarsToCents(1_600),
      }),
    );

  it("draws no bands at all", () => {
    expect(buildCashFlowChartModel(data(), { view: "net" }).bands).toEqual([]);
  });

  it("carries the signed net under its own key", () => {
    const model = buildCashFlowChartModel(data(), { view: "net" });
    expect(model.rows[0]![NET_KEY]).toBe(dollarsToCents(5_000 - 900 - 1_600));
    expect(model.netKey).toBe(NET_KEY);
  });

  it("lets the net go negative — the one figure on this chart that may", () => {
    const model = buildCashFlowChartModel(
      buildCashFlowChartData(
        seriesOf({
          sources: [source("benefit:p1", dollarsToCents(2_000), "governmentRetirementBenefit")],
          obligations: [{ ...rent, amountCents: dollarsToCents(5_000) }],
        }),
      ),
      { view: "net" },
    );
    expect(model.rows[0]![NET_KEY]).toBe(-dollarsToCents(3_000));
  });

  it("plots the spending need on the inflow view only", () => {
    const d = data();
    expect(buildCashFlowChartModel(d, { view: "inflows" }).showsSpendingNeed).toBe(true);
    expect(buildCashFlowChartModel(d, { view: "outflows" }).showsSpendingNeed).toBe(false);
    expect(buildCashFlowChartModel(d, { view: "net" }).showsSpendingNeed).toBe(false);
  });

  it("names the view it is drawing, in the summary a screen reader hears", () => {
    const d = data();
    expect(buildCashFlowChartModel(d, { view: "inflows" }).accessibleSummary).toContain("coming in");
    expect(buildCashFlowChartModel(d, { view: "outflows" }).accessibleSummary).toContain("going out");
    expect(buildCashFlowChartModel(d, { view: "net" }).accessibleSummary).toContain("net cash flow");
  });
});

describe("buildCashFlowChartModel — markers and summary", () => {
  it("reports the first insolvent month as a month and as an age", () => {
    const model = buildCashFlowChartModel(
      buildCashFlowChartData(
        seriesOf({ sources: [wages] }, { sources: [], isInsolvent: true }),
      ),
      { view: "inflows", currentAge: 40 },
    );
    expect(model.brokeMonth).toBe(2);
    expect(model.brokeAgeLabel).toBe("40¼");
  });

  it("leaves both null on a plan that never runs out", () => {
    const model = buildCashFlowChartModel(
      buildCashFlowChartData(seriesOf({ sources: [wages] })),
      { view: "inflows" },
    );
    expect(model.brokeMonth).toBeNull();
    expect(model.brokeAgeLabel).toBeNull();
    expect(model.gapSummary).toBeNull();
  });

  it("ends the axis at the last flowed month", () => {
    const model = buildCashFlowChartModel(
      buildCashFlowChartData(seriesOf({ sources: [wages] }, { sources: [wages] })),
      { view: "inflows" },
    );
    expect(model.lastX).toBe(3);
  });
});

describe("buildCashFlowChartModel — the nonvisual table", () => {
  const withRmd = () =>
    buildCashFlowChartData(
      seriesOf(
        { sources: [wages], obligations: [rent], expensesCents: dollarsToCents(1_600) },
        { sources: [wages, source("rmd:p1", dollarsToCents(80_000), "ordinaryIncome")], obligations: [rent] },
        { sources: [wages], obligations: [rent] },
      ),
    );

  it("opens with the projection's start", () => {
    const model = buildCashFlowChartModel(withRmd(), { view: "inflows", mode: "advanced" });
    expect(model.accessibleMoments[0]!.reason).toContain("Projection starts");
  });

  it("names a band beginning and ending, with the month before each as its 'before'", () => {
    const model = buildCashFlowChartModel(withRmd(), { view: "inflows", mode: "advanced" });
    const reasons = new Map(model.accessibleMoments.map((m) => [m.label, m.reason]));
    expect([...reasons.values()].join(" ")).toContain("rmd:p1 begins");
    expect([...reasons.values()].join(" ")).toContain("rmd:p1 ends");
  });

  it("quotes exactly the figures the chart draws", () => {
    const model = buildCashFlowChartModel(withRmd(), { view: "inflows", mode: "advanced" });
    const moment = model.accessibleMoments.find((m) => m.reason.includes("begins"))!;
    expect(moment.sources.map((s) => s.label)).toEqual(model.bands.map((b) => b.label));
  });

  it("reads the net view as one row, since it has no bands to read", () => {
    const model = buildCashFlowChartModel(withRmd(), { view: "net" });
    expect(model.accessibleMoments[0]!.sources).toEqual([
      { label: "Net cash flow", amount: expect.any(String) },
    ]);
  });
});

/**
 * Cutting the model down to one person. The inflow side carries the engine's own attribution,
 * so the cut is a filter over real ownership rather than an apportionment the model invents.
 */
describe("buildCashFlowChartModel — one person's cut", () => {
  const ALEX_PAY = dollarsToCents(6_000);
  const BLAKE_PAY = dollarsToCents(2_400);
  const RENT = dollarsToCents(3_000);

  const twoEarners = buildCashFlowChartData(
    seriesOf({
      sources: [
        source("Software Engineer", ALEX_PAY, "wages", { ownerId: "p1" }),
        source("Teacher", BLAKE_PAY, "wages", { ownerId: "p2" }),
      ],
      obligations: [{ id: "rent", label: "Rent", category: "needs", amountCents: RENT }],
      expensesCents: RENT,
    }),
  );

  it("stacks one earner's income and totals only theirs", () => {
    const model = buildCashFlowChartModel(twoEarners, {
      view: "inflows",
      mode: "advanced",
      ownerId: "p2",
    });
    expect(model.bands.map((b) => b.label)).toEqual(["Teacher"]);
    expect(model.rows[0]!["Teacher"]).toBe(BLAKE_PAY);
    expect(model.rows[0]!["Software Engineer"]).toBeUndefined();
  });

  it("stops drawing the household's spending-need line", () => {
    // The dashed line is the WHOLE household's need. Over Blake's $2,400 alone it asks "does
    // Blake cover the rent by themselves?" — a shortfall in a household that has none, and not
    // the question the cut was reached for. The figure stays honest on the row; it is the
    // COMPARISON that stops being drawn.
    const combined = buildCashFlowChartModel(twoEarners, { view: "inflows" });
    expect(combined.showsSpendingNeed).toBe(true);
    expect(combined.rows[0]![SPENDING_NEED_KEY]).toBe(RENT);

    const blake = buildCashFlowChartModel(twoEarners, { view: "inflows", ownerId: "p2" });
    expect(blake.showsSpendingNeed).toBe(false);
  });

  it("leaves the outflow and net views whole, because neither is attributable", () => {
    // Every budget line compiles under the primary person whoever it is really for, so honouring
    // a cut here would draw the primary paying for the household and the partner paying nothing.
    // The model ignores the request rather than answering it wrongly.
    const out = buildCashFlowChartModel(twoEarners, { view: "outflows", ownerId: "p2" });
    expect(out.bands.map((b) => b.label)).toEqual(
      buildCashFlowChartModel(twoEarners, { view: "outflows" }).bands.map((b) => b.label),
    );

    const net = buildCashFlowChartModel(twoEarners, { view: "net", ownerId: "p2" });
    expect(net.rows[0]![NET_KEY]).toBe(ALEX_PAY + BLAKE_PAY - RENT);
  });

  it("keeps the combined view unchanged when no cut is asked for", () => {
    const model = buildCashFlowChartModel(twoEarners, { view: "inflows", mode: "advanced" });
    expect(model.bands.map((b) => b.label)).toEqual(["Software Engineer", "Teacher"]);
  });
});
