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
  projectScenario,
  realNetWorthSurvives,
  earliestPartialRetirementAge,
  earliestFullRetirementAge,
  evaluateAtAge,
  evaluateFullRetirementAtAge,
  solveRetirement,
} from "./retirementSolver";
import { scenarioOf } from "./scenario";
import type { ProjectionContext } from "./projectionBase";
import { mockJurisdiction } from "./testing/mockJurisdiction";
import { samplePlan, baristaPlan, SAMPLE_START_YEAR } from "./testing/samplePlan";
import type { Plan } from "./plan";

const START_YEAR = SAMPLE_START_YEAR;
const CTX: ProjectionContext = { jurisdiction: mockJurisdiction(), startYear: START_YEAR };

function survivesAt(budget: Plan, age: number): boolean {
  return realNetWorthSurvives(projectScenario(scenarioOf({ ...budget, retirementAge: age }), CTX));
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
    const age = earliestPartialRetirementAge(scenarioOf(samplePlan), CTX);
    expect(age).not.toBeNull();
    expect(survivesAt(samplePlan, age as number)).toBe(true);
    expect(survivesAt(samplePlan, (age as number) - 1)).toBe(false);
  });

  it("returns null when even working to life expectancy fails", () => {
    const broke: Plan = { ...samplePlan, openingBalanceCents: 0, incomeCents: 0 };
    expect(earliestPartialRetirementAge(scenarioOf(broke), CTX)).toBeNull();
  });

  it("counts a plan that goes insolvent (null net worth) as NOT surviving", () => {
    // Once insolvent, net worth is null (§5.1). `null >= 0` is `true` in JS, so a
    // naive survival check would wrongly pass those months — this pins the guard.
    const broke: Plan = { ...samplePlan, openingBalanceCents: 0, incomeCents: 0 };
    const series = projectScenario(scenarioOf(broke), CTX);
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
    const evaluation = evaluateAtAge(scenarioOf(samplePlan), samplePlan.lifeExpectancy, CTX);
    expect(evaluation.feasible).toBe(true);
    expect(evaluation.onTrackFraction).toBe(1);
  });

  it("is a fraction in (0,1) short of a barely-infeasible pinned age", () => {
    const floor = earliestPartialRetirementAge(scenarioOf(samplePlan), CTX) as number;
    const evaluation = evaluateAtAge(scenarioOf(samplePlan), floor - 1, CTX);
    expect(evaluation.feasible).toBe(false);
    expect(evaluation.onTrackFraction).toBeGreaterThan(0);
    expect(evaluation.onTrackFraction).toBeLessThan(1);
  });
});

describe("retirementSolver — partial vs full retirement (§5, issue #66)", () => {
  // The partial retirement solver varies the open-ended (null-end) jobs' ends and keeps
  // the authored fixed-term + passive income; full retirement ceases every job.
  it("full-retirement survival is monotonic in the cease-all-work age (later never hurts)", () => {
    let seenSurviving = false;
    for (let age = baristaPlan.currentAge; age <= baristaPlan.lifeExpectancy; age++) {
      const ok = evaluateFullRetirementAtAge(scenarioOf(baristaPlan), age, CTX).feasible;
      if (seenSurviving) expect(ok).toBe(true);
      if (ok) seenSurviving = true;
    }
    expect(seenSurviving).toBe(true);
  });

  it("the full-retirement binary search returns exactly the threshold age", () => {
    const scenario = scenarioOf(baristaPlan);
    const age = earliestFullRetirementAge(scenario, CTX);
    expect(age).not.toBeNull();
    expect(evaluateFullRetirementAtAge(scenario, age as number, CTX).feasible).toBe(true);
    expect(evaluateFullRetirementAtAge(scenario, (age as number) - 1, CTX).feasible).toBe(false);
  });

  // The acceptance heart (§5, AC5): a barista plan — the open-ended job ends at target,
  // the fixed-term job keeps paying — solves the two ages DISTINCTLY. Full retirement
  // (drop the barista too) is strictly later than partial retirement (keep the barista).
  it("a barista-retirement plan solves both ages distinctly (partial < full)", () => {
    const solution = solveRetirement(scenarioOf(baristaPlan), CTX);
    expect(solution.partialRetirementAge).not.toBeNull();
    expect(solution.fullRetirementAge).not.toBeNull();
    expect(solution.partialRetirementAge).toBeLessThan(solution.fullRetirementAge as number);
  });

  it("reports the latest-authored-work-stop age as the latest authored job end (§5)", () => {
    // max job endYear is the barista's (birthYear + 75) → age 75.
    const solution = solveRetirement(scenarioOf(baristaPlan), CTX);
    expect(solution.latestAuthoredWorkStopAge).toBe(75);
  });
});
