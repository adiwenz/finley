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

  it("describes each source with a user label and formatted dollars, never ids or raw cents", () => {
    const data = buildIncomeChartData(seriesOf([wages]));
    const model = buildIncomeChartModel(data, { mode: "advanced" });
    const moment = model.accessibleMoments[0]!;
    const row = moment.sources.find((r) => r.label === "job:a");
    expect(row).toBeDefined();
    // Formatted currency, not the 500000-cent integer.
    expect(row!.amount).toBe("$5,000");
    // Broader than "income": the total is every cash source, drawdowns included.
    expect(moment.totalCashFlow).toBe("$5,000");
  });

  it("formats the spending need for assistive tech rather than exposing cents", () => {
    const withNeed = {
      months: [
        { month: 0 },
        {
          month: 1,
          flows: {
            incomeSources: [source("job:a", dollarsToCents(5_000), "wages")],
            expensesCents: dollarsToCents(3_000),
            liabilityPaymentsCents: dollarsToCents(200),
          },
        },
      ],
    } as unknown as ProjectionSeries;
    const model = buildIncomeChartModel(buildIncomeChartData(withNeed), { mode: "simple" });
    expect(model.accessibleMoments[0]!.spendingNeed).toBe("$3,200");
  });

  describe("accessible moments — transitions over time, not one snapshot", () => {
    it("anchors the first moment on the projection's start", () => {
      const data = buildIncomeChartData(seriesOf([wages]));
      const model = buildIncomeChartModel(data, { mode: "advanced" });
      expect(model.accessibleMoments).toHaveLength(1);
      expect(model.accessibleMoments[0]!.reason).toMatch(/projection starts/i);
      expect(model.accessibleMoments[0]!.label).toMatch(/month 1/);
    });

    it("adds a moment when a band begins, and another when it ends", () => {
      const series = {
        months: [
          { month: 0 },
          { month: 1, flows: { incomeSources: [] } },
          { month: 2, flows: { incomeSources: [source("job:a", dollarsToCents(5_000), "wages")] } },
          { month: 3, flows: { incomeSources: [source("job:a", dollarsToCents(5_000), "wages")] } },
          { month: 4, flows: { incomeSources: [] } },
        ],
      } as unknown as ProjectionSeries;
      const model = buildIncomeChartModel(buildIncomeChartData(series), { mode: "advanced" });
      const reasonsByMonth = new Map(
        model.accessibleMoments.map((m) => [m.label.match(/month (\d+)/)![1], m.reason]),
      );
      expect(reasonsByMonth.get("2")).toMatch(/job:a begins/i);
      expect(reasonsByMonth.get("4")).toMatch(/job:a ends/i);
      // Month 3 changes nothing of its own, but it is the last month the band pays before the
      // month-4 ending — so it surfaces as that ending's "before", not as a change.
      expect(reasonsByMonth.get("3")).toMatch(/last reading before the change/i);
      expect(reasonsByMonth.get("3")).not.toMatch(/changes/i);
    });

    it("adds a moment when a band's amount changes without beginning or ending", () => {
      const series = {
        months: [
          { month: 0 },
          { month: 1, flows: { incomeSources: [source("job:a", dollarsToCents(5_000), "wages")] } },
          { month: 2, flows: { incomeSources: [source("job:a", dollarsToCents(5_500), "wages")] } },
        ],
      } as unknown as ProjectionSeries;
      const model = buildIncomeChartModel(buildIncomeChartData(series), { mode: "advanced" });
      const raise = model.accessibleMoments.find((m) => /month 2/.test(m.label));
      expect(raise?.reason).toMatch(/job:a changes/i);
    });

    it("adds a moment when the spending need changes", () => {
      const series = {
        months: [
          { month: 0 },
          {
            month: 1,
            flows: {
              incomeSources: [source("job:a", dollarsToCents(5_000), "wages")],
              expensesCents: dollarsToCents(3_000),
            },
          },
          {
            month: 2,
            flows: {
              incomeSources: [source("job:a", dollarsToCents(5_000), "wages")],
              expensesCents: dollarsToCents(3_200),
            },
          },
        ],
      } as unknown as ProjectionSeries;
      const model = buildIncomeChartModel(buildIncomeChartData(series), { mode: "advanced" });
      const change = model.accessibleMoments.find((m) => /month 2/.test(m.label));
      expect(change?.reason).toMatch(/spending need changes/i);
    });

    it("names the first savings withdrawal explicitly", () => {
      const data = buildIncomeChartData(
        seriesOf([source("acct:a", dollarsToCents(1_000), "savingsDrawdown")]),
      );
      const model = buildIncomeChartModel(data, { mode: "simple" });
      const withdrawal = model.accessibleMoments.find((m) => /month 1/.test(m.label));
      expect(withdrawal?.reason).toMatch(/first savings withdrawal/i);
    });

    it("says nothing about a steady drift — the chart draws it and the editor resolves it", () => {
      // 0.25%/month — 3% a year, the default plan's inflation, which is what made an exact
      // cents comparison call 563 of 660 months a moment.
      const months = [
        { month: 0 },
        ...Array.from({ length: 240 }, (_, i) => ({
          month: i + 1,
          flows: {
            incomeSources: [source("job:a", Math.round(dollarsToCents(5_000) * 1.0025 ** i), "wages")],
          },
        })),
      ] as unknown as ProjectionSeries["months"];
      const model = buildIncomeChartModel(
        buildIncomeChartData({ months } as unknown as ProjectionSeries),
        { mode: "advanced" },
      );
      // Every month differs, so the exact comparison this replaced surfaced all 240. Nothing
      // STEPS, so the table is the projection's start and nothing else: the ramp is the chart's
      // to draw, and any month of it is reachable through the editor's Month field.
      expect(model.accessibleMoments).toHaveLength(1);
      expect(model.accessibleMoments[0]!.reason).toMatch(/projection starts/i);
    });

    it("still catches a raise inside the drift — a step, not the indexation around it", () => {
      const ramp = (i: number) => Math.round(dollarsToCents(5_000) * 1.0025 ** i);
      const series = {
        months: [
          { month: 0 },
          ...Array.from({ length: 24 }, (_, i) => ({
            month: i + 1,
            // A 20% raise at month 13, on top of the same 0.25%/month indexation.
            flows: {
              incomeSources: [source("job:a", ramp(i) * (i >= 12 ? 1.2 : 1), "wages")],
            },
          })),
        ],
      } as unknown as ProjectionSeries;
      const model = buildIncomeChartModel(buildIncomeChartData(series), { mode: "advanced" });
      const byMonth = new Map(
        model.accessibleMoments.map((m) => [Number(m.label.match(/month (\d+)/)![1]), m]),
      );
      expect(byMonth.get(13)!.reason).toMatch(/job:a changes/i);
      expect(byMonth.get(12)!.reason).toMatch(/last reading before the change/i);
      // The indexation either side of it says nothing: start, the raise, and its before.
      expect(model.accessibleMoments).toHaveLength(3);
    });

    it("keeps a band's beginning and end however small the amount", () => {
      // Below the drift threshold in absolute terms, but structural: the chart's shape changes.
      const series = {
        months: [
          { month: 0 },
          { month: 1, flows: { incomeSources: [source("job:a", dollarsToCents(5_000), "wages")] } },
          {
            month: 2,
            flows: {
              incomeSources: [
                source("job:a", dollarsToCents(5_000), "wages"),
                source("job:b", 1, "wages"),
              ],
            },
          },
          { month: 3, flows: { incomeSources: [source("job:a", dollarsToCents(5_000), "wages")] } },
        ],
      } as unknown as ProjectionSeries;
      const model = buildIncomeChartModel(buildIncomeChartData(series), { mode: "advanced" });
      const reasonsByMonth = new Map(
        model.accessibleMoments.map((m) => [m.label.match(/month (\d+)/)![1], m.reason]),
      );
      expect(reasonsByMonth.get("2")).toMatch(/job:b begins/i);
      expect(reasonsByMonth.get("3")).toMatch(/job:b ends/i);
    });

    it("states the month before a discrete change, so it is heard as a before-and-after", () => {
      // job:b starts at month 6 with nothing else moving, so months 2-5 are unremarkable and
      // sampling alone would leave the change to be heard against month 1.
      const flat = source("job:a", dollarsToCents(5_000), "wages");
      const series = {
        months: [
          { month: 0 },
          ...Array.from({ length: 5 }, (_, i) => ({
            month: i + 1,
            flows: { incomeSources: [flat] },
          })),
          {
            month: 6,
            flows: {
              incomeSources: [flat, source("job:b", dollarsToCents(2_000), "wages")],
            },
          },
        ],
      } as unknown as ProjectionSeries;
      const model = buildIncomeChartModel(buildIncomeChartData(series), { mode: "advanced" });
      const byMonth = new Map(
        model.accessibleMoments.map((m) => [Number(m.label.match(/month (\d+)/)![1]), m]),
      );
      expect(byMonth.get(6)!.reason).toMatch(/job:b begins/i);
      // Month 5 carries no change of its own; it is here to be the "before".
      expect(byMonth.get(5)!.reason).toMatch(/last reading before the change/i);
      expect(byMonth.get(5)!.sources.find((s) => s.label === "job:b")!.amount).toBe("$0");
      expect(byMonth.get(6)!.sources.find((s) => s.label === "job:b")!.amount).toBe("$2,000");
      // Bought for one row group, not a run of them: months 2-4 stay out.
      expect(byMonth.has(4)).toBe(false);
    });

    it("adds an insolvency moment naming the household's age", () => {
      const insolventSeries = {
        months: [
          { month: 0 },
          { month: 1, flows: { incomeSources: [] } },
          { month: 2, isInsolvent: true, flows: { incomeSources: [] } },
        ],
      } as unknown as ProjectionSeries;
      const model = buildIncomeChartModel(buildIncomeChartData(insolventSeries), {
        mode: "simple",
        currentAge: 40,
      });
      const insolvency = model.accessibleMoments.find((m) => /month 2/.test(m.label));
      expect(insolvency?.reason).toMatch(/plan becomes insolvent/i);
      expect(insolvency?.label).toMatch(/age 40/);
    });
  });
});
