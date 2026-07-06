import { describe, it, expect } from "vitest";
import { simulate, dollarsToCents } from "@finley/engine";
import { usJurisdiction } from "./index";

// Proves rules can consume the engine (app → rules → engine direction) and that
// the placeholder US-2026 jurisdiction implements the interface.
describe("usJurisdiction (placeholder US-2026)", () => {
  it("implements the jurisdiction interface", () => {
    expect(usJurisdiction.id).toBe("US-2026");
    expect(usJurisdiction.computeTaxCents(dollarsToCents(1000), { year: 2026 })).toBe(0);
  });

  it("drives the engine's simulate() end to end", () => {
    const series = simulate(
      {
        horizonMonths: 12,
        openingNetWorthCents: dollarsToCents(0),
        monthlyNetFlowCents: dollarsToCents(100),
        annualInflationRate: 0.02,
      },
      usJurisdiction,
    );
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(1200));
  });
});
