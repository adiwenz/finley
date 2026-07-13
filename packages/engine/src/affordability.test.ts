/**
 * affordability.ts — the §4.5 soft-warning arithmetic (debt-to-income) and the
 * mortgage payment a purchase implies. Pure functions: no ledger, no projection.
 */

import { describe, it, expect } from "vitest";
import {
  assessDti,
  mortgagePaymentForPurchaseCents,
  DTI_FRONT_END_THRESHOLD,
} from "./index";

const PRICE = 30_000_000; // $300k
const DOWN = 6_000_000; // $60k
const FINANCED = PRICE - DOWN; // $240k

describe("assessDti (§4.5 soft warning)", () => {
  it("flags when housing exceeds the 28% front-end guideline", () => {
    const a = assessDti(1_000_000, 300_000, 300_000); // 30% housing
    expect(a.frontEndRatio).toBeCloseTo(0.3);
    expect(a.frontEndExceeded).toBe(true);
    expect(a.backEndExceeded).toBe(false);
  });

  it("flags when total debt exceeds the 36% back-end guideline", () => {
    const a = assessDti(1_000_000, 250_000, 380_000); // 25% housing, 38% total
    expect(a.frontEndExceeded).toBe(false);
    expect(a.backEndExceeded).toBe(true);
  });

  it("does not flag a comfortable ratio, and never divides by zero", () => {
    expect(assessDti(1_000_000, 250_000, 300_000).frontEndExceeded).toBe(false);
    const zero = assessDti(0, 300_000, 300_000);
    expect(zero.frontEndRatio).toBe(0);
    expect(zero.frontEndExceeded).toBe(false);
  });

  it("threshold constant is the documented 28%", () => {
    expect(DTI_FRONT_END_THRESHOLD).toBe(0.28);
  });
});

describe("mortgagePaymentForPurchaseCents", () => {
  it("computes the mortgage payment for a purchase (financed / term at 0% APR)", () => {
    expect(mortgagePaymentForPurchaseCents(PRICE, DOWN, 0, 360)).toBe(Math.ceil(FINANCED / 360));
  });
});
