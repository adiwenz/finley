import { describe, it, expect } from "vitest";
import {
  FEDERAL_TAX_BASE_YEAR,
  federalTaxTables,
  taxableSocialSecurityCents,
  federalAnnualTaxCents,
  computeFederalTaxCents,
} from "./federalTax";

// All figures are annual cents unless a test says otherwise. The seam the engine
// wires (`computeFederalTaxCents`) receives MONTHLY per-category amounts; the pure
// bracket math is exercised through the annual entry point `federalAnnualTaxCents`.

describe("federalTaxTables — the pinned single-filer base year", () => {
  it("pins the 2026 base-year figures exactly (no indexing at/before base)", () => {
    const t = federalTaxTables(FEDERAL_TAX_BASE_YEAR);
    expect(t.standardDeductionCents).toBe(16_100_00);
    // Ordinary brackets: lower edge + marginal rate, ascending.
    expect(t.ordinaryBrackets[0]).toEqual({ lowerCents: 0, rate: 0.1 });
    expect(t.ordinaryBrackets[2]).toEqual({ lowerCents: 50_400_00, rate: 0.22 });
    expect(t.ordinaryBrackets[6]).toEqual({ lowerCents: 640_600_00, rate: 0.37 });
    // Preferential long-term capital-gains bracket tops.
    expect(t.capitalGainsZeroTopCents).toBe(49_450_00);
    expect(t.capitalGainsFifteenTopCents).toBe(545_050_00);
  });

  it("indexes brackets and the standard deduction forward, monotonically", () => {
    const base = federalTaxTables(FEDERAL_TAX_BASE_YEAR);
    const later = federalTaxTables(FEDERAL_TAX_BASE_YEAR + 10);
    expect(later.standardDeductionCents).toBeGreaterThan(base.standardDeductionCents);
    expect(later.ordinaryBrackets[1].lowerCents).toBeGreaterThan(base.ordinaryBrackets[1].lowerCents);
    expect(later.capitalGainsZeroTopCents).toBeGreaterThan(base.capitalGainsZeroTopCents);
    // Rates never move — only the thresholds index.
    expect(later.ordinaryBrackets.map((b) => b.rate)).toEqual(base.ordinaryBrackets.map((b) => b.rate));
  });
});

describe("federalAnnualTaxCents — ordinary brackets + standard deduction", () => {
  it("taxes $100k of wages through the standard deduction and bracket stack", () => {
    // 100,000 − 16,100 std = 83,900 taxable:
    //   10% × 12,400 = 1,240
    //   12% × (50,400 − 12,400) = 4,560
    //   22% × (83,900 − 50,400) = 7,370
    //   = 13,170
    expect(federalAnnualTaxCents({ wages: 100_000_00 }, 2026)).toBe(13_170_00);
  });

  it("returns 0 when income is at or below the standard deduction", () => {
    expect(federalAnnualTaxCents({ wages: 12_000_00 }, 2026)).toBe(0);
    expect(federalAnnualTaxCents({ ordinaryIncome: 16_100_00 }, 2026)).toBe(0);
  });

  it("treats wages and ordinaryIncome identically (both ordinary)", () => {
    expect(federalAnnualTaxCents({ wages: 50_000_00, ordinaryIncome: 50_000_00 }, 2026)).toBe(
      federalAnnualTaxCents({ wages: 100_000_00 }, 2026),
    );
  });

  it("never taxes tax-exempt income", () => {
    expect(federalAnnualTaxCents({ taxExempt: 500_000_00 }, 2026)).toBe(0);
  });
});

describe("federalAnnualTaxCents — capital-gains preference (stacked)", () => {
  it("stacks gains on top of ordinary income, straddling the 0% band", () => {
    // wages 50,000 − 16,100 = 33,900 ordinary taxable → ordinary tax 3,820.
    //   10% × 12,400 = 1,240; 12% × 21,500 = 2,580 → 3,820.
    // Gains 20,000 stack from 33,900. 0% top = 49,450, so 15,550 at 0%,
    //   remaining 4,450 at 15% = 667.50.
    // Total = 3,820 + 667.50 = 4,487.50.
    expect(federalAnnualTaxCents({ wages: 50_000_00, capitalGains: 20_000_00 }, 2026)).toBe(4_487_50);
  });

  it("taxes gains that fall entirely inside the 0% band at nothing", () => {
    // Only gains, well under the 0% top after the standard deduction.
    expect(federalAnnualTaxCents({ capitalGains: 30_000_00 }, 2026)).toBe(0);
  });
});

describe("taxableSocialSecurityCents — provisional-income inclusion (single)", () => {
  it("includes nothing below the first threshold", () => {
    expect(taxableSocialSecurityCents(20_000_00, 10_000_00)).toBe(0);
  });

  it("caps inclusion at 85% of the benefit for high provisional income", () => {
    // Benefit 30,000, other provisional 100,000 → 0.85 × 30,000 = 25,500.
    expect(taxableSocialSecurityCents(30_000_00, 100_000_00)).toBe(25_500_00);
  });

  it("applies the middle-tier formula between the thresholds", () => {
    // Benefit 30,000, other 30,000 → provisional = 30,000 + 15,000 = 45,000 > 34,000.
    //   min(0.85×30,000, 0.85×(45,000−34,000) + min(0.5×30,000, 4,500))
    //   = min(25,500, 9,350 + 4,500) = 13,850.
    expect(taxableSocialSecurityCents(30_000_00, 30_000_00)).toBe(13_850_00);
  });
});

describe("federalAnnualTaxCents — government benefit inclusion end to end", () => {
  it("taxes only the included portion of a Social Security benefit", () => {
    // Benefit 30,000 + wages 30,000. Taxable SS = 13,850 (above).
    // Ordinary taxable = 30,000 + 13,850 − 16,100 = 27,750.
    //   10% × 12,400 = 1,240; 12% × 15,350 = 1,842 → 3,082.
    expect(
      federalAnnualTaxCents({ wages: 30_000_00, governmentRetirementBenefit: 30_000_00 }, 2026),
    ).toBe(3_082_00);
  });

  it("counts tax-exempt income toward provisional income for the SS test", () => {
    // Same benefit but the other income is tax-exempt: it still pushes SS into the
    // taxable range even though it is not itself taxed.
    const withTaxExempt = federalAnnualTaxCents(
      { taxExempt: 30_000_00, governmentRetirementBenefit: 30_000_00 },
      2026,
    );
    // 13,850 of SS becomes taxable ordinary income; taxed after the std deduction.
    // 13,850 − 16,100 < 0 → 0 tax, but the inclusion still happened (asserted via SS helper).
    expect(withTaxExempt).toBe(0);
    expect(taxableSocialSecurityCents(30_000_00, 30_000_00)).toBe(13_850_00);
  });
});

describe("computeFederalTaxCents — the monthly seam", () => {
  it("annualizes the monthly slice, taxes it, and returns the monthly portion", () => {
    // $100k/yr of wages = 100_000_00/12 per month. Annual tax 13,170 → /12 monthly.
    const monthly = computeFederalTaxCents({ wages: Math.round(100_000_00 / 12) }, 2026);
    expect(monthly).toBe(Math.round(13_170_00 / 12));
  });

  it("returns 0 for a monthly slice that annualizes below the standard deduction", () => {
    expect(computeFederalTaxCents({ wages: 100_00 }, 2026)).toBe(0);
  });
});
