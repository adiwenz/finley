/**
 * Engine-native property tests for the retirement solver, run off the same projection the
 * net-worth graph draws. {@link samplePlan} and {@link mockJurisdiction} keep them
 * standalone, with no rules package. The app holds the real-jurisdiction acceptance tests
 * (panel age == first surviving projection age on the default plan under
 * `usJurisdiction`); these pin the solver's own behaviour.
 */
import { describe, it, expect } from "vitest";
import {
  projectScenario,
  projectFullRetirement,
  planSurvives,
  earliestPartialRetirementAge,
  earliestFullRetirementAge,
  evaluateAtAge,
  evaluateFullRetirementAtAge,
  solveRetirement,
} from "./retirementSolver";
import { scenarioOf, withLedger } from "./scenario";
import { addEvent } from "./ledger/addEvent";
import { emptyLedger } from "./ledger/ledger";
import { dollarsToCents } from "./cashFlowSeries";
import { createProjectionBase } from "./projectionBase";
import type { ProjectionContext } from "./projectionBase";
import { mockJurisdiction } from "./testing/mockJurisdiction";
import { samplePlan, baristaPlan, SAMPLE_START_YEAR } from "./testing/samplePlan";
import type { Plan } from "./plan";
import type { Person } from "./person";
import type { Scenario } from "./scenario";

const START_YEAR = SAMPLE_START_YEAR;
const CTX: ProjectionContext = { jurisdiction: mockJurisdiction(), startYear: START_YEAR };

function survivesAt(budget: Plan, age: number): boolean {
  return planSurvives(projectScenario(scenarioOf({ ...budget, retirementAge: age }), CTX));
}

describe("retirementSolver — survival off the real projection", () => {
  it("survival is monotonic in the retirement age (later never hurts)", () => {
    // Once an age survives, every later age must too — the property the binary search
    // relies on. Walk the range and assert survival never flips true→false.
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
    const broke: Plan = { ...samplePlan, openingBalanceCents: 0, jobs: [] };
    expect(earliestPartialRetirementAge(scenarioOf(broke), CTX)).toBeNull();
  });

  it("counts a solvent household that is merely underwater as surviving", () => {
    // A student loan (or new mortgage) puts net worth below zero for years while every
    // bill is paid — the "negative but improving" case. Judging survival on the net-worth
    // SIGN failed such a plan at month 0 and reported no feasible retirement age while the
    // graph beside it sailed to life expectancy. Survival is insolvency, not the sign.
    // Retiring at life expectancy makes the plan unambiguously funded, so the loan is the
    // only thing under test.
    const funded: Plan = { ...samplePlan, retirementAge: samplePlan.lifeExpectancy };
    const withLoan = addEvent(emptyLedger, createProjectionBase(funded, CTX), {
      id: "loan-1",
      type: "LoanEvent",
      month: 0,
      liabilityId: "loan-student",
      ownerId: "p1",
      openingBalanceCents: dollarsToCents(40_000),
      apr: 0.06,
      kind: "studentLoan",
      termMonths: 120,
    });
    if (!withLoan.ok) throw new Error(`fixture rejected: ${withLoan.conflict}`);
    const scenario = withLedger(scenarioOf(funded), withLoan.ledger);
    const series = projectScenario(scenario, CTX);
    // Precondition: really underwater early, and never insolvent.
    expect(series.months[0]!.netWorthRealCents).toBeLessThan(0);
    expect(series.months.some((m) => m.isInsolvent)).toBe(false);
    expect(planSurvives(series)).toBe(true);
  });

  it("counts a plan that goes insolvent (null net worth) as NOT surviving", () => {
    // Once insolvent, net worth is null — and `null >= 0` is `true` in JS, so a naive
    // survival check would pass those months. This pins the guard.
    const broke: Plan = { ...samplePlan, openingBalanceCents: 0, jobs: [] };
    const series = projectScenario(scenarioOf(broke), CTX);
    // Precondition: the plan really does produce null net-worth months.
    expect(series.months.some((m) => m.netWorthRealCents === null)).toBe(true);
    expect(planSurvives(series)).toBe(false);
  });
});

describe("retirementSolver — target mode", () => {
  // evaluateAtAge reports only at-that-age facts (feasible + on-track); nearestFeasibleAge
  // is composed by retirementView from the headline, covered there.
  it("is 100% and feasible at a comfortably-fundable pinned age", () => {
    // Life expectancy is the safest possible pin: feasible if any age is.
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

describe("retirementSolver — partial vs full retirement", () => {
  // Partial retirement varies the open-ended (null-end) jobs' ends and keeps the authored
  // fixed-term + passive income; full retirement ceases every job.
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

  // The acceptance heart: on a barista plan (open-ended job ends at target, fixed-term job
  // keeps paying) the two ages solve DISTINCTLY — dropping the barista too is strictly later
  // than keeping it. Partial is the standalone opt-in solve, not part of solveRetirement's
  // default result, so it is asked for directly here.
  it("a barista-retirement plan solves both ages distinctly (partial < full)", () => {
    const scenario = scenarioOf(baristaPlan);
    const partial = earliestPartialRetirementAge(scenario, CTX);
    const full = earliestFullRetirementAge(scenario, CTX);
    expect(partial).not.toBeNull();
    expect(full).not.toBeNull();
    expect(partial as number).toBeLessThan(full as number);
  });

  it("reports the latest-authored-work-stop age as the latest authored job end", () => {
    // max job endYear is the barista's (birthYear + 75) → age 75.
    const solution = solveRetirement(scenarioOf(baristaPlan), CTX);
    expect(solution.latestAuthoredWorkStopAge).toBe(75);
  });
});

describe("retirementSolver — the stop-working boundary reaches every earner", () => {
  // A partner's jobs live on the RelationshipEvent, not on the plan, so a solve that rewrote
  // only the plan's own job list never ceased them — the household kept one earner working
  // past the stop-working age and the retirement answer was wrong for every two-earner
  // household. Deriving each job's end at compile time from a single boundary fixes it.
  const partnerWithLateJob = (): Person => ({
    id: "p2",
    name: "Partner",
    // Same age as the primary (born SAMPLE_START_YEAR − 40), authored to work far past any
    // plausible full-stop age so their wage can only stop because the boundary stopped it.
    birthYear: START_YEAR - samplePlan.currentAge,
    retirementTargetAge: 80,
    benefitClaimingAge: 67,
    jobs: [
      {
        id: "pj1",
        ownerId: "p2",
        startYear: START_YEAR,
        endYear: null, // open-ended — ceases at the household stop-working boundary
        salary: {
          startingSalaryCents: dollarsToCents(24_000),
          currentSalaryCents: dollarsToCents(24_000),
          realGrowthPct: 0,
        },
      },
    ],
  });

  function twoEarnerScenario(): Scenario {
    const added = addEvent(emptyLedger, createProjectionBase(samplePlan, CTX), {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: partnerWithLateJob(),
    });
    if (!added.ok) throw new Error(`fixture rejected: ${added.conflict}`);
    return withLedger(scenarioOf(samplePlan), added.ledger);
  }

  it("a full stop ceases the partner's jobs too", () => {
    // Full stop at 50 → boundary calendar year birthYear + 50 = month (50 − 40) × 12 = 120.
    // Ten years later (month 240) neither earner draws a wage; the mock jurisdiction pays no
    // benefit, so any earned income here is a job the solve failed to stop.
    const series = projectFullRetirement(twoEarnerScenario(), 50, CTX);
    expect(series.months[240]?.flows?.totalIncomeCents).toBe(0);
  });

  it("a full solve never mutates a job — serialized state is identical before and after", () => {
    // The whole point of a boundary over a rewrite: the search runs a dozen candidate ages and
    // touches nothing. Snapshot the scenario, solve every entry point over it, and it must
    // round-trip unchanged — job dates, salaries and the ledger's partner jobs included.
    const scenario = twoEarnerScenario();
    const before = JSON.stringify(scenario);
    earliestFullRetirementAge(scenario, CTX);
    earliestPartialRetirementAge(scenario, CTX);
    evaluateFullRetirementAtAge(scenario, 55, CTX);
    evaluateAtAge(scenario, 55, CTX);
    solveRetirement(scenario, CTX);
    expect(JSON.stringify(scenario)).toBe(before);
  });
});
