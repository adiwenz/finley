import { describe, it, expect } from "vitest";
import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import { monthlyIncomeTaxCents, monthlyIncomeTaxByCategoryCents } from "./incomeTax";

const CTX = { year: 2026 };

/** A flat 25% ANNUAL tax on ordinaryIncome — the seam's new annual-in/annual-out contract. */
const flat25: Jurisdiction = {
  id: "flat-25-annual",
  computeTaxCents: (annualByCategory) => Math.round((annualByCategory.ordinaryIncome ?? 0) * 0.25),
  computeTaxByCategoryCents: (annualByCategory) => {
    const t = Math.round((annualByCategory.ordinaryIncome ?? 0) * 0.25);
    return t > 0 ? { ordinaryIncome: t } : {};
  },
};

describe("monthlyIncomeTaxCents — annualize this month ×12, tax it, return the monthly share", () => {
  it("taxes a steady $10k/mo salary as if $120k/yr, returning 1/12 of the annual liability", () => {
    // $120k × 25% = $30k annual → $2,500/mo.
    expect(monthlyIncomeTaxCents(flat25, CTX, { ordinaryIncome: 10_000_00 })).toBe(2_500_00);
  });

  it("returns 0 when no taxable income is given", () => {
    expect(monthlyIncomeTaxCents(flat25, CTX, {})).toBe(0);
  });
});

describe("monthlyIncomeTaxByCategoryCents — sums exactly to the scalar monthly seam", () => {
  it("attributes the whole monthly charge to the sole taxed category", () => {
    const monthly = monthlyIncomeTaxCents(flat25, CTX, { ordinaryIncome: 10_000_00 });
    const byCategory = monthlyIncomeTaxByCategoryCents(flat25, CTX, { ordinaryIncome: 10_000_00 });
    expect(byCategory).toEqual({ ordinaryIncome: monthly });
  });
});
