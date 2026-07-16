import { describe, it, expect } from "vitest";
import {
  projectPlan,
  realNetWorthSurvives,
  earliestFeasibleRetirementAge,
  evaluateAtAge,
} from "./retirementSolver";
import { PLAN_DEFAULTS } from "./planDefaults";
import type { BudgetValues } from "./planTypes";

function survivesAt(budget: BudgetValues, age: number): boolean {
  return realNetWorthSurvives(projectPlan({ ...budget, retirementAge: age }));
}

describe("retirementSolver — survival off the real projection (#37)", () => {
  it("survival is monotonic in the retirement age (later never hurts)", () => {
    // Once an age survives, every later age must too — the property the binary search
    // relies on. Walk the whole range and assert survival never flips true→false.
    let seenSurviving = false;
    for (let age = PLAN_DEFAULTS.currentAge; age <= PLAN_DEFAULTS.lifeExpectancy; age++) {
      const ok = survivesAt(PLAN_DEFAULTS, age);
      if (seenSurviving) expect(ok).toBe(true);
      if (ok) seenSurviving = true;
    }
    expect(seenSurviving).toBe(true);
  });

  it("the binary search returns exactly the threshold age", () => {
    const age = earliestFeasibleRetirementAge(PLAN_DEFAULTS);
    expect(age).not.toBeNull();
    expect(survivesAt(PLAN_DEFAULTS, age as number)).toBe(true);
    expect(survivesAt(PLAN_DEFAULTS, (age as number) - 1)).toBe(false);
  });

  it("returns null when even working to life expectancy fails", () => {
    const broke: BudgetValues = { ...PLAN_DEFAULTS, openingBalanceCents: 0, incomeCents: 0 };
    expect(earliestFeasibleRetirementAge(broke)).toBeNull();
  });

  it("counts a plan that goes insolvent (null net worth) as NOT surviving", () => {
    // Once insolvent, net worth is null (§5.1). `null >= 0` is `true` in JS, so a
    // naive survival check would wrongly pass those months — this pins the guard.
    const broke: BudgetValues = { ...PLAN_DEFAULTS, openingBalanceCents: 0, incomeCents: 0 };
    const series = projectPlan(broke);
    // Precondition: the plan really does produce null net-worth months.
    expect(series.months.some((m) => m.netWorthRealCents === null)).toBe(true);
    expect(realNetWorthSurvives(series)).toBe(false);
  });
});

describe("retirementSolver — target mode (§7.1)", () => {
  // evaluateAtAge reports only the at-that-age facts (feasible + on-track);
  // nearestFeasibleAge is composed by retirementView from the headline (covered there).
  it("is 100% and feasible at a comfortably-fundable pinned age", () => {
    const evaluation = evaluateAtAge(PLAN_DEFAULTS, 70);
    expect(evaluation.feasible).toBe(true);
    expect(evaluation.onTrackFraction).toBe(1);
  });

  it("is a fraction in (0,1) short of a barely-infeasible pinned age", () => {
    const floor = earliestFeasibleRetirementAge(PLAN_DEFAULTS) as number;
    const evaluation = evaluateAtAge(PLAN_DEFAULTS, floor - 1);
    expect(evaluation.feasible).toBe(false);
    expect(evaluation.onTrackFraction).toBeGreaterThan(0);
    expect(evaluation.onTrackFraction).toBeLessThan(1);
  });
});
