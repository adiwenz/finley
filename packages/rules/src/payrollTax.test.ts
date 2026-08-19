import { describe, it, expect } from "vitest";
import {
  PAYROLL_TAX_BASE_YEAR,
  payrollTaxTables,
  payrollWithholdingParts,
  payrollWithholdingCents,
  payrollTaxReconciliationCents,
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
    const p = payrollWithholdingParts(60_000_00, PAYROLL_TAX_BASE_YEAR);
    expect(p.oasdiCents).toBe(3_720_00); // 6.2% × 60,000
    expect(p.medicareCents).toBe(870_00); // 1.45% × 60,000
    expect(p.additionalMedicareCents).toBe(0);
    expect(p.totalCents).toBe(4_590_00);
    expect(payrollWithholdingCents(60_000_00, PAYROLL_TAX_BASE_YEAR)).toBe(4_590_00);
  });

  it("caps OASDI at the wage base while Medicare keeps running above it", () => {
    // $250k earned in 2026: OASDI stops at $184,500, Medicare on all $250k, surtax on $50k.
    const p = payrollWithholdingParts(250_000_00, PAYROLL_TAX_BASE_YEAR);
    expect(p.oasdiCents).toBe(Math.round(184_500_00 * 0.062)); // 11,439
    expect(p.medicareCents).toBe(Math.round(250_000_00 * 0.0145)); // 3,625
    // 0.9% on the $50k above the $200k statutory threshold.
    expect(p.additionalMedicareCents).toBe(Math.round(50_000_00 * 0.009)); // 450
    expect(p.totalCents).toBe(p.oasdiCents + p.medicareCents + p.additionalMedicareCents);
  });

  it("applies the surtax only to earned income strictly above the threshold", () => {
    expect(payrollWithholdingParts(200_000_00, PAYROLL_TAX_BASE_YEAR).additionalMedicareCents).toBe(0);
    expect(payrollWithholdingParts(200_100_00, PAYROLL_TAX_BASE_YEAR).additionalMedicareCents).toBe(
      Math.round(100_00 * 0.009),
    );
  });

  it("charges nothing on zero earned income", () => {
    const p = payrollWithholdingParts(0, PAYROLL_TAX_BASE_YEAR);
    expect(p.totalCents).toBe(0);
  });

  it("clamps negative earned income to zero — payroll tax is never a credit", () => {
    // Malformed input must not hand back a negative charge that would offset other tax.
    const p = payrollWithholdingParts(-50_000_00, PAYROLL_TAX_BASE_YEAR);
    expect(p.oasdiCents).toBe(0);
    expect(p.medicareCents).toBe(0);
    expect(p.additionalMedicareCents).toBe(0);
    expect(p.totalCents).toBe(0);
    expect(payrollWithholdingCents(-50_000_00, PAYROLL_TAX_BASE_YEAR)).toBe(0);
  });

  it("OASDI on a high earner falls in a later year as the wage base indexes up", () => {
    // Same $300k earner: a higher indexed cap means more of it bears the 6.2%, so the
    // OASDI piece RISES — the anti-drift behaviour the CPI proxy would have suppressed.
    const early = payrollWithholdingParts(300_000_00, PAYROLL_TAX_BASE_YEAR);
    const late = payrollWithholdingParts(300_000_00, PAYROLL_TAX_BASE_YEAR + 15);
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

describe("payrollWithholdingParts — the wage base binds on ONE employer's cumulative wages", () => {
  const t = payrollTaxTables(PAYROLL_TAX_BASE_YEAR);
  const oasdiAt = (wagesCents: number): number =>
    payrollWithholdingParts(wagesCents, PAYROLL_TAX_BASE_YEAR).oasdiCents;

  it("charges Social Security in full immediately BELOW the wage base", () => {
    const justUnder = t.oasdiWageBaseCents - 1_000_00;
    expect(oasdiAt(justUnder)).toBe(Math.round(justUnder * t.oasdiRate));
  });

  it("charges the whole base AT the wage base, and not a cent more above it", () => {
    const atCap = Math.round(t.oasdiWageBaseCents * t.oasdiRate);
    expect(oasdiAt(t.oasdiWageBaseCents)).toBe(atCap);
    expect(oasdiAt(t.oasdiWageBaseCents + 1_000_00)).toBe(atCap);
    expect(oasdiAt(t.oasdiWageBaseCents * 3)).toBe(atCap);
  });

  it("keeps charging Medicare after Social Security has stopped — it is uncapped", () => {
    const above = t.oasdiWageBaseCents + 50_000_00;
    const below = payrollWithholdingParts(t.oasdiWageBaseCents, PAYROLL_TAX_BASE_YEAR);
    const beyond = payrollWithholdingParts(above, PAYROLL_TAX_BASE_YEAR);
    expect(beyond.oasdiCents).toBe(below.oasdiCents);
    expect(beyond.medicareCents).toBe(Math.round(above * t.medicareRate));
    expect(beyond.medicareCents).toBeGreaterThan(below.medicareCents);
  });

  it("starts the 0.9% Additional Medicare surtax only ABOVE the threshold, on the excess alone", () => {
    const threshold = t.additionalMedicareThresholdCents;
    expect(payrollWithholdingParts(threshold, PAYROLL_TAX_BASE_YEAR).additionalMedicareCents).toBe(0);
    expect(
      payrollWithholdingParts(threshold + 10_000_00, PAYROLL_TAX_BASE_YEAR).additionalMedicareCents,
    ).toBe(Math.round(10_000_00 * t.additionalMedicareRate));
  });

  it("never decreases as cumulative wages grow, so a month's charge is never a credit", () => {
    let previous = 0;
    for (let wages = 0; wages <= 400_000_00; wages += 10_000_00) {
      const total = payrollWithholdingCents(wages, PAYROLL_TAX_BASE_YEAR);
      expect(total).toBeGreaterThanOrEqual(previous);
      previous = total;
    }
  });
});

describe("payrollTaxReconciliationCents — what the RETURN squares up", () => {
  const YEAR = PAYROLL_TAX_BASE_YEAR;
  const t = payrollTaxTables(YEAR);

  it("reconciles a single-employer year to exactly nothing, at every wage level", () => {
    // One employer applies both the wage base and the surtax threshold to the only wages there
    // are, so there is nothing left for the return to correct. Anything but zero here would move
    // cash the tax law does not move.
    for (const wages of [0, 50_000_00, t.oasdiWageBaseCents, 300_000_00, 2_000_000_00]) {
      expect(payrollTaxReconciliationCents([wages], YEAR)).toBe(0);
    }
  });

  it("refunds the excess Social Security two employers each withheld up to the base", () => {
    // Two jobs at $150,000 each: both under the base alone, so each withholds 6.2% of its own
    // wages — $300,000 taxed against a base that stops at $184,500. The overpayment is a credit.
    const wages = 150_000_00;
    const withheld = 2 * Math.round(wages * t.oasdiRate);
    const owed = Math.round(t.oasdiWageBaseCents * t.oasdiRate);
    // The surtax is owed on the combined $300,000 but neither employer withheld any of it.
    const surtaxOwed = Math.round((2 * wages - t.additionalMedicareThresholdCents) * t.additionalMedicareRate);
    expect(payrollTaxReconciliationCents([wages, wages], YEAR)).toBe(surtaxOwed - (withheld - owed));
  });

  it("bills the Additional Medicare surtax owed on combined wages that no single employer saw", () => {
    // Two jobs at $120,000: each is under the $200,000 threshold, so neither withholds a cent of
    // surtax, yet $240,000 combined owes it on $40,000. Positive — money due in April.
    const reconciliation = payrollTaxReconciliationCents([120_000_00, 120_000_00], YEAR);
    const surtaxOwed = Math.round(40_000_00 * t.additionalMedicareRate);
    const excessOasdi =
      2 * Math.round(120_000_00 * t.oasdiRate) - Math.round(t.oasdiWageBaseCents * t.oasdiRate);
    expect(reconciliation).toBe(surtaxOwed - excessOasdi);
    expect(surtaxOwed).toBeGreaterThan(0);
  });

  it("never bills back Social Security an employer under-withheld — the credit is one-directional", () => {
    // Two tiny jobs: nothing was over-withheld and nothing is owed, so nothing moves.
    expect(payrollTaxReconciliationCents([10_000_00, 10_000_00], YEAR)).toBe(0);
  });

  it("reconciles a mid-year job CHANGE the same way as two concurrent jobs — it cannot tell them apart", () => {
    // Six months at $130,000/yr then six at $130,000/yr elsewhere is $65,000 from each employer;
    // both under the base, so nothing is over-withheld and nothing is owed.
    expect(payrollTaxReconciliationCents([65_000_00, 65_000_00], YEAR)).toBe(0);
  });
});
