import { describe, it, expect } from "vitest";
import { requiredContributionCents } from "./sinkingFund";
import { dollarsToCents } from "./cashFlowSeries";

describe("requiredContributionCents (§14/§19, #26 sinking-fund pace)", () => {
  it("zero-rate: spreads the remaining gap evenly over the months left", () => {
    // $12,000 target, nothing saved, 12 months, no growth → $1,000/mo.
    expect(requiredContributionCents(dollarsToCents(12000), 0, 12, 0)).toBe(dollarsToCents(1000));
  });

  it("zero-rate: nets the current balance out of the gap before spreading", () => {
    // $12,000 target, $6,000 already saved, 6 months, no growth → $1,000/mo.
    expect(requiredContributionCents(dollarsToCents(12000), dollarsToCents(6000), 6, 0)).toBe(
      dollarsToCents(1000),
    );
  });

  it("near-deadline (monthsRemaining ≤ 1): funds the entire remaining gap this month", () => {
    // One month left → no time to spread; contribute the whole gap now.
    expect(requiredContributionCents(dollarsToCents(5000), dollarsToCents(2000), 1, 0.005)).toBe(
      dollarsToCents(3000),
    );
    // At/​past the deadline behaves the same — the gap is due immediately.
    expect(requiredContributionCents(dollarsToCents(5000), dollarsToCents(2000), 0, 0.005)).toBe(
      dollarsToCents(3000),
    );
  });

  it("growth-aware: a positive rate lowers the required contribution below the flat spread", () => {
    const target = dollarsToCents(12000);
    const flat = requiredContributionCents(target, 0, 12, 0);
    const withGrowth = requiredContributionCents(target, 0, 12, 0.01);
    expect(withGrowth).toBeLessThan(flat);
    // Sinking-fund identity: contributing `c` for 12 months at 1%/mo must accumulate
    // to (approximately) the target, so verify the annuity future value lands on it.
    const r = 0.01;
    const fv = (withGrowth * (Math.pow(1 + r, 12) - 1)) / r;
    expect(Math.round(fv)).toBeCloseTo(target, -2);
  });

  it("already funded to (or beyond) target needs nothing", () => {
    expect(requiredContributionCents(dollarsToCents(5000), dollarsToCents(5000), 10, 0)).toBe(0);
    expect(requiredContributionCents(dollarsToCents(5000), dollarsToCents(6000), 10, 0.01)).toBe(0);
  });

  it("growth alone can reach the target — an existing balance that compounds past it needs nothing", () => {
    // $10k at 1%/mo for 24 months already exceeds a $12k target with no contributions.
    expect(requiredContributionCents(dollarsToCents(12000), dollarsToCents(10000), 24, 0.01)).toBe(0);
  });
});
