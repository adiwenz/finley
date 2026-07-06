import { describe, it, expect } from "vitest";
import { simulate, type SimulationInput } from "./projection";
import { nullJurisdiction } from "./jurisdiction";
import { dollarsToCents } from "./cashFlowSeries";

const baseInput: SimulationInput = {
  horizonMonths: 24,
  openingNetWorthCents: dollarsToCents(10000),
  monthlyNetFlowCents: dollarsToCents(500),
  annualInflationRate: 0.03,
  startYear: 2026,
};

describe("simulate (Slice 0 walking skeleton)", () => {
  it("runs standalone with the null jurisdiction", () => {
    const series = simulate(baseInput, nullJurisdiction);
    // horizonMonths inclusive of month 0
    expect(series.months.length).toBe(25);
    expect(series.months[0].month).toBe(0);
    expect(series.months[24].month).toBe(24);
  });

  it("net worth is integer cents at every month, nominal and real", () => {
    const series = simulate(baseInput, nullJurisdiction);
    for (const m of series.months) {
      expect(Number.isInteger(m.netWorthNominalCents)).toBe(true);
      expect(Number.isInteger(m.netWorthRealCents)).toBe(true);
    }
  });

  it("accumulates the flat monthly net flow (null jurisdiction takes no tax)", () => {
    const series = simulate(baseInput, nullJurisdiction);
    expect(series.months[0].netWorthNominalCents).toBe(dollarsToCents(10000));
    // opening + 500/mo * 24 months
    expect(series.months[24].netWorthNominalCents).toBe(dollarsToCents(10000 + 500 * 24));
  });

  it("reports real < nominal when inflation is positive (month 0 excepted)", () => {
    const series = simulate(baseInput, nullJurisdiction);
    expect(series.months[0].netWorthRealCents).toBe(series.months[0].netWorthNominalCents);
    const last = series.months[24];
    expect(last.netWorthRealCents).toBeLessThan(last.netWorthNominalCents);
  });

  it("routes net flow through the jurisdiction tax seam", () => {
    // A stub jurisdiction that taxes 100% of positive flow => net worth stays flat.
    const confiscatory = {
      id: "confiscatory",
      computeTaxCents: (taxable: number) => taxable,
    };
    const series = simulate(baseInput, confiscatory);
    expect(series.months[24].netWorthNominalCents).toBe(dollarsToCents(10000));
  });
});
