import { describe, it, expect } from "vitest";
import { dollarsToCents } from "../money/cashFlowSeries";
import type { Cents } from "../money/money";
import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import { annualFederalTax } from "./federalIncomeTax";

const CATEGORIES = ["wages", "ordinaryIncome", "capitalGains", "taxExempt"] as const;

function flatAnnual(rate: number): Jurisdiction {
  const perCategory = (byCat: Partial<Record<string, number>>): Partial<Record<string, number>> => {
    const out: Partial<Record<string, number>> = {};
    for (const category of CATEGORIES) {
      const v = byCat[category] ?? 0;
      if (v > 0) out[category] = Math.round(v * rate);
    }
    return out;
  };
  return {
    id: "flat-annual",
    computeTaxByCategoryCents: perCategory,
    computeTaxCents: (byCat) =>
      Object.values(perCategory(byCat)).reduce((s: number, v) => s + (v ?? 0), 0),
  };
}

describe("annualFederalTax", () => {
  it("prices a full year of taxable income through the jurisdiction's own seams", () => {
    const result = annualFederalTax(
      flatAnnual(0.25),
      { year: 2026 },
      "p1",
      { wages: dollarsToCents(100_000) },
    );
    expect(result.totalCents).toBe(dollarsToCents(25_000));
    expect(result.byCategoryCents).toEqual({ wages: dollarsToCents(25_000) });
  });

  it("throws when the jurisdiction's category breakdown does not reconcile to its own scalar total", () => {
    const broken: Jurisdiction = {
      id: "broken",
      computeTaxCents: () => dollarsToCents(100),
      computeTaxByCategoryCents: () => ({ wages: dollarsToCents(50) }),
    };
    expect(() =>
      annualFederalTax(broken, { year: 2026 }, "p1", { wages: dollarsToCents(1_000) }),
    ).toThrow();
  });

  it("prices $0 for a household with no taxable income", () => {
    const result = annualFederalTax(flatAnnual(0.25), { year: 2026 }, "p1", {});
    expect(result.totalCents).toBe(0 as Cents);
  });
});
