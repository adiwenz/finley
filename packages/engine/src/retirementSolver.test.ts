/**
 * Engine-native property tests for the retirement solver (§7), run off the same real
 * projection the net-worth graph draws (#37). Driven by the purpose-built
 * {@link samplePlan} fixture and {@link mockJurisdiction} so they run standalone
 * against the engine with no rules package. The app keeps the #37 real-jurisdiction
 * acceptance tests (panel age == first surviving projection age on the default plan
 * under `usJurisdiction`); these pin the solver's behaviour itself.
 */
import { describe, it, expect } from "vitest";
import {
  projectPlan,
  realNetWorthSurvives,
  earliestFeasibleRetirementAge,
  earliestCareerExitAge,
  earliestWorkOptionalAge,
  evaluateAtAge,
  evaluateWorkOptionalAtAge,
  solveRetirement,
} from "./retirementSolver";
import type { ProjectionContext } from "./projectionBase";
import { mockJurisdiction } from "./testing/mockJurisdiction";
import { samplePlan, baristaPlan, SAMPLE_START_YEAR } from "./testing/samplePlan";
import type { Plan } from "./plan";

const START_YEAR = SAMPLE_START_YEAR;
const CTX: ProjectionContext = { jurisdiction: mockJurisdiction(), startYear: START_YEAR };

function survivesAt(budget: Plan, age: number): boolean {
  return realNetWorthSurvives(projectPlan({ ...budget, retirementAge: age }, CTX));
}

describe("retirementSolver — survival off the real projection (#37)", () => {
  it("survival is monotonic in the retirement age (later never hurts)", () => {
    // Once an age survives, every later age must too — the property the binary search
    // relies on. Walk the whole range and assert survival never flips true→false.
    let seenSurviving = false;
    for (let age = samplePlan.currentAge; age <= samplePlan.lifeExpectancy; age++) {
      const ok = survivesAt(samplePlan, age);
      if (seenSurviving) expect(ok).toBe(true);
      if (ok) seenSurviving = true;
    }
    expect(seenSurviving).toBe(true);
  });

  it("the binary search returns exactly the threshold age", () => {
    const age = earliestFeasibleRetirementAge(samplePlan, CTX);
    expect(age).not.toBeNull();
    expect(survivesAt(samplePlan, age as number)).toBe(true);
    expect(survivesAt(samplePlan, (age as number) - 1)).toBe(false);
  });

  it("returns null when even working to life expectancy fails", () => {
    const broke: Plan = { ...samplePlan, openingBalanceCents: 0, incomeCents: 0 };
    expect(earliestFeasibleRetirementAge(broke, CTX)).toBeNull();
  });

  it("counts a plan that goes insolvent (null net worth) as NOT surviving", () => {
    // Once insolvent, net worth is null (§5.1). `null >= 0` is `true` in JS, so a
    // naive survival check would wrongly pass those months — this pins the guard.
    const broke: Plan = { ...samplePlan, openingBalanceCents: 0, incomeCents: 0 };
    const series = projectPlan(broke, CTX);
    // Precondition: the plan really does produce null net-worth months.
    expect(series.months.some((m) => m.netWorthRealCents === null)).toBe(true);
    expect(realNetWorthSurvives(series)).toBe(false);
  });
});

describe("retirementSolver — target mode (§7.1)", () => {
  // evaluateAtAge reports only the at-that-age facts (feasible + on-track);
  // nearestFeasibleAge is composed by retirementView from the headline (covered there).
  it("is 100% and feasible at a comfortably-fundable pinned age", () => {
    // Work to life expectancy: the safest possible pin, always feasible if any age is.
    const evaluation = evaluateAtAge(samplePlan, samplePlan.lifeExpectancy, CTX);
    expect(evaluation.feasible).toBe(true);
    expect(evaluation.onTrackFraction).toBe(1);
  });

  it("is a fraction in (0,1) short of a barely-infeasible pinned age", () => {
    const floor = earliestFeasibleRetirementAge(samplePlan, CTX) as number;
    const evaluation = evaluateAtAge(samplePlan, floor - 1, CTX);
    expect(evaluation.feasible).toBe(false);
    expect(evaluation.onTrackFraction).toBeGreaterThan(0);
    expect(evaluation.onTrackFraction).toBeLessThan(1);
  });
});

describe("retirementSolver — career-exit vs work-optional (§5, issue #66)", () => {
  // The career-exit solver is the headline solver under its §5 name: it varies the
  // career (null-end) job's end and keeps the authored supplemental + passive income.
  it("career-exit is the same search as the headline feasibility solver", () => {
    expect(earliestCareerExitAge(baristaPlan, CTX)).toBe(
      earliestFeasibleRetirementAge(baristaPlan, CTX),
    );
  });

  it("work-optional survival is monotonic in the cease-all-work age (later never hurts)", () => {
    let seenSurviving = false;
    for (let age = baristaPlan.currentAge; age <= baristaPlan.lifeExpectancy; age++) {
      const ok = evaluateWorkOptionalAtAge(baristaPlan, age, CTX).feasible;
      if (seenSurviving) expect(ok).toBe(true);
      if (ok) seenSurviving = true;
    }
    expect(seenSurviving).toBe(true);
  });

  it("the work-optional binary search returns exactly the threshold age", () => {
    const age = earliestWorkOptionalAge(baristaPlan, CTX);
    expect(age).not.toBeNull();
    expect(evaluateWorkOptionalAtAge(baristaPlan, age as number, CTX).feasible).toBe(true);
    expect(evaluateWorkOptionalAtAge(baristaPlan, (age as number) - 1, CTX).feasible).toBe(false);
  });

  // The acceptance heart (§5, AC5): a barista plan — career job ends at target, the
  // supplemental job keeps paying — solves the two ages DISTINCTLY. Work-optional
  // (drop the barista too) is strictly later than career-exit (keep the barista).
  it("a barista-retirement plan solves both ages distinctly (career-exit < work-optional)", () => {
    const solution = solveRetirement(baristaPlan, CTX);
    expect(solution.careerExitAge).not.toBeNull();
    expect(solution.workOptionalAge).not.toBeNull();
    expect(solution.careerExitAge).toBeLessThan(solution.workOptionalAge as number);
  });

  it("reports the full-work-stop target as the latest authored job end (§5)", () => {
    // max job endYear is the barista's (birthYear + 75) → age 75.
    const solution = solveRetirement(baristaPlan, CTX);
    expect(solution.fullWorkStopTargetAge).toBe(75);
  });
});
