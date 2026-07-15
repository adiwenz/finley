import { describe, it, expect } from "vitest";
import type { HealthCostContext } from "@finley/engine";
import {
  healthCostBenchmark,
  healthCostBenchmarkMonthlyCents,
  HEALTH_COST_BASE_YEAR,
  MEDICARE_ELIGIBILITY_AGE,
} from "./healthCosts";

function ctx(age: number, year: number): HealthCostContext {
  return { age, year };
}

describe("healthCostBenchmark — US attributed health costs (§5.4)", () => {
  it("cent-pinned base year: pre-65 $1,200/mo, Medicare residual $500/mo", () => {
    const b = healthCostBenchmark(HEALTH_COST_BASE_YEAR);
    expect(b.pre65SelfFundedMonthlyCents).toBe(1_200_00);
    expect(b.medicareResidualMonthlyCents).toBe(500_00);
  });

  it("pre-65 cost always exceeds the Medicare residual (the step is downward)", () => {
    for (let year = HEALTH_COST_BASE_YEAR; year <= HEALTH_COST_BASE_YEAR + 40; year++) {
      const b = healthCostBenchmark(year);
      expect(b.pre65SelfFundedMonthlyCents).toBeGreaterThan(b.medicareResidualMonthlyCents);
    }
  });

  it("holds flat at/before the base year — no backward indexing", () => {
    const prior = healthCostBenchmark(HEALTH_COST_BASE_YEAR - 5);
    expect(prior.pre65SelfFundedMonthlyCents).toBe(1_200_00);
    expect(prior.medicareResidualMonthlyCents).toBe(500_00);
  });

  it("indexes forward: both figures are non-decreasing and rise over time", () => {
    let prevPre = -1;
    let prevResidual = -1;
    for (let year = HEALTH_COST_BASE_YEAR; year <= HEALTH_COST_BASE_YEAR + 40; year++) {
      const b = healthCostBenchmark(year);
      expect(b.pre65SelfFundedMonthlyCents).toBeGreaterThanOrEqual(prevPre);
      expect(b.medicareResidualMonthlyCents).toBeGreaterThanOrEqual(prevResidual);
      prevPre = b.pre65SelfFundedMonthlyCents;
      prevResidual = b.medicareResidualMonthlyCents;
    }
    // Over four decades of medical inflation, both have grown.
    const future = healthCostBenchmark(HEALTH_COST_BASE_YEAR + 40);
    expect(future.pre65SelfFundedMonthlyCents).toBeGreaterThan(1_200_00);
    expect(future.medicareResidualMonthlyCents).toBeGreaterThan(500_00);
  });
});

describe("healthCostBenchmarkMonthlyCents — the seam (§5.4)", () => {
  it("returns the elevated self-funded figure just below the Medicare age", () => {
    expect(healthCostBenchmarkMonthlyCents(ctx(MEDICARE_ELIGIBILITY_AGE - 1, HEALTH_COST_BASE_YEAR)))
      .toBe(1_200_00);
  });

  it("steps down to the residual at the Medicare age", () => {
    expect(healthCostBenchmarkMonthlyCents(ctx(MEDICARE_ELIGIBILITY_AGE, HEALTH_COST_BASE_YEAR)))
      .toBe(500_00);
  });

  it("stays at the residual above the Medicare age", () => {
    expect(healthCostBenchmarkMonthlyCents(ctx(80, HEALTH_COST_BASE_YEAR))).toBe(500_00);
  });

  it("is monotonic non-decreasing in age at a fixed year (a single downward step at 65)", () => {
    let prev = healthCostBenchmarkMonthlyCents(ctx(40, HEALTH_COST_BASE_YEAR));
    let steps = 0;
    for (let age = 41; age <= 90; age++) {
      const cost = healthCostBenchmarkMonthlyCents(ctx(age, HEALTH_COST_BASE_YEAR));
      if (cost < prev) steps++;
      prev = cost;
    }
    expect(steps).toBe(1); // exactly one step down across the whole age range
  });
});
