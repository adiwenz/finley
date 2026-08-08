/**
 * **Does this plan survive if the household stops working at age X, and what is the earliest X
 * that does?** — the solver's core answer, run off the same projection the net-worth graph draws.
 *
 * {@link samplePlan} and {@link mockJurisdiction} keep these standalone, with no rules package.
 * The app holds the real-jurisdiction acceptance tests (panel age == first surviving projection
 * age on the default plan under `usJurisdiction`); these pin the search itself: monotonicity, the
 * exact threshold the binary search returns, the third state a blocked projection is, and the
 * single-age verdict the other two are built from.
 *
 * Continuation, truncation, membership and disclosure each have their own suite beside this one —
 * see `ls packages/engine/src/retirement/`.
 */
import { describe, it, expect } from "vitest";
import {
  projectScenario,
  projectFullRetirement,
  planSurvives,
  earliestFullRetirementAge,
  evaluateFullRetirementAtAge,
  solveRetirement,
} from "./retirementSolver";
import { scenarioOf, withLedger } from "../plan/scenario";
import { addEvent } from "../ledger/addEvent";
import { emptyLedger } from "../ledger/ledger";
import { dollarsToCents } from "../money/cashFlowSeries";
import { createProjectionBase, SAVINGS_ID } from "../compile/projectionBase";
import type { ProjectionMonth, ProjectionSeries } from "../projection/simulate";
import {
  samplePlan,
  baristaPlan,
  salariedJob,
  SAMPLE_START_YEAR,
  SAMPLE_JOB_END_AGE,
  spendLine,
  healthLine,
} from "../testing/samplePlan";
import type { Plan } from "../plan/plan";
import type { Scenario } from "../plan/scenario";
import { CTX, CURRENT_AGE, BARISTA_CURRENT_AGE, START_YEAR } from "./retirementSolver.testUtils";

/**
 * Does the plan survive if the household stops working at `age`? A HYPOTHESIS, so it runs the
 * stop-working boundary — it used to move `plan.retirementAge`, which no longer ends any job
 * and so no longer stops anybody working.
 */
function survivesAt(budget: Plan, age: number): boolean {
  return planSurvives(projectFullRetirement(scenarioOf(budget), age, CTX));
}

describe("retirementSolver — survival off the real projection", () => {
  it("survival is monotonic in the retirement age (later never hurts)", () => {
    // Once an age survives, every later age must too — the property the binary search
    // relies on. Walk the range and assert survival never flips true→false.
    let seenSurviving = false;
    for (let age = CURRENT_AGE; age <= samplePlan.primary.lifeExpectancy; age++) {
      const ok = survivesAt(samplePlan, age);
      if (seenSurviving) expect(ok).toBe(true);
      if (ok) seenSurviving = true;
    }
    expect(seenSurviving).toBe(true);
  });

  it("the binary search returns exactly the threshold age", () => {
    const age = earliestFullRetirementAge(scenarioOf(samplePlan), CTX);
    expect(age).not.toBeNull();
    expect(survivesAt(samplePlan, age as number)).toBe(true);
    expect(survivesAt(samplePlan, (age as number) - 1)).toBe(false);
  });

  it("can find an age LATER than the jobs were authored to run — the 'work longer' answer", () => {
    // The authored job ends at 60. If the plan cannot survive stopping there, the search must
    // still be able to answer "then work until 71" — which means the hypothesis extends that
    // job. Without it every plan whose authored ends are too early reports "no feasible age",
    // and the panel could only ever tell the user their plan fails.
    const tight: Plan = { ...samplePlan, openingBalanceCents: 0 };
    const age = earliestFullRetirementAge(scenarioOf(tight), CTX);
    expect(age).not.toBeNull();
    expect(age as number).toBeGreaterThan(SAMPLE_JOB_END_AGE);
    // And it is a real threshold, not an artefact: one year earlier does not survive.
    expect(survivesAt(tight, age as number)).toBe(true);
    expect(survivesAt(tight, (age as number) - 1)).toBe(false);
    // The authored plan never moved.
    expect(tight.primary.jobs[0]!.endYear).toBe(SAMPLE_START_YEAR - CURRENT_AGE + 60);
  });

  it("returns null when even working to life expectancy fails", () => {
    const broke: Plan = {
      ...samplePlan,
      openingBalanceCents: 0,
      primary: { ...samplePlan.primary, jobs: [] },
    };
    expect(earliestFullRetirementAge(scenarioOf(broke), CTX)).toBeNull();
  });

  it("counts a solvent household that is merely underwater as surviving", () => {
    // A student loan (or new mortgage) puts net worth below zero for years while every
    // bill is paid — the "negative but improving" case. Judging survival on the net-worth
    // SIGN failed such a plan at month 0 and reported no feasible retirement age while the
    // graph beside it sailed to life expectancy. Survival is insolvency, not the sign.
    // Working to life expectancy makes the plan unambiguously funded, so the loan is the only
    // thing under test. Stated as the JOB's end — a retirement age would no longer keep anyone
    // working.
    const funded: Plan = {
      ...samplePlan,
      primary: {
        ...samplePlan.primary,
        jobs: [
          salariedJob(dollarsToCents(8000), {
            deferralFraction: 0.1,
            endAge: samplePlan.primary.lifeExpectancy,
          }),
        ],
      },
    };
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
    const broke: Plan = {
      ...samplePlan,
      openingBalanceCents: 0,
      primary: { ...samplePlan.primary, jobs: [] },
    };
    const series = projectScenario(scenarioOf(broke), CTX);
    // Precondition: the plan really does produce null net-worth months.
    expect(series.months.some((m) => m.netWorthRealCents === null)).toBe(true);
    expect(planSurvives(series)).toBe(false);
  });
});

describe("retirementSolver — a blocked projection is a third state", () => {
  // A no-income household whose $40k opening is stranded: a $25k cash home at month 1 drains it,
  // and a $22k down payment at month 2 can no longer be funded — reproduced with two purchases
  // authored so neither trips the append-time gate (the second drains what the first relied on).
  function strandedScenario(): Scenario {
    const strandPlan: Plan = {
      ...samplePlan,
      primary: { ...samplePlan.primary, jobs: [] },
      goals: [],
      openingBalanceCents: dollarsToCents(40_000),
      budgetLines: [spendLine(dollarsToCents(4000)), healthLine(dollarsToCents(600))],
    };
    const base = createProjectionBase(strandPlan, CTX);
    const withHome = addEvent(emptyLedger, base, {
      id: "buy1",
      type: "HomePurchaseEvent",
      month: 2,
      propertyId: "house1",
      ownerId: "p1",
      purchasePriceCents: dollarsToCents(200_000),
      downPaymentCents: dollarsToCents(22_000),
      downPaymentSourceIds: [SAVINGS_ID],
      mortgage: {
        liabilityId: "house1-mortgage",
        openingBalanceCents: dollarsToCents(178_000),
        apr: 0.06,
        termMonths: 360,
      },
    });
    if (!withHome.ok) throw new Error(`purchase rejected: ${withHome.conflict}`);
    const withDrain = addEvent(withHome.ledger, base, {
      id: "buy0",
      type: "HomePurchaseEvent",
      month: 1,
      propertyId: "house0",
      ownerId: "p1",
      purchasePriceCents: dollarsToCents(25_000),
      downPaymentCents: dollarsToCents(25_000),
      downPaymentSourceIds: [SAVINGS_ID],
    });
    if (!withDrain.ok) throw new Error(`drain rejected: ${withDrain.conflict}`);
    return withLedger(scenarioOf(strandPlan), withDrain.ledger);
  }

  it("does not count a truncated projection as surviving", () => {
    // The core §8 bug: `Array.every` over a truncated series is vacuously `true`, so a blocked
    // plan would report as surviving. Every emitted month here is healthy; the block is the only
    // reason survival must be false.
    const healthyMonth: ProjectionMonth = {
      month: 0,
      netWorthNominalCents: 1_000_000,
      netWorthRealCents: 1_000_000,
      accountBalancesCents: {},
      accountBasisCents: {},
      liabilityBalancesCents: {},
      liabilityPaymentRecords: {},
      propertyValuesCents: {},
      isInsolvent: false,
      uncoveredCents: 0,
    };
    const blocked: ProjectionSeries = {
      opening: healthyMonth,
      months: [healthyMonth],
      status: "blocked",
      simulatedThroughMonth: 0,
      obligationOutcomes: {},
      blockedAtMonth: 0,
    };
    expect(planSurvives(blocked)).toBe(false);
  });

  it("reports blocked from solveRetirement — distinct from null", () => {
    const scenario = strandedScenario();
    // Precondition: projecting even at life expectancy (the most-funded case) is blocked.
    expect(projectFullRetirement(scenario, scenario.plan.primary.lifeExpectancy!, CTX).status).toBe(
      "blocked",
    );

    const solution = solveRetirement(scenario, CTX);
    expect(solution.blocked).toBe(true);
    // No age is reported — but for a different reason than "no age works".
    expect(solution.fullRetirementAge).toBeNull();
  });

  it("keeps a genuinely-infeasible plan as null, NOT blocked", () => {
    // Insolvency without a block: no age works, and nothing is blocked.
    const broke: Plan = {
      ...samplePlan,
      openingBalanceCents: 0,
      primary: { ...samplePlan.primary, jobs: [] },
    };
    const solution = solveRetirement(scenarioOf(broke), CTX);
    expect(solution.fullRetirementAge).toBeNull();
    expect(solution.blocked).toBe(false);
  });

  it("marks the evaluation blocked and names the month it stopped", () => {
    const scenario = strandedScenario();
    const evaluation = evaluateFullRetirementAtAge(
      scenario,
      START_YEAR - scenario.plan.primary.birthYear,
      CTX,
    );
    expect(evaluation.blocked).toBe(true);
    expect(evaluation.feasible).toBe(false);
    expect(evaluation.blockedAtMonth).toBe(2);
  });
});

describe("retirementSolver — evaluating one age", () => {
  // evaluateFullRetirementAtAge reports only at-that-age facts — the verdict, and the block
  // month when it truncated. There is no score beside them: elapsed simulation time is not a
  // measure of success, and a plan that fails in its final year is infeasible, not 97% feasible.
  it("is feasible at a comfortably-fundable age, and reports the verdict alone", () => {
    // Life expectancy is the safest possible age to evaluate: feasible if any age is.
    const evaluation = evaluateFullRetirementAtAge(
      scenarioOf(samplePlan),
      samplePlan.primary.lifeExpectancy,
      CTX,
    );
    expect(evaluation).toEqual({
      retirementAge: samplePlan.primary.lifeExpectancy,
      feasible: true,
      blocked: false,
    });
  });

  it("is plainly infeasible one year short of the threshold — no partial credit", () => {
    const floor = earliestFullRetirementAge(scenarioOf(samplePlan), CTX) as number;
    const evaluation = evaluateFullRetirementAtAge(scenarioOf(samplePlan), floor - 1, CTX);
    expect(evaluation).toEqual({ retirementAge: floor - 1, feasible: false, blocked: false });
  });
});

describe("retirementSolver — one retirement search", () => {
  // There is one search: cease every job at the candidate age. A second, "partial" one used to
  // sit beside it, ending only the jobs with no authored end while the rest kept paying — a
  // distinction that needed open-ended jobs to exist as a category. Every job states its own
  // end now, so there is nothing to tell apart.
  it("full-retirement survival is monotonic in the cease-all-work age (later never hurts)", () => {
    let seenSurviving = false;
    for (let age = BARISTA_CURRENT_AGE; age <= baristaPlan.primary.lifeExpectancy; age++) {
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

  it("is strictly harder to stop earlier than the jobs' own ends — a later age never hurts", () => {
    // What the two-age split used to express, as one property of the single search: a plan
    // whose jobs run to 60 and 75 cannot be made to survive an earlier stop by dropping less,
    // because there is no "less" any more. The threshold is the threshold.
    const scenario = scenarioOf(baristaPlan);
    const age = earliestFullRetirementAge(scenario, CTX) as number;
    expect(age).not.toBeNull();
    for (let later = age; later <= baristaPlan.primary.lifeExpectancy; later++) {
      expect(evaluateFullRetirementAtAge(scenario, later, CTX).feasible).toBe(true);
    }
  });

  it("reports the planned work-stop age as the age the household's own jobs stop paying", () => {
    // max job endYear across the household is the barista's (birthYear + 75) → age 75.
    const solution = solveRetirement(scenarioOf(baristaPlan), CTX);
    expect(solution.plannedWorkStopAge).toBe(75);
  });
});
