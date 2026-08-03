import { describe, expect, it } from "vitest";
import { dollarsToCents, type ProjectionIncomeSource, type ProjectionSeries } from "@finley/engine";
import { buildIncomeChartData } from "./incomeChartData";
import { buildIncomeChartModel, SPENDING_NEED_KEY } from "./incomeChartModel";

/** Minimal series: month 0 is flow-free; later months carry income sources. */
function seriesOf(...perMonth: ProjectionIncomeSource[][]): ProjectionSeries {
  const months = [
    { month: 0 },
    ...perMonth.map((incomeSources, i) => ({ month: i + 1, flows: { incomeSources } })),
  ];
  return { months } as unknown as ProjectionSeries;
}

function source(
  sourceId: string,
  cashInflowCents: number,
  category: ProjectionIncomeSource["category"],
  extra: Partial<ProjectionIncomeSource> = {},
): ProjectionIncomeSource {
  return {
    sourceId,
    label: sourceId,
    category,
    cashInflowCents,
    netCashFlowCents: cashInflowCents,
    ...extra,
  } as ProjectionIncomeSource;
}

const wages = source("job:a", dollarsToCents(5_000), "wages");

describe("buildIncomeChartModel", () => {
  it("renders one band per source with a stable id, label and colour", () => {
    const data = buildIncomeChartData(seriesOf([wages]));
    const model = buildIncomeChartModel(data, { mode: "advanced" });
    const band = model.bands.find((b) => b.id === "job:a");
    expect(band).toBeDefined();
    expect(band!.label).toBe("job:a");
    expect(band!.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("produces render-ready rows that carry the spending-need under its namespaced key", () => {
    const data = buildIncomeChartData(seriesOf([wages]));
    const model = buildIncomeChartModel(data, { mode: "advanced" });
    // Month 1 (the first flowed month) sits at axis x = 1: the flow-free "now" holds x = 0.
    const firstRow = model.rows[0]!;
    expect(firstRow[SPENDING_NEED_KEY]).toBe(0);
    expect(firstRow["job:a"]).toBe(dollarsToCents(5_000));
  });

  it("collapses drawdowns onto one 'Living off savings' band in Simple mode", () => {
    const data = buildIncomeChartData(
      seriesOf([source("acct:a", dollarsToCents(1_000), "savingsDrawdown")]),
    );
    const simple = buildIncomeChartModel(data, { mode: "simple" });
    expect(simple.bands.map((b) => b.label)).toContain("Living off savings");
    const advanced = buildIncomeChartModel(data, { mode: "advanced" });
    expect(advanced.bands.map((b) => b.label)).not.toContain("Living off savings");
  });

  it("formats the insolvency marker as the household's age, not a month index", () => {
    const insolventSeries = {
      months: [
        { month: 0 },
        { month: 1, isInsolvent: true, flows: { incomeSources: [] } },
      ],
    } as unknown as ProjectionSeries;
    const data = buildIncomeChartData(insolventSeries);
    const model = buildIncomeChartModel(data, { mode: "simple", currentAge: 40 });
    expect(model.brokeMonth).toBe(1);
    expect(model.brokeAgeLabel).toBe("40");
  });

  it("summarises the income gap in words for assistive technology", () => {
    const data = buildIncomeChartData(
      seriesOf([source("acct:a", dollarsToCents(1_000), "savingsDrawdown")]),
    );
    const model = buildIncomeChartModel(data, { mode: "simple" });
    expect(model.accessibleSummary).toMatch(/living off savings/i);
  });
});
