import { describe, it, expect } from "vitest";
import type { WithdrawalTaxBasis } from "@finley/engine";
import { taxableWithdrawalCents, returnTaxTreatment } from "./investmentTax";

/** A withdrawal-basis snapshot in whole dollars, for readability. */
function draw(grossDollars: number, basisDollars: number, balanceDollars: number): WithdrawalTaxBasis {
  return {
    grossCents: grossDollars * 100,
    basisCents: basisDollars * 100,
    balanceCents: balanceDollars * 100,
    category: "capitalGains",
  };
}

describe("taxableWithdrawalCents — US pro-rata return of capital (§5.3, #94)", () => {
  it("taxes $0 when the draw is all principal (basis == balance)", () => {
    // $2k out of a $100k account whose basis is the full $100k → every dollar is
    // returned principal, nothing is gain.
    expect(taxableWithdrawalCents(draw(2_000, 100_000, 100_000))).toBe(0);
  });

  it("taxes only the gain fraction of a partially appreciated account", () => {
    // $100k balance on $60k basis → 40% of any draw is gain. A $10k draw books $4k.
    expect(taxableWithdrawalCents(draw(10_000, 60_000, 100_000))).toBe(4_000_00);
  });

  it("taxes the whole draw when there is no basis (a pre-tax account)", () => {
    // basis 0 → the entire draw is gain, fully taxable — the pre-tax behavior.
    expect(taxableWithdrawalCents(draw(2_000, 0, 100_000))).toBe(2_000_00);
  });

  it("is monotone non-decreasing in the gross (the gross-up loop depends on it)", () => {
    let prev = -1;
    for (let g = 0; g <= 50_000; g += 2_500) {
      const taxable = taxableWithdrawalCents(draw(g, 40_000, 100_000));
      expect(taxable).toBeGreaterThanOrEqual(prev);
      prev = taxable;
    }
  });

  it("returns the gross for a degenerate zero balance (no divide-by-zero)", () => {
    expect(taxableWithdrawalCents(draw(1_000, 500, 0))).toBe(1_000_00);
  });
});

describe("returnTaxTreatment — US accrual-vs-realization (§5.3, #94)", () => {
  it("taxes interest at accrual as ordinary income", () => {
    expect(returnTaxTreatment("interest")).toEqual({ taxAtAccrual: true, category: "ordinaryIncome" });
  });

  it("defers appreciation to withdrawal (taxed there against basis)", () => {
    expect(returnTaxTreatment("appreciation")).toEqual({ taxAtAccrual: false, category: "capitalGains" });
  });
});
