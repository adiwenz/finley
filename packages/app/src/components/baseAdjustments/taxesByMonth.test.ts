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
    expect(data.sources).toEqual([{ id: "wages", label: "Wages", category: "wages" }]);
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
      { id: "interest:p1:ordinaryIncome", label: "Savings interest", category: "savingsInterest" },
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
    // Peak in month 13 → Year 2.
    const rows = Array.from({ length: 13 }, (_, i) => (i === 12 ? dollarsToCents(900) : dollarsToCents(300)));
    const summary = describeTaxes(buildTaxChartData(seriesOf(...rows)));
    expect(summary).toMatch(/in tax over the plan/);
    expect(summary).toMatch(/Year 2/);
    expect(summary).toMatch(/Federal income tax only/);
  });
});
