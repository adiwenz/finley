import { describe, it, expect } from "vitest";
import type { WithdrawalContext, WithdrawalTaxBasis } from "@finley/engine";
import { earlyWithdrawalPenaltyCents } from "./earlyWithdrawalPenalty";

/** A withdrawal-basis snapshot in whole dollars, for readability. */
function draw(grossDollars: number, basisDollars: number, balanceDollars: number, category: WithdrawalTaxBasis["category"] = "ordinaryIncome"): WithdrawalTaxBasis {
  return {
    grossCents: grossDollars * 100,
    basisCents: basisDollars * 100,
    balanceCents: balanceDollars * 100,
    category,
  };
}

function ctx(age: number): WithdrawalContext {
  return { year: 2026, age };
}

describe("earlyWithdrawalPenaltyCents — US IRC §72(t) flat 10%", () => {
  it("charges 10% of the taxable amount for a pre-tax draw well before 59½", () => {
    expect(earlyWithdrawalPenaltyCents(draw(10_000, 0, 100_000), ctx(35))).toBe(1_000_00);
  });

  it("charges nothing at exactly 59½", () => {
    expect(earlyWithdrawalPenaltyCents(draw(10_000, 0, 100_000), ctx(59.5))).toBe(0);
  });

  it("still charges the full penalty for the whole calendar year the holder turns 59 — the model's whole-year age can't see the half-birthday", () => {
    expect(earlyWithdrawalPenaltyCents(draw(10_000, 0, 100_000), ctx(59))).toBe(1_000_00);
  });

  it("charges nothing at 60 and beyond", () => {
    expect(earlyWithdrawalPenaltyCents(draw(10_000, 0, 100_000), ctx(60))).toBe(0);
    expect(earlyWithdrawalPenaltyCents(draw(10_000, 0, 100_000), ctx(80))).toBe(0);
  });

  it("charges nothing on a non-pre-tax withdrawal category, whatever the age", () => {
    expect(earlyWithdrawalPenaltyCents(draw(10_000, 0, 100_000, "capitalGains"), ctx(35))).toBe(0);
    expect(earlyWithdrawalPenaltyCents(draw(10_000, 0, 100_000, "taxExempt"), ctx(35))).toBe(0);
    expect(earlyWithdrawalPenaltyCents(draw(10_000, 0, 100_000, "taxedAtAccrual"), ctx(35))).toBe(0);
  });

  it("prices the TAXABLE amount, not the gross, when a pre-tax draw somehow carries basis", () => {
    // Pre-tax accounts have no recorded basis in practice, but the seam is defined off the
    // same taxable-amount rule ordinary income tax uses, so a nonzero basis still halves it.
    expect(earlyWithdrawalPenaltyCents(draw(10_000, 50_000, 100_000), ctx(35))).toBe(500_00);
  });
});
