import { describe, it, expect } from "vitest";
import { assessEarlyRetireeHealthCost } from "./earlyRetireeHealthCheck";

/** A check with sensible defaults (US Medicare age 65, $1,200 benchmark), overridable. */
function check(overrides: Partial<Parameters<typeof assessEarlyRetireeHealthCost>[0]> = {}) {
  return assessEarlyRetireeHealthCost({
    retirementAge: 55,
    publicHealthCoverageAge: 65,
    authoredHealthMonthlyCents: 0,
    selfFundedBenchmarkMonthlyCents: 1_200_00,
    ...overrides,
  });
}

describe("assessEarlyRetireeHealthCost — pre-65 health-cost honesty flag (§5.4)", () => {
  it("flags an early retiree with no elevated health cost", () => {
    const flag = check({ retirementAge: 55, authoredHealthMonthlyCents: 0 });
    expect(flag.flagged).toBe(true);
    expect(flag.gapYears).toBe(10);
    expect(flag.shortfallMonthlyCents).toBe(1_200_00);
  });

  it("flags when the authored cost is below the benchmark, with the exact shortfall", () => {
    const flag = check({ authoredHealthMonthlyCents: 500_00 });
    expect(flag.flagged).toBe(true);
    expect(flag.shortfallMonthlyCents).toBe(700_00);
  });

  it("does NOT flag when the authored cost already meets the benchmark", () => {
    const flag = check({ authoredHealthMonthlyCents: 1_200_00 });
    expect(flag.flagged).toBe(false);
    expect(flag.gapYears).toBe(10);
    expect(flag.shortfallMonthlyCents).toBe(0);
  });

  it("does NOT flag an over-budgeted plan (no negative shortfall)", () => {
    const flag = check({ authoredHealthMonthlyCents: 1_500_00 });
    expect(flag.flagged).toBe(false);
    expect(flag.shortfallMonthlyCents).toBe(0);
  });

  it("does NOT flag retirement at the Medicare age (no self-funded gap)", () => {
    const flag = check({ retirementAge: 65, authoredHealthMonthlyCents: 0 });
    expect(flag.flagged).toBe(false);
    expect(flag.gapYears).toBe(0);
  });

  it("does NOT flag retirement after the Medicare age (gap clamps to 0)", () => {
    const flag = check({ retirementAge: 70, authoredHealthMonthlyCents: 0 });
    expect(flag.flagged).toBe(false);
    expect(flag.gapYears).toBe(0);
  });

  it("still reports the gap window even when not flagged", () => {
    const flag = check({ retirementAge: 60, authoredHealthMonthlyCents: 1_200_00 });
    expect(flag.gapYears).toBe(5);
    expect(flag.flagged).toBe(false);
  });
});
