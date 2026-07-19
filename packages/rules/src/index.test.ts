import { describe, it, expect } from "vitest";
import { simulateHousehold, SimCashFlowSeries, SimAccount, dollarsToCents, CAPITAL_GAINS_TAX_PROFILE } from "@finley/engine";
import { usJurisdiction } from "./index";

// Proves rules can consume the engine (app → rules → engine direction) and that
// the placeholder US-2026 jurisdiction implements the interface.
describe("usJurisdiction (placeholder US-2026)", () => {
  it("implements the jurisdiction interface", () => {
    expect(usJurisdiction.id).toBe("US-2026");
    expect(
      usJurisdiction.computeTaxCents({ wages: dollarsToCents(1000) }, { year: 2026 }),
    ).toBe(0);
  });

  it("drives the engine's household simulator end to end", () => {
    // $100/mo income into a non-compounding cash account, no expenses; the
    // placeholder US-2026 jurisdiction takes no tax, so net worth = 100 * 12.
    const series = simulateHousehold(
      {
        horizonMonths: 12,
        annualInflationRate: 0.02,
        persons: [{ id: "p1", name: "You" }],
        accounts: [
          new SimAccount({
            id: "cash",
            ownerId: "p1",
            liquid: true,
            taxProfile: CAPITAL_GAINS_TAX_PROFILE,
            openingBalanceCents: 0,
            initialAnnualRate: 0,
          }),
        ],
        incomeSeries: [
          {
            series: new SimCashFlowSeries(0, dollarsToCents(100), { type: "fixed" }, { baselineUnit: "monthly" }),
            ownerId: "p1",
          },
        ],
        expenseSeries: [],
      },
      usJurisdiction,
    );
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(1200));
  });
});
