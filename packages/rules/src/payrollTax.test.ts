import { describe, it, expect } from "vitest";
import {
  PAYROLL_TAX_BASE_YEAR,
  payrollTaxTables,
  payrollTaxParts,
  payrollTaxCents,
  PAYROLL_TAX_ASSUMPTIONS,
} from "./payrollTax";

// Figures are annual cents unless a test says otherwise.

describe("payrollTaxTables — the pinned single-filer base year", () => {
  it("pins the 2026 base-year figures exactly (no indexing at/before base)", () => {
    const t = payrollTaxTables(PAYROLL_TAX_BASE_YEAR);
    // SSA 2026 OASDI taxable maximum.
    expect(t.oasdiWageBaseCents).toBe(184_500_00);
    // Employee-share statutory rates.
    expect(t.oasdiRate).toBe(0.062);
    expect(t.medicareRate).toBe(0.0145);
    expect(t.additionalMedicareRate).toBe(0.009);
    // Fixed-in-statute Additional Medicare threshold (single).
    expect(t.additionalMedicareThresholdCents).toBe(200_000_00);
  });

  it("indexes ONLY the wage base forward, monotonically; rates and threshold held", () => {
    const base = payrollTaxTables(PAYROLL_TAX_BASE_YEAR);
    const later = payrollTaxTables(PAYROLL_TAX_BASE_YEAR + 10);
    expect(later.oasdiWageBaseCents).toBeGreaterThan(base.oasdiWageBaseCents);
    // Rates never move.
    expect(later.oasdiRate).toBe(base.oasdiRate);
    expect(later.medicareRate).toBe(base.medicareRate);
    expect(later.additionalMedicareRate).toBe(base.additionalMedicareRate);
    // The $200k surtax threshold is frozen in statute — never indexed.
    expect(later.additionalMedicareThresholdCents).toBe(base.additionalMedicareThresholdCents);
  });

  it("grows the wage base by WAGE growth, outpacing the income-tax side's CPI proxy", () => {
    // The correctness point: over a long horizon the OASDI cap must rise FASTER than the
    // ~2.5%/yr CPI figure the brackets use, or high earners drift into over-taxation.
    const years = 20;
    const later = payrollTaxTables(PAYROLL_TAX_BASE_YEAR + years);
    const cpiGrown = 184_500_00 * Math.pow(1 + 0.025, years);
    expect(later.oasdiWageBaseCents).toBeGreaterThan(cpiGrown);
  });

  it("holds the base year and any earlier year at the exact pinned cap", () => {
    expect(payrollTaxTables(PAYROLL_TAX_BASE_YEAR - 5).oasdiWageBaseCents).toBe(184_500_00);
    // Rounds to the NEAREST $300 (the statutory rule), so it stays a whole multiple.
    const later = payrollTaxTables(PAYROLL_TAX_BASE_YEAR + 3).oasdiWageBaseCents;
    expect(later % 300_00).toBe(0);
  });

  it("rounds to the NEAREST $300 rather than biasing the cap downward", () => {
    // Nearest-rounding must land within half an increment of the un-rounded AWI figure; the
    // old floor-always rule could sit a full $300 low, understating the cap every year.
    for (const years of [1, 3, 7, 20]) {
      const exact = 184_500_00 * Math.pow(1.035, years);
      const cap = payrollTaxTables(PAYROLL_TAX_BASE_YEAR + years).oasdiWageBaseCents;
      expect(Math.abs(cap - exact)).toBeLessThanOrEqual(300_00 / 2);
    }
  });

  it("still never lets the cap fall year over year", () => {
    // Nearest-rounding keeps monotonicity for free: a year of wage growth is thousands of
    // dollars, far past the half-increment jitter rounding can introduce.
    let prev = payrollTaxTables(PAYROLL_TAX_BASE_YEAR).oasdiWageBaseCents;
    for (let y = PAYROLL_TAX_BASE_YEAR + 1; y <= PAYROLL_TAX_BASE_YEAR + 55; y++) {
      const cap = payrollTaxTables(y).oasdiWageBaseCents;
      expect(cap).toBeGreaterThanOrEqual(prev);
      prev = cap;
    }
  });
});

describe("payrollTaxParts / payrollTaxCents — combined annual earned income", () => {
  it("charges full FICA below the wage base (no OASDI cap, no surtax)", () => {
    // $60k earned, the default plan's income: 6.2% + 1.45% = 7.65% of the whole, nothing capped.
    const p = payrollTaxParts(60_000_00, PAYROLL_TAX_BASE_YEAR);
    expect(p.oasdiCents).toBe(3_720_00); // 6.2% × 60,000
    expect(p.medicareCents).toBe(870_00); // 1.45% × 60,000
    expect(p.additionalMedicareCents).toBe(0);
    expect(p.totalCents).toBe(4_590_00);
    expect(payrollTaxCents(60_000_00, PAYROLL_TAX_BASE_YEAR)).toBe(4_590_00);
  });

  it("caps OASDI at the wage base while Medicare keeps running above it", () => {
    // $250k earned in 2026: OASDI stops at $184,500, Medicare on all $250k, surtax on $50k.
    const p = payrollTaxParts(250_000_00, PAYROLL_TAX_BASE_YEAR);
    expect(p.oasdiCents).toBe(Math.round(184_500_00 * 0.062)); // 11,439
    expect(p.medicareCents).toBe(Math.round(250_000_00 * 0.0145)); // 3,625
    // 0.9% on the $50k above the $200k statutory threshold.
    expect(p.additionalMedicareCents).toBe(Math.round(50_000_00 * 0.009)); // 450
    expect(p.totalCents).toBe(p.oasdiCents + p.medicareCents + p.additionalMedicareCents);
  });

  it("applies the surtax only to earned income strictly above the threshold", () => {
    expect(payrollTaxParts(200_000_00, PAYROLL_TAX_BASE_YEAR).additionalMedicareCents).toBe(0);
    expect(payrollTaxParts(200_100_00, PAYROLL_TAX_BASE_YEAR).additionalMedicareCents).toBe(
      Math.round(100_00 * 0.009),
    );
  });

  it("charges nothing on zero earned income", () => {
    const p = payrollTaxParts(0, PAYROLL_TAX_BASE_YEAR);
    expect(p.totalCents).toBe(0);
  });

  it("clamps negative earned income to zero — payroll tax is never a credit", () => {
    // Malformed input must not hand back a negative charge that would offset other tax.
    const p = payrollTaxParts(-50_000_00, PAYROLL_TAX_BASE_YEAR);
    expect(p.oasdiCents).toBe(0);
    expect(p.medicareCents).toBe(0);
    expect(p.additionalMedicareCents).toBe(0);
    expect(p.totalCents).toBe(0);
    expect(payrollTaxCents(-50_000_00, PAYROLL_TAX_BASE_YEAR)).toBe(0);
  });

  it("OASDI on a high earner falls in a later year as the wage base indexes up", () => {
    // Same $300k earner: a higher indexed cap means more of it bears the 6.2%, so the
    // OASDI piece RISES — the anti-drift behaviour the CPI proxy would have suppressed.
    const early = payrollTaxParts(300_000_00, PAYROLL_TAX_BASE_YEAR);
    const late = payrollTaxParts(300_000_00, PAYROLL_TAX_BASE_YEAR + 15);
    expect(late.oasdiCents).toBeGreaterThan(early.oasdiCents);
  });
});

describe("PAYROLL_TAX_ASSUMPTIONS — the wage-vs-price and frozen-threshold disclosures", () => {
  it("discloses both the wage-indexed cap and the un-indexed surtax threshold", () => {
    const ids = PAYROLL_TAX_ASSUMPTIONS.map((a) => a.id);
    expect(ids).toContain("oasdiWageBaseWageIndexed");
    expect(ids).toContain("additionalMedicareThresholdUnindexed");
    for (const a of PAYROLL_TAX_ASSUMPTIONS) expect(a.text.length).toBeGreaterThan(0);
  });
});
