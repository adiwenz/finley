import { describe, expect, it } from "vitest";
import { dollarsToCents, type ProjectionSeries } from "@finley/engine";
import { buildTaxChartData, describeTaxes } from "./taxesByMonth";

/** A minimal series fixture: month 0 has no flows; later months carry a tax figure. */
function seriesOf(...taxCents: number[]): ProjectionSeries {
  const months = [
    { month: 0 },
    ...taxCents.map((tax, i) => ({ month: i + 1, flows: { taxCents: tax } })),
  ];
  return { months } as unknown as ProjectionSeries;
}

/** A fixture whose flowed months carry a per-category tax breakdown (issue #110). */
function seriesWithBreakdown(
  ...breakdowns: Readonly<Record<string, number>>[]
): ProjectionSeries {
  const months = [
    { month: 0 },
    ...breakdowns.map((byCategory, i) => ({
      month: i + 1,
      flows: {
        taxCents: Object.values(byCategory).reduce((s, c) => s + c, 0),
        taxByCategoryCents: byCategory,
      },
    })),
  ];
  return { months } as unknown as ProjectionSeries;
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

describe("buildTaxChartData — per-category stacking (issue #110)", () => {
  it("has no category breakdown when the engine reports only a total (single band)", () => {
    const data = buildTaxChartData(seriesOf(dollarsToCents(300), dollarsToCents(420)));
    expect(data.hasCategoryBreakdown).toBe(false);
    expect(data.categories).toEqual([]);
  });

  it("exposes the union of tax categories in stable stacking order", () => {
    const data = buildTaxChartData(
      seriesWithBreakdown(
        { wages: dollarsToCents(200), capitalGains: dollarsToCents(50) },
        { wages: dollarsToCents(180), governmentRetirementBenefit: dollarsToCents(40) },
      ),
    );
    expect(data.hasCategoryBreakdown).toBe(true);
    // Wages first, then the benefit, then gains — the documented order.
    expect(data.categories.map((c) => c.category)).toEqual([
      "wages",
      "governmentRetirementBenefit",
      "capitalGains",
    ]);
  });

  it("keeps each month's per-category cents, and the bands sum to the month total", () => {
    const data = buildTaxChartData(
      seriesWithBreakdown({ wages: dollarsToCents(200), capitalGains: dollarsToCents(50) }),
    );
    const row = data.rows[0]!;
    expect(row.centsByCategory.wages).toBe(dollarsToCents(200));
    expect(row.centsByCategory.capitalGains).toBe(dollarsToCents(50));
    const banded = Object.values(row.centsByCategory).reduce((s, c) => s + c, 0);
    expect(banded).toBe(row.taxCents);
  });

  it("drops a category that carries no tax anywhere (no empty legend band)", () => {
    const data = buildTaxChartData(
      seriesWithBreakdown({ wages: dollarsToCents(200), capitalGains: 0 }),
    );
    expect(data.categories.map((c) => c.category)).toEqual(["wages"]);
  });

  it("still totals and peaks correctly off the breakdown months", () => {
    const data = buildTaxChartData(
      seriesWithBreakdown(
        { wages: dollarsToCents(300) },
        { wages: dollarsToCents(500), capitalGains: dollarsToCents(400) },
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
