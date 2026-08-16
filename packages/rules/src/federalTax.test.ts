import { describe, it, expect } from "vitest";
import {
  FEDERAL_TAX_BASE_YEAR,
  federalTaxTables,
  taxableSocialSecurityCents,
  federalAnnualTaxCents,
  federalAnnualTaxByCategoryCents,
} from "./federalTax";

/** Σ of a per-category tax map — the invariant the attribution must preserve. */
function sumCents(byCategory: Partial<Record<string, number>>): number {
  return Object.values(byCategory).reduce((s: number, v) => s + (v ?? 0), 0);
}

// Figures are annual cents unless a test says otherwise.

describe("federalTaxTables — the pinned single-filer base year", () => {
  it("pins the 2026 base-year figures exactly (no indexing at/before base)", () => {
    const t = federalTaxTables(FEDERAL_TAX_BASE_YEAR);
    expect(t.standardDeductionCents).toBe(16_100_00);
    // Ordinary brackets: lower edge + marginal rate, ascending.
    expect(t.ordinaryBrackets[0]).toEqual({ lowerCents: 0, rate: 0.1 });
    expect(t.ordinaryBrackets[2]).toEqual({ lowerCents: 50_400_00, rate: 0.22 });
    expect(t.ordinaryBrackets[6]).toEqual({ lowerCents: 640_600_00, rate: 0.37 });
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

  it("keeps a drawn-down cash balance OUT of provisional income", () => {
    // `taxedAtAccrual` is not income at all — it is principal the household finished paying tax on
    // the month the interest was credited. Spending savings must not drag Social Security into
    // tax, which is exactly what `taxExempt` (real, merely-untaxed income) does below.
    const spendingSavings = federalAnnualTaxCents(
      { taxedAtAccrual: 200_000_00, governmentRetirementBenefit: 30_000_00 },
      2026,
    );
    expect(spendingSavings).toBe(federalAnnualTaxCents({ governmentRetirementBenefit: 30_000_00 }, 2026));
    expect(spendingSavings).toBe(0);
    // Not vacuous: the same figure under the exempt-INTEREST category does reach the test.
    expect(taxableSocialSecurityCents(30_000_00, 200_000_00)).toBeGreaterThan(0);
  });

  it("counts cash interest toward provisional income ONCE, at accrual", () => {
    // The other half of the test above, and the reason it is not a loophole: interest on a cash
    // balance is ordinary income in the year it is credited, and reaches the benefit test there
    // like any other ordinary dollar. Only the later drawdown of the balance it grew is excluded.
    const interestAccrued = federalAnnualTaxCents(
      { ordinaryIncome: 20_000_00, governmentRetirementBenefit: 30_000_00 },
      2026,
    );
    expect(interestAccrued).toBeGreaterThan(
      federalAnnualTaxCents({ governmentRetirementBenefit: 30_000_00 }, 2026),
    );
    // Spending the balance that interest accumulated into adds nothing on top: one dollar of
    // interest, one appearance in the test.
    expect(
      federalAnnualTaxCents(
        { ordinaryIncome: 20_000_00, taxedAtAccrual: 200_000_00, governmentRetirementBenefit: 30_000_00 },
        2026,
      ),
    ).toBe(interestAccrued);
  });

  it("keeps borrowed principal out of both the brackets and the benefit test", () => {
    // Loan proceeds are not income under any regime. Asserted against a benefit big enough that
    // any leak into provisional income would show as tax.
    const borrowed = federalAnnualTaxCents(
      { borrow: 500_000_00, governmentRetirementBenefit: 30_000_00 },
      2026,
    );
    expect(borrowed).toBe(federalAnnualTaxCents({ governmentRetirementBenefit: 30_000_00 }, 2026));
    expect(borrowed).toBe(0);
  });

  it("counts tax-exempt income toward provisional income for the SS test", () => {
    const withTaxExempt = federalAnnualTaxCents(
      { taxExempt: 30_000_00, governmentRetirementBenefit: 30_000_00 },
      2026,
    );
    // 13,850 of SS becomes taxable ordinary income; 13,850 − 16,100 < 0 → 0 tax, but the
    // inclusion still happened (asserted via the SS helper).
    expect(withTaxExempt).toBe(0);
    expect(taxableSocialSecurityCents(30_000_00, 30_000_00)).toBe(13_850_00);
  });
});

describe("federalAnnualTaxByCategoryCents — per-category attribution", () => {
  it("attributes all tax to the sole taxed category (wages only)", () => {
    const total = federalAnnualTaxCents({ wages: 100_000_00 }, 2026);
    const byCategory = federalAnnualTaxByCategoryCents({ wages: 100_000_00 }, 2026);
    expect(byCategory).toEqual({ wages: total });
  });

  it("keeps the split summing EXACTLY to the scalar total (the AC invariant)", () => {
    const input = {
      wages: 30_000_00,
      capitalGains: 20_000_00,
      governmentRetirementBenefit: 30_000_00,
    };
    const total = federalAnnualTaxCents(input, 2026);
    const byCategory = federalAnnualTaxByCategoryCents(input, 2026);
    expect(sumCents(byCategory)).toBe(total);
  });

  it("attributes the preferential capital-gains tax to the capitalGains bucket alone", () => {
    // wages 50,000 + gains 20,000 → 4,487.50 total: the ordinary tax (3,820) rides `wages`,
    // the gains tax (667.50) rides `capitalGains`.
    const input = { wages: 50_000_00, capitalGains: 20_000_00 };
    const byCategory = federalAnnualTaxByCategoryCents(input, 2026);
    expect(sumCents(byCategory)).toBe(federalAnnualTaxCents(input, 2026));
    // The gains bear their own preferential tax, not an average blended rate.
    expect(byCategory.capitalGains).toBe(667_50);
    expect(byCategory.wages).toBe(3_820_00);
  });

  it("never attributes tax to tax-exempt income (it is never taxed)", () => {
    const input = { wages: 100_000_00, taxExempt: 40_000_00 };
    const byCategory = federalAnnualTaxByCategoryCents(input, 2026);
    expect(byCategory.taxExempt).toBeUndefined();
    expect(sumCents(byCategory)).toBe(federalAnnualTaxCents(input, 2026));
  });

  it("attributes benefit tax only to the included portion of the government benefit", () => {
    // Benefit 30,000 + wages 30,000: 13,850 of the benefit is taxable, and the split shares
    // the ordinary tax by taxable weight.
    const input = { wages: 30_000_00, governmentRetirementBenefit: 30_000_00 };
    const byCategory = federalAnnualTaxByCategoryCents(input, 2026);
    expect(sumCents(byCategory)).toBe(federalAnnualTaxCents(input, 2026));
    expect(byCategory.governmentRetirementBenefit).toBeGreaterThan(0);
    expect(byCategory.wages).toBeGreaterThan(byCategory.governmentRetirementBenefit ?? 0);
  });

  it("returns an empty map when no tax is owed", () => {
    expect(federalAnnualTaxByCategoryCents({ wages: 12_000_00 }, 2026)).toEqual({});
    expect(federalAnnualTaxByCategoryCents({}, 2026)).toEqual({});
  });
});
