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
  earliestFullRetirementAge,
  evaluateFullRetirementAtAge,
  solveRetirement,
  continuedJobsAt,
  stopWorkingBoundaryAt,
} from "./retirementSolver";
import { continuationJobIdOf } from "../job/householdJob";
import { compilePersonPriorEarnings } from "../compile/compilePerson";
import { scenarioOf, withLedger } from "../plan/scenario";
import { addEvent } from "../ledger/addEvent";
import { emptyLedger } from "../ledger/ledger";
import { dollarsToCents } from "../money/cashFlowSeries";
import { createProjectionBase, SAVINGS_ID } from "../compile/projectionBase";
import { RETIREMENT_ID } from "../plan/ids";
import type { ProjectionMonth } from "../projection/simulate";
import type { ProjectionContext } from "../compile/projectionBase";
import { mockJurisdiction } from "../testing/mockJurisdiction";

/**
 * What a partner fixture may vary. An explicit list, NOT `Partial<Person>`: a partial of a type
 * whose fields are required says every one of them may be absent, which is the opposite of what
 * `Person` means — and it silently re-admits `undefined` for `lifeExpectancy`, the field the
 * horizon is computed from, so a builder spreading it had to patch the value back afterwards.
 * Naming the four things these fixtures actually change makes the builders total by construction.
 */
interface PartnerOverrides {
  readonly id?: PersonId;
  readonly birthYear?: number;
  /** Theirs, never the primary's — the engine requires one and infers nothing. */
  readonly lifeExpectancy?: number;
  readonly continuationJobId?: JobId | null;
}
import {
  samplePlan,
  baristaPlan,
  salariedJob,
  stateOf,
  SAMPLE_START_YEAR,
  SAMPLE_JOB_END_AGE,
  spendLine,
  healthLine,
} from "../testing/samplePlan";
import { Projection } from "../facade/projectionFacade";
import type { Plan } from "../plan/plan";
import type { Person } from "../plan/person";
import type { Job, JobId, PersonId } from "../job/job";
import type { Scenario } from "../plan/scenario";
import type { ProjectionSeries } from "../projection/simulate";

const START_YEAR = SAMPLE_START_YEAR;
const CTX: ProjectionContext = { jurisdiction: mockJurisdiction(), startYear: START_YEAR };

/** `samplePlan.primary`'s current age, derived from its frozen `birthYear` — `Plan.currentAge` no longer exists. */
const CURRENT_AGE = SAMPLE_START_YEAR - samplePlan.primary.birthYear;
/** `baristaPlan.primary`'s current age, derived the same way. */
const BARISTA_CURRENT_AGE = SAMPLE_START_YEAR - baristaPlan.primary.birthYear;

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
    const financed = addEvent(emptyLedger, base, {
      id: "mtg1",
      type: "LoanEvent",
      month: 2,
      liabilityId: "mtg1",
      ownerId: "p1",
      kind: "mortgage",
      openingBalanceCents: dollarsToCents(178_000),
      apr: 0.06,
      termMonths: 360,
    });
    if (!financed.ok) throw new Error(`mortgage rejected: ${financed.conflict}`);
    const withHome = addEvent(financed.ledger, base, {
      id: "buy1",
      type: "HomePurchaseEvent",
      month: 2,
      propertyId: "house1",
      ownerId: "p1",
      purchasePriceCents: dollarsToCents(200_000),
      downPaymentCents: dollarsToCents(22_000),
      downPaymentSourceIds: [SAVINGS_ID],
      securedByLiabilityId: "mtg1",
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

/** Primary's birth year in every solver test below: SAMPLE_START_YEAR − CURRENT_AGE. */
const PRIMARY_BIRTH_YEAR = START_YEAR - CURRENT_AGE;

describe("retirementSolver — the stop-working boundary reaches every earner", () => {
  // A partner's jobs live on the RelationshipEvent, not on the plan, so a solve that rewrote
  // only the plan's own job list never ceased them — the household kept one earner working
  // past the stop-working age and the retirement answer was wrong for every two-earner
  // household. Deriving each job's end at compile time from a single boundary fixes it.
  function partnerJob(overrides: Partial<Job> = {}): Job {
    return {
      id: "pj1",
      ownerId: "p2",
      startYear: START_YEAR,
      endYear: SAMPLE_START_YEAR + 40, // a long-running job unless a test says otherwise
      salary: {
        startingSalaryCents: dollarsToCents(24_000),
        currentSalaryCents: dollarsToCents(24_000),
        realGrowthPct: 0,
      },
      ...overrides,
    };
  }

  function partnerWith(overrides: PartnerOverrides & { jobs: readonly Job[] }): Person {
    return {
      id: "p2",
      name: "Partner",
      birthYear: PRIMARY_BIRTH_YEAR,
      lifeExpectancy: samplePlan.primary.lifeExpectancy,
      benefitClaimingAge: 67,
      ...overrides,
    };
  }

  const partnerWithLateJob = (): Person =>
    // A job authored to run far past any plausible stop age, so their wage can only stop
    // because the boundary stopped it.
    partnerWith({ jobs: [partnerJob({ endYear: PRIMARY_BIRTH_YEAR + 80 })] });

  function twoEarnerScenario(partner: Person = partnerWithLateJob()): Scenario {
    const added = addEvent(emptyLedger, createProjectionBase(samplePlan, CTX), {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: partner,
    });
    if (!added.ok) throw new Error(`fixture rejected: ${added.conflict}`);
    return withLedger(scenarioOf(samplePlan), added.ledger);
  }

  /** The partner's own job-income source for one projected month, or undefined if absent. */
  function partnerSource(series: ProjectionSeries, month: number) {
    return series.months[month]?.flows?.incomeSources.find((s) => s.sourceId === "job:pj1");
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
    evaluateFullRetirementAtAge(scenario, 55, CTX);
    projectFullRetirement(scenario, 55, CTX);
    solveRetirement(scenario, CTX);
    expect(JSON.stringify(scenario)).toBe(before);
  });

  describe("a boundary moves the LAST job either way, and only caps the rest", () => {
    it("extends a partner's last job when the candidate boundary is later", () => {
      // Their only job — so their last — is authored to end at month 60. Asking about retiring
      // at 70 (month 360) runs it on, because that is what "work until 70" means.
      const scenario = twoEarnerScenario(
        partnerWith({ jobs: [partnerJob({ endYear: PRIMARY_BIRTH_YEAR + 45 })] }),
      );
      const series = projectFullRetirement(scenario, 70, CTX);
      expect(partnerSource(series, 60)?.cashInflowCents).toBeGreaterThan(0);
      expect(partnerSource(series, 359)?.cashInflowCents).toBeGreaterThan(0);
      expect(partnerSource(series, 360)).toBeUndefined();
    });

    it("leaves an EARLIER job its own end, capping it and nothing more", () => {
      // Two jobs: one finishing at month 60, a later one running to 80. Only the later one is
      // the job they would still be holding, so only it is extended; the first keeps its end
      // and is not resurrected to fill the gap.
      const scenario = twoEarnerScenario(
        partnerWith({
          jobs: [
            partnerJob({ id: "pj1", endYear: PRIMARY_BIRTH_YEAR + 45 }),
            partnerJob({ id: "pj2", endYear: PRIMARY_BIRTH_YEAR + 80 }),
          ],
        }),
      );
      const series = projectFullRetirement(scenario, 70, CTX);
      const sourceAt = (month: number, id: string) =>
        (series.months[month]?.flows?.incomeSources ?? []).find((s) => s.sourceId === `job:${id}`);
      expect(sourceAt(59, "pj1")?.cashInflowCents).toBeGreaterThan(0);
      expect(sourceAt(60, "pj1")).toBeUndefined(); // its own end, untouched
      expect(sourceAt(300, "pj2")?.cashInflowCents).toBeGreaterThan(0); // the last job, capped at 70
      expect(sourceAt(360, "pj2")).toBeUndefined();
    });

    it("caps an earlier job when the candidate lands inside it", () => {
      const scenario = twoEarnerScenario(
        partnerWith({
          jobs: [
            partnerJob({ id: "pj1", endYear: PRIMARY_BIRTH_YEAR + 60 }),
            partnerJob({ id: "pj2", endYear: PRIMARY_BIRTH_YEAR + 80 }),
          ],
        }),
      );
      const series = projectFullRetirement(scenario, 50, CTX);
      const sourceAt = (month: number, id: string) =>
        (series.months[month]?.flows?.incomeSources ?? []).find((s) => s.sourceId === `job:${id}`);
      expect(sourceAt(119, "pj1")?.cashInflowCents).toBeGreaterThan(0);
      expect(sourceAt(120, "pj1")).toBeUndefined();
      expect(sourceAt(120, "pj2")).toBeUndefined();
    });

    it("the boundary can still SHORTEN a partner's job whose natural end is later than the candidate", () => {
      // The inverse direction still works: a partner authored to work to 80 (as in
      // partnerWithLateJob) really does stop early when the candidate boundary asks for it —
      // the boundary moves the last job in both directions.
      const series = projectFullRetirement(twoEarnerScenario(), 50, CTX);
      expect(partnerSource(series, 119)?.cashInflowCents).toBeGreaterThan(0);
      expect(partnerSource(series, 120)).toBeUndefined();
    });
  });

  describe("household membership is a cap of its own, composed with the rest", () => {
    /** The partner, deferring into the retirement account so a match rides on the same wage. */
    const deferringPartner = (endAge: number): Person =>
      partnerWith({
        jobs: [
          partnerJob({
            endYear: PRIMARY_BIRTH_YEAR + endAge,
            deferral: {
              deferralFraction: 0.1,
              fundAccountId: RETIREMENT_ID,
              employerMatchFraction: 0.5,
            },
          }),
        ],
      });

    /** Marry at month 0, separate at `separationMonth`. */
    function separatedScenario(partner: Person, separationMonth: number): Scenario {
      const base = createProjectionBase(samplePlan, CTX);
      const married = addEvent(emptyLedger, base, {
        id: "r1",
        type: "RelationshipEvent",
        month: 0,
        person: partner,
      });
      if (!married.ok) throw new Error(`fixture rejected: ${married.conflict}`);
      const separated = addEvent(married.ledger, base, {
        id: "s1",
        type: "SeparationEvent",
        month: separationMonth,
        partnerPersonId: partner.id,
        alimonyMonthlyCents: 0,
        alimonyDurationMonths: 0,
        childSupportMonthlyCents: 0,
      });
      if (!separated.ok) throw new Error(`fixture rejected: ${separated.conflict}`);
      return withLedger(scenarioOf(samplePlan), separated.ledger);
    }

    it("an ACTIVE partner pays the household every month of their membership window", () => {
      // Nothing to clip: an unseparated membership has no end, so the wage runs to the
      // partner's own natural end and every wage-derived quantity runs with it.
      const series = projectScenario(scenarioWithDeferringPartner(80), CTX);
      expect(partnerSource(series, 0)?.cashInflowCents).toBeGreaterThan(0);
      expect(partnerSource(series, 240)?.cashInflowCents).toBeGreaterThan(0);
      // Deferral stands in for the whole wage-derived chain here: the mock jurisdiction levies
      // no payroll tax, so a FICA assertion would pass whatever the window did.
      expect(series.months[240]?.flows?.deferralBySourceCents?.["job:pj1"]).toBeGreaterThan(0);
    });

    it("a SEPARATED partner stops paying the household at the separation, wages and everything derived from them", () => {
      // The membership ends at month 120 while the job itself runs to 80. Every wage-derived
      // quantity reads the same resolved window, so none of them survives the separation:
      // no wage, no payroll tax, no deferral — and no employer match, which exists only as a
      // fraction of a deferral that is no longer happening.
      const series = projectScenario(separatedScenario(deferringPartner(80), 120), CTX);
      expect(partnerSource(series, 119)?.cashInflowCents).toBeGreaterThan(0);
      expect(series.months[119]?.flows?.deferralBySourceCents?.["job:pj1"]).toBeGreaterThan(0);
      expect(partnerSource(series, 120)).toBeUndefined();
      expect(series.months[120]?.flows?.deferralBySourceCents?.["job:pj1"]).toBeUndefined();
    });

    it("a candidate boundary can shorten a membership-clipped job, never outlive the separation", () => {
      // Both caps in play at once. Separation at month 120; a full-stop candidate of 45 lands at
      // month 60, so the wage stops there — the boundary shortens. Raise the candidate to 70
      // (month 360) and the separation still ends it at 120: neither cap can extend past the
      // other, whichever is tighter.
      const scenario = separatedScenario(deferringPartner(80), 120);
      const shortened = projectFullRetirement(scenario, 45, CTX);
      expect(partnerSource(shortened, 59)?.cashInflowCents).toBeGreaterThan(0);
      expect(partnerSource(shortened, 60)).toBeUndefined();

      const late = projectFullRetirement(scenario, 70, CTX);
      expect(partnerSource(late, 119)?.cashInflowCents).toBeGreaterThan(0);
      expect(partnerSource(late, 120)).toBeUndefined();
    });

    function scenarioWithDeferringPartner(endAge: number): Scenario {
      return twoEarnerScenario(deferringPartner(endAge));
    }
  });
});

describe("solveRetirement — plannedWorkStopAge is household-wide", () => {
  // Same fixture shapes as the boundary describe block above, kept local: `plannedWorkStopAge`
  // is a plain read (no boundary involved), so these tests exercise it in isolation.
  function partnerJob(overrides: Partial<Job> = {}): Job {
    return {
      id: "pj1",
      ownerId: "p2",
      startYear: START_YEAR,
      endYear: SAMPLE_START_YEAR + 40,
      salary: {
        startingSalaryCents: dollarsToCents(24_000),
        currentSalaryCents: dollarsToCents(24_000),
        realGrowthPct: 0,
      },
      ...overrides,
    };
  }

  function partnerWith(overrides: PartnerOverrides & { jobs: readonly Job[] }): Person {
    return {
      id: "p2",
      name: "Partner",
      birthYear: PRIMARY_BIRTH_YEAR,
      lifeExpectancy: samplePlan.primary.lifeExpectancy,
      benefitClaimingAge: 67,
      ...overrides,
    };
  }

  function twoEarnerScenario(partner: Person): Scenario {
    const added = addEvent(emptyLedger, createProjectionBase(samplePlan, CTX), {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: partner,
    });
    if (!added.ok) throw new Error(`fixture rejected: ${added.conflict}`);
    return withLedger(scenarioOf(samplePlan), added.ledger);
  }

  it("a partner job resolves via its OWN authored end, later than every primary job", () => {
    // Primary's only job is open-ended, natural end birthYear + 60 (SAMPLE_JOB_END_AGE)
    // → age 60. Partner's job is authored to end at 80 (same birth year) → the
    // household-wide max is the partner's, age 80 — later than any primary job alone.
    const scenario = twoEarnerScenario(partnerWith({ jobs: [partnerJob()] }));
    expect(solveRetirement(scenario, CTX).plannedWorkStopAge).toBe(80);
  });

  it("a partner's later calendar-year stop converts through the PRIMARY's birth year, not their own", () => {
    // Partner is 10 years older (birthYear 10 years earlier) but authored to work to age 90 —
    // their natural-end CALENDAR YEAR is (PRIMARY_BIRTH_YEAR − 10) + 90 = PRIMARY_BIRTH_YEAR + 80,
    // i.e. 80 years past the PRIMARY's own birth year, not 90 (which would be the partner's own
    // age at that year, and reporting that would misattribute the partner's stop as if it were
    // the primary's age).
    //
    // Expectancy 95 so they LIVE to work those years: a job ends at `min(authored end, death)`,
    // and this test is about the birth-year conversion rather than the death cap — pinned on its
    // own below.
    const scenario = twoEarnerScenario(
      partnerWith({ birthYear: PRIMARY_BIRTH_YEAR - 10, lifeExpectancy: 95, jobs: [partnerJob()] }),
    );
    expect(solveRetirement(scenario, CTX).plannedWorkStopAge).toBe(80);
  });

  it("a partner job is read via its authored endYear, and nothing else", () => {
    const explicitEndYear = PRIMARY_BIRTH_YEAR + 95; // later than every other job here
    const scenario = twoEarnerScenario(
      // Again long-lived enough for the authored end to be the binding one.
      partnerWith({ lifeExpectancy: 100, jobs: [partnerJob({ endYear: explicitEndYear })] }),
    );
    expect(solveRetirement(scenario, CTX).plannedWorkStopAge).toBe(95);
  });

  it("a partner job authored past their own death stops at the death instead", () => {
    // The same job as above, now held by someone who does not live to finish it: authored to
    // PRIMARY_BIRTH_YEAR + 95, expectancy 85, same birth year — so the employment ends at
    // PRIMARY_BIRTH_YEAR + 85 and the household-wide stop is age 85, not 95.
    //
    // This used to report 95. `plannedWorkStopAge` reads resolved employment ends, and the
    // resolution had no opinion about death — so the panel told a household it would be working
    // ten years after the earner it belonged to had died.
    const scenario = twoEarnerScenario(
      partnerWith({
        lifeExpectancy: 85,
        jobs: [partnerJob({ endYear: PRIMARY_BIRTH_YEAR + 95 })],
      }),
    );
    expect(solveRetirement(scenario, CTX).plannedWorkStopAge).toBe(85);
  });

  /** Marry `partner` at month 0, then separate at `separationMonth`. */
  function separatedScenario(partner: Person, separationMonth: number): Scenario {
    const base = createProjectionBase(samplePlan, CTX);
    const married = addEvent(emptyLedger, base, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: partner,
    });
    if (!married.ok) throw new Error(`fixture rejected: ${married.conflict}`);
    const separated = addEvent(married.ledger, base, {
      id: "s1",
      type: "SeparationEvent",
      month: separationMonth,
      partnerPersonId: partner.id,
      alimonyMonthlyCents: 0,
      alimonyDurationMonths: 0,
      childSupportMonthlyCents: 0,
    });
    if (!separated.ok) throw new Error(`fixture rejected: ${separated.conflict}`);
    return withLedger(scenarioOf(samplePlan), separated.ledger);
  }

  it("a separated partner's job stops counting at the separation, not at their own retirement target", () => {
    // The partner is authored to work to 80, but leaves the household at month 300 — the
    // primary's age 65. Their wages after that are no longer this household's, so the household
    // stops being paid for that job then, and the read reports 65 rather than the 80 the job
    // would reach in a household the partner is no longer in.
    const scenario = separatedScenario(
      partnerWith({ jobs: [partnerJob()] }),
      300,
    );
    expect(solveRetirement(scenario, CTX).plannedWorkStopAge).toBe(65);
  });

  it("falls back to the primary's own job once an early separation ends the partner's wages", () => {
    // Same partner, separating at month 12 (age 41) — before even the primary's own open-ended
    // job ends at `SAMPLE_JOB_END_AGE`. The household's final wage is the primary's.
    const scenario = separatedScenario(
      partnerWith({ jobs: [partnerJob()] }),
      12,
    );
    expect(solveRetirement(scenario, CTX).plannedWorkStopAge).toBe(SAMPLE_JOB_END_AGE);
  });

  it("an ACTIVE partner is capped by their JOB's end, never by a membership that has no end", () => {
    // The mirror of the two above: an unseparated membership runs forever, so it clips nothing
    // and the partner's own authored job end is what ends the household's wages.
    const scenario = twoEarnerScenario(
      partnerWith({ jobs: [partnerJob({ endYear: PRIMARY_BIRTH_YEAR + 72 })] }),
    );
    expect(solveRetirement(scenario, CTX).plannedWorkStopAge).toBe(72);
  });

  it("multiple relationship events: the household-wide max wins across every partner ever added", () => {
    const base = createProjectionBase(samplePlan, CTX);
    const first = addEvent(emptyLedger, base, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: partnerWith({
        id: "p2",
        jobs: [partnerJob({ id: "pj1", ownerId: "p2", endYear: PRIMARY_BIRTH_YEAR + 55 })],
      }),
    });
    if (!first.ok) throw new Error(`fixture rejected: ${first.conflict}`);
    const separated = addEvent(first.ledger, base, {
      id: "s1",
      type: "SeparationEvent",
      month: 12,
      partnerPersonId: "p2",
      alimonyMonthlyCents: 0,
      alimonyDurationMonths: 0,
      childSupportMonthlyCents: 0,
    });
    if (!separated.ok) throw new Error(`fixture rejected: ${separated.conflict}`);
    const second = addEvent(separated.ledger, base, {
      id: "r2",
      type: "RelationshipEvent",
      month: 24,
      person: partnerWith({
        id: "p3",
        jobs: [partnerJob({ id: "pj2", ownerId: "p3", endYear: PRIMARY_BIRTH_YEAR + 85 })],
      }),
    });
    if (!second.ok) throw new Error(`fixture rejected: ${second.conflict}`);
    const scenario = withLedger(scenarioOf(samplePlan), second.ledger);
    // The household's final wage across: primary (60), first partner (separated at month 12, so
    // 41 rather than the 55 they were authored to work to), second partner (85) → 85.
    expect(solveRetirement(scenario, CTX).plannedWorkStopAge).toBe(85);
  });
});

/**
 * **Which job — if any — a what-if carries past the authored plan when it asks about a LATER
 * stop-working age.**
 *
 * One selection per person ({@link Person.continuationJobId}), and these pin what selecting
 * something does, what selecting `null` does, and what happens before anybody has selected at
 * all. The rule they replaced read the answer off the dates — the chronologically last job was
 * extended, whatever it was — which is wrong in the one shape it most needs to be right for, a
 * term contract taken at the end of a career, and the dates cannot tell the two apart because
 * every job has an end date and none of them says whether the work could continue.
 *
 * Asserted on the primary's plan jobs, so each case is a plan and a candidate age with nothing
 * else moving. The mock jurisdiction pays no benefit, so every cent of income in these series is
 * a wage and `job:<id>` names which job paid it.
 */
describe("retirementSolver — which job a later candidate age continues", () => {
  const BIRTH_YEAR = PRIMARY_BIRTH_YEAR;
  const at = (age: number) => BIRTH_YEAR + age;
  /** Months from "now" to the primary's `age` — the fixture's current age is `samplePlan`'s. */
  const monthAt = (age: number) => (age - CURRENT_AGE) * 12;

  function job(id: string, startAge: number, endAge: number, annualDollars = 90_000): Job {
    return {
      id,
      ownerId: "p1",
      startYear: at(startAge),
      endYear: at(endAge),
      salary: {
        startingSalaryCents: dollarsToCents(annualDollars),
        currentSalaryCents: dollarsToCents(annualDollars),
        realGrowthPct: 0,
      },
    };
  }

  /**
   * A plan holding `jobs`, with the primary's selection stated. Omitting `continuationJobId`
   * leaves it UNSTATED — the "nobody has chosen yet" case the initialization rule answers — which
   * is a different plan from one stating `null`, so the two are never spelled the same way here.
   */
  const planWithJobs = (jobs: readonly Job[], continuationJobId?: string | null): Plan => ({
    ...samplePlan,
    primary: {
      ...samplePlan.primary,
      jobs,
      ...(continuationJobId !== undefined ? { continuationJobId } : {}),
    },
  });

  /** What `job:<id>` paid the household in `month`, or 0 when it paid nothing at all. */
  function wageAt(series: ProjectionSeries, id: string, month: number): number {
    const source = (series.months[month]?.flows?.incomeSources ?? []).find(
      (s) => s.sourceId === `job:${id}`,
    );
    return source?.cashInflowCents ?? 0;
  }

  /** Every cent of household income in `month`, whatever paid it. */
  const incomeAt = (series: ProjectionSeries, month: number): number =>
    series.months[month]?.flows?.totalIncomeCents ?? 0;

  /**
   * A career and the token job that follows it, read against `baristaPlan`'s OWN clock — the
   * two cases below that turn on a solved age use that fixture's tighter budget, and its
   * `currentAge` differs from `samplePlan`'s.
   */
  const baristaJobs: readonly Job[] = (() => {
    const birthYear = START_YEAR - BARISTA_CURRENT_AGE;
    const atBarista = (age: number) => birthYear + age;
    const shift = (j: Job, startAge: number, endAge: number): Job => ({
      ...j,
      startYear: atBarista(startAge),
      endYear: atBarista(endAge),
    });
    return [
      shift(job("career", 35, 65, 90_000), 35, 65),
      shift(job("token", 65, 70, 12_000), 65, 70),
    ];
  })();

  it("continues the SELECTED job, not the one that happens to end last", () => {
    // The spec case, and the whole reason the selection is authored: a career (35–65) followed
    // by a two-year contract (65–70). Asked whether they could stop at 71 with the CAREER named,
    // the plan carries the career on — it does not run the contract past a term that was never
    // theirs to extend, and does not conclude they keep working because something ends last.
    const jobs = [job("career", 35, 65), job("contract", 65, 70)];
    const series = projectFullRetirement(scenarioOf(planWithJobs(jobs, "career")), 71, CTX);

    // The contract stops dead on its own term, though it is the later-ending job.
    expect(wageAt(series, "contract", monthAt(69))).toBeGreaterThan(0);
    expect(wageAt(series, "contract", monthAt(70))).toBe(0);
    // The career runs on through the years it never authored, up to the candidate age.
    expect(wageAt(series, "career", monthAt(66))).toBeGreaterThan(0);
    expect(wageAt(series, "career", monthAt(70))).toBeGreaterThan(0);
    expect(wageAt(series, "career", monthAt(71))).toBe(0);
  });

  it("continues the later job instead when THAT is what was selected", () => {
    // The same two jobs and the same candidate age, one field different — so the assertion is
    // that the selection decides, and not that some other property of these jobs does.
    const jobs = [job("career", 35, 65), job("contract", 65, 70)];
    const series = projectFullRetirement(scenarioOf(planWithJobs(jobs, "contract")), 71, CTX);

    expect(wageAt(series, "career", monthAt(65))).toBe(0);
    expect(wageAt(series, "contract", monthAt(70))).toBeGreaterThan(0);
    expect(wageAt(series, "contract", monthAt(71))).toBe(0);
  });

  it("answers a different retirement AGE depending on which job was selected", () => {
    // The two previous cases in the terms the user actually meets. An earlier well-paid career
    // and a later token job, on `baristaPlan`'s budget — tight enough that the difference
    // between continuing $90k of work and continuing $12k of it decides the whole answer.
    //
    // Nothing but the selection differs between these three runs, and they are the same three
    // jobs the date-based rule would have chosen the LAST of every time.
    const onChoice = (chosen: string | null) =>
      earliestFullRetirementAge(
        scenarioOf({
        ...baristaPlan,
        primary: { ...baristaPlan.primary, jobs: baristaJobs, continuationJobId: chosen },
      }),
        CTX,
      );

    expect(onChoice("career")).toBe(74);
    // The token job cannot fund the gap however long it runs, so there is no age at all — the
    // honest answer, and the one the household gets by naming it.
    expect(onChoice("token")).toBeNull();
    expect(onChoice(null)).toBeNull();
  });

  it("invents NO income when the household selected None", () => {
    // `null` is an answer, not an absence: there is no honest way to fund working to 75, so the
    // plan pays nothing past the work it was actually given rather than conjuring a wage. The
    // candidate then fails on its own merits, which is the right answer and not a bug.
    const series = projectFullRetirement(
      scenarioOf(planWithJobs([job("only", 35, 65)], null)),
      75,
      CTX,
    );
    expect(wageAt(series, "only", monthAt(64))).toBeGreaterThan(0);
    expect(wageAt(series, "only", monthAt(65))).toBe(0);
    // Nothing else picks up the slack — no job, no phantom source, no benefit.
    expect(incomeAt(series, monthAt(70))).toBe(0);
  });

  it("never continues an unselected job, even as the household's only one", () => {
    // The narrowest statement of the rule, held apart from the case above: it is not that a
    // household answering None gets no answer, it is that a job nobody named is never run on.
    const series = projectFullRetirement(
      scenarioOf(planWithJobs([job("term", 35, 60)], null)),
      80,
      CTX,
    );
    for (const age of [60, 65, 70, 79]) expect(wageAt(series, "term", monthAt(age))).toBe(0);
  });

  it("extends the selected job as soon as the candidate passes ITS OWN end, not the plan's last", () => {
    // The rule, at the age that used to get it wrong. Career 35–65, contract 65–70, career
    // selected, candidate 68. The pivot was the person's WHOLE authored plan, so nothing was
    // extended until the candidate cleared 70 and the career stopped dead at 65 here — the
    // selection silently meant nothing at this age. It is past the career's own end, so the
    // career runs on; the contract keeps its authored dates and is capped at the candidate.
    const jobs = [job("career", 35, 65), job("contract", 65, 70)];
    const series = projectFullRetirement(scenarioOf(planWithJobs(jobs, "career")), 68, CTX);

    expect(wageAt(series, "career", monthAt(64))).toBeGreaterThan(0);
    expect(wageAt(series, "career", monthAt(67))).toBeGreaterThan(0);
    expect(wageAt(series, "career", monthAt(68))).toBe(0); // stopped by the candidate, not by 65
    expect(wageAt(series, "contract", monthAt(67))).toBeGreaterThan(0);
    expect(wageAt(series, "contract", monthAt(68))).toBe(0); // its own 70, cut at the candidate
  });

  it("caps the selected job like any other at a candidate INSIDE its own span", () => {
    // The other half of the same gate: extension is not "the selected job ignores the boundary".
    // At 60 the career is still running anyway, so there is nothing to carry — it is truncated
    // exactly as an unselected job would be, and the contract never starts.
    const jobs = [job("career", 35, 65), job("contract", 65, 70)];
    const series = projectFullRetirement(scenarioOf(planWithJobs(jobs, "career")), 60, CTX);

    expect(wageAt(series, "career", monthAt(59))).toBeGreaterThan(0);
    expect(wageAt(series, "career", monthAt(60))).toBe(0);
    for (const age of [65, 67, 69]) expect(wageAt(series, "contract", monthAt(age))).toBe(0);
  });

  it("is continuous across the household's last authored work end", () => {
    // The discontinuity this rule exists to remove, asserted as the property rather than at one
    // age. Under the per-person pivot the career was denied at 70 and granted at 71, so one
    // extra year of retirement age bought SIX extra years of salary and two adjacent candidates
    // modelled incompatible lives. Total income at a given month may only ever rise with the
    // candidate — and never by a step the extra year cannot account for.
    const jobs = [job("career", 35, 65), job("contract", 65, 70)];
    const scenario = scenarioOf(planWithJobs(jobs, "career"));
    // Income in the household's 66th year — one month past the career's own end, and inside
    // every candidate below, so the only thing that varies is whether the career is running.
    const atAge = (age: number) => incomeAt(projectFullRetirement(scenario, age, CTX), monthAt(65));

    // 66 through 72 — straddling the plan's own last year, 70. The career is running in every
    // one of them, because 66 is already past its own end. Under the old pivot this month was
    // career-less at 70 and career-paying at 71: the step this asserts away.
    const income = [66, 67, 68, 69, 70, 71, 72].map(atAge);
    for (const cents of income) expect(cents).toBe(income[0]);
    expect(income[0]).toBeGreaterThan(0);
  });

  it("answers inside the years the plan's last job used to swallow, and keeps paying for savings", () => {
    // The continuity above, in the only terms a household reads: the SOLVED AGE. The test
    // before it fixes the candidate and varies the money's arrival; this fixes the jobs and
    // varies the money, because a discontinuity in the projection shows up here as a solver
    // that stops responding — the ages it cannot reach are ages no amount of saving buys.
    //
    // Career 35–65, token job 65–70, career selected, on the barista budget. Under the
    // per-person pivot nothing was extended until the candidate cleared 70, so every one of
    // these balances answered 71: $200k of extra savings bought nothing at all, and 66–70 were
    // unreachable answers however the plan was funded. They are the years the household is
    // most likely to be asking about.
    const solveAt = (openingDollars: number) =>
      earliestFullRetirementAge(
        scenarioOf({
          ...baristaPlan,
          primary: { ...baristaPlan.primary, jobs: baristaJobs, continuationJobId: "career" },
          openingBalanceCents: dollarsToCents(openingDollars),
        }),
        CTX,
      );

    // Was [71, 71, 71].
    const ages = [400_000, 450_000, 600_000].map(solveAt);
    expect(ages).toEqual([70, 69, 67]);
    // Each lands strictly inside the dead band — past the career's own end, at or before the
    // token job's — which is what makes them answers the old rule could not produce at all.
    for (const age of ages) {
      expect(age).toBeGreaterThan(65);
      expect(age).toBeLessThanOrEqual(70);
    }
    // And the response is monotone: more savings never costs a household a later stop age.
    for (let i = 1; i < ages.length; i++) expect(ages[i]!).toBeLessThan(ages[i - 1]!);
  });

  it("never starts a job the candidate boundary falls before", () => {
    // A job authored to begin after the household stopped working does not happen — including
    // one that was selected, which is the case the extension rule could most easily get wrong by
    // reading "continue this job" as "run this job regardless".
    const jobs = [job("career", 35, 65), job("later", 72, 80)];
    for (const chosen of ["career", "later"]) {
      const series = projectFullRetirement(scenarioOf(planWithJobs(jobs, chosen)), 68, CTX);
      for (const age of [72, 75, 79]) expect(wageAt(series, "later", monthAt(age))).toBe(0);
    }
  });

  it("models a COMPLETED selected job as one that never ended", () => {
    // Selecting a finished job is a counterfactual, not a plan to take it up again: the ONE span
    // it was authored with simply runs on to the boundary, keeping its original start. So it
    // pays every month of the projection — there is no gap where it stopped and no second
    // segment beginning later, because in this scenario it never stopped.
    const jobs = [job("past", 25, 30, 20_000), job("current", 35, 65)];
    const series = projectFullRetirement(scenarioOf(planWithJobs(jobs, "past")), 70, CTX);

    // Continuous from "now" (age 40, well past its authored end at 30) to the boundary. A job
    // restarted at some later date would leave zeros in between; this has none.
    for (const age of [40, 50, 64, 69]) {
      expect(wageAt(series, "past", monthAt(age))).toBeGreaterThan(0);
    }
    expect(wageAt(series, "past", monthAt(70))).toBe(0);
    // And the unselected job still stops exactly where it was authored to.
    expect(wageAt(series, "current", monthAt(65))).toBe(0);
  });

  it("pays BOTH jobs through the overlap the extension creates — intended, not a leak", () => {
    // The spec's own example: continuing the career means it never ended, so it runs through the
    // contract authored to follow it and both pay from 65 to 70. Asserted as a sum, so this
    // fails if either the extension or the untouched later job were silently dropped.
    const jobs = [job("career", 35, 65, 90_000), job("contract", 65, 70, 30_000)];
    const series = projectFullRetirement(scenarioOf(planWithJobs(jobs, "career")), 71, CTX);

    const career = wageAt(series, "career", monthAt(67));
    const contract = wageAt(series, "contract", monthAt(67));
    expect(career).toBeGreaterThan(0);
    expect(contract).toBeGreaterThan(0);
    expect(incomeAt(series, monthAt(67))).toBe(career + contract);
    // Past the contract's own end only the continued job is left.
    expect(wageAt(series, "contract", monthAt(70))).toBe(0);
    expect(wageAt(series, "career", monthAt(70))).toBeGreaterThan(0);
  });

  it("reports the overlap window a continued job creates, in its OWNER's ages", () => {
    // The one consequence a reader would not predict, so it is disclosed with its years rather
    // than left to be discovered in the income chart.
    const jobs = [job("career", 35, 65, 90_000), job("contract", 65, 70, 30_000)];
    const [continued] = continuedJobsAt(scenarioOf(planWithJobs(jobs, "career")), 71, CTX);

    expect(continued.jobId).toBe("career");
    expect(continued.overlaps).toEqual([
      {
        jobId: "contract",
        jobLabel: `${samplePlan.primary.name}'s job 2`,
        jobName: null,
        fromAge: 65,
        toAge: 70,
        fromYear: SAMPLE_START_YEAR - CURRENT_AGE + 65,
        toYear: SAMPLE_START_YEAR - CURRENT_AGE + 70,
      },
    ]);
    // The continuation's own terminus, likewise the owner's — here the primary, so it matches
    // the boundary age the search was asked about.
    expect(continued.throughAge).toBe(71);
    expect(continued.throughYear).toBe(SAMPLE_START_YEAR - CURRENT_AGE + 71);
  });

  it("reports an overlap only from NOW, never from a year the projection does not pay", () => {
    // Continuing a job that ended before "now" overlaps on paper from its authored end, but no
    // month before 0 is ever paid — so naming that earlier year would claim years of doubled
    // income that do not happen. The fixture's primary is 40, and the bar job ended at 30.
    const jobs = [job("bar", 20, 30, 20_000), job("current", 35, 65)];
    const [continued] = continuedJobsAt(scenarioOf(planWithJobs(jobs, "bar")), 70, CTX);

    expect(continued.jobId).toBe("bar");
    expect(continued.overlaps).toEqual([
      {
        jobId: "current",
        jobLabel: `${samplePlan.primary.name}'s job 2`,
        jobName: null,
        fromAge: CURRENT_AGE,
        toAge: 65,
        fromYear: SAMPLE_START_YEAR,
        toYear: SAMPLE_START_YEAR - CURRENT_AGE + 65,
      },
    ]);
  });

  it("counts a PARTNER's continuation in the partner's OWN years, not the primary's", () => {
    // The bug this pins: every age here was converted through the primary's birth year, so a
    // partner born in a different year had their job's terminus and overlap windows reported in
    // the primary's ages — numbers from one person's life stated as facts about another's. The
    // partner is five years OLDER, which is what makes the two clocks visibly disagree; the
    // calendar years are identical either way, and are what let a reader reconcile them.
    const partnerBirthYear = PRIMARY_BIRTH_YEAR - 5;
    const partnerJobAt = (id: string, startAge: number, endAge: number, annual: number): Job => ({
      id,
      ownerId: "p2",
      startYear: partnerBirthYear + startAge,
      endYear: partnerBirthYear + endAge,
      salary: {
        startingSalaryCents: dollarsToCents(annual),
        currentSalaryCents: dollarsToCents(annual),
        realGrowthPct: 0,
      },
    });
    const partner: Person = {
      id: "p2",
      name: "Partner",
      birthYear: partnerBirthYear,
      lifeExpectancy: samplePlan.primary.lifeExpectancy,
      benefitClaimingAge: 67,
      continuationJobId: "nursing",
      jobs: [
        partnerJobAt("nursing", 22, 50, 48_000),
        partnerJobAt("consulting", 52, 58, 12_000),
      ],
    };
    const added = addEvent(emptyLedger, createProjectionBase(samplePlan, CTX), {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: partner,
    });
    if (!added.ok) throw new Error(`fixture rejected: ${added.conflict}`);
    // The primary names no continuation, so only the partner's job is extended and the answer
    // is unambiguously about them.
    const scenario = withLedger(scenarioOf(planWithJobs(samplePlan.primary.jobs, null)), added.ledger);

    // A boundary at the primary's 71 is the calendar year the PARTNER turns 76.
    const [continued] = continuedJobsAt(scenario, 71, CTX);
    expect(continued.ownerName).toBe("Partner");
    expect(continued.jobId).toBe("nursing");
    expect(continued.throughAge).toBe(76);
    expect(continued.throughYear).toBe(PRIMARY_BIRTH_YEAR + 71);

    // And the overlap with their own later job, in their years: 52–58, never the primary's 47–53.
    expect(continued.overlaps).toEqual([
      {
        jobId: "consulting",
        jobLabel: "Partner's job 2",
        jobName: null,
        fromAge: 52,
        toAge: 58,
        fromYear: partnerBirthYear + 52,
        toYear: partnerBirthYear + 58,
      },
    ]);
  });

  it("reports no overlap where the continued job was already the last one running", () => {
    // The ordinary case. Nothing follows the career, so continuing it crosses nothing and there
    // is no surprise to disclose.
    const jobs = [job("career", 35, 65), job("early", 25, 30)];
    const [continued] = continuedJobsAt(scenarioOf(planWithJobs(jobs, "career")), 71, CTX);

    expect(continued.jobId).toBe("career");
    expect(continued.overlaps).toEqual([]);
  });

  it("carries the counterfactual into the covered-earnings record, backwards as well as forwards", () => {
    // Continuing a completed job says it never ended, and a person's earnings HISTORY is part of
    // what never ending means: a bar job left at 30, continued for someone who is 40, means they
    // worked those ten years, and a benefit priced off the record has to see them.
    //
    // The pay in the filled years is what the history does everywhere else — the last authored
    // figure held flat, never a projection — so nothing is invented beyond the continuation the
    // household actually asked for.
    const jobs = [job("bar", 20, 30, 20_000), job("current", 35, 65)];
    const person = (continuationJobId: string | null): Person => ({
      id: "p1",
      name: samplePlan.primary.name,
      birthYear: BIRTH_YEAR,
      lifeExpectancy: samplePlan.primary.lifeExpectancy,
      benefitClaimingAge: 67,
      jobs,
      continuationJobId,
    });
    const hypothetical = {
      kind: "hypothetical" as const,
      stopWorking: stopWorkingBoundaryAt(samplePlan, 70, START_YEAR),
    };

    const continued = compilePersonPriorEarnings(person("bar"), START_YEAR, hypothetical);
    // The gap between the authored end at 30 and "now" is filled — and filled at exactly what
    // the job was already paying, which is the claim: the history is held flat, not projected.
    const authoredYear = continued[at(29)];
    expect(authoredYear).toBeGreaterThan(0);
    // 30–34: the bar job alone, still paying what it was authored to pay.
    for (const age of [30, 32, 34]) expect(continued[at(age)]).toBe(authoredYear);
    // 35 onward the career has begun, and overlapping jobs sum — the continued job did not
    // displace it, exactly as the forward series does not.
    expect(continued[at(35)]).toBeGreaterThan(authoredYear);

    // Selecting None leaves the record exactly as authored: the gap is real again, because
    // nothing is being modelled as having continued.
    // 30–34 is the window only the bar job could have covered, so it is the window that shows
    // the difference: filled under the continuation, empty without it.
    const none = compilePersonPriorEarnings(person(null), START_YEAR, hypothetical);
    expect(none[at(29)]).toBe(authoredYear);
    for (const age of [30, 32, 34]) expect(none[at(age)]).toBeUndefined();
    // The career's own years are untouched either way — only the continued job reaches back.
    expect(none[at(35)]).toBe(continued[at(35)]! - authoredYear);
  });

  it("leaves the AUTHORED earnings record alone — the backfill is the hypothesis's, not the plan's", () => {
    // The same guarantee every other part of the selection carries. A plan the user is looking
    // at reports the years they actually worked, whatever they picked in the continuation
    // control, and only a solve or a preview sees the counterfactual history.
    const jobs = [job("bar", 20, 30, 20_000), job("current", 35, 65)];
    const person = (continuationJobId: string | null): Person => ({
      id: "p1",
      name: samplePlan.primary.name,
      birthYear: BIRTH_YEAR,
      lifeExpectancy: samplePlan.primary.lifeExpectancy,
      benefitClaimingAge: 67,
      jobs,
      continuationJobId,
    });

    const authored = compilePersonPriorEarnings(person("bar"), START_YEAR);
    expect(authored).toEqual(compilePersonPriorEarnings(person(null), START_YEAR));
    for (const age of [30, 32, 34]) expect(authored[at(age)]).toBeUndefined();
  });

  it("changes NOTHING about the authored projection — the selection is about hypotheticals only", () => {
    // The load-bearing guarantee: the selection is read by the solver and the preview, and by
    // nothing that draws the user's own plan. Moving it, or clearing it, must leave the ordinary
    // projection byte-for-byte identical.
    const jobs = [job("career", 35, 65), job("contract", 65, 70)];
    const monthsOf = (s: Scenario) =>
      JSON.stringify(projectScenario(s, CTX).months.map((m) => m.flows?.totalIncomeCents ?? 0));
    const onCareer = monthsOf(scenarioOf(planWithJobs(jobs, "career")));

    expect(monthsOf(scenarioOf(planWithJobs(jobs, "contract")))).toBe(onCareer);
    expect(monthsOf(scenarioOf(planWithJobs(jobs, null)))).toBe(onCareer);
    expect(monthsOf(scenarioOf(planWithJobs(jobs)))).toBe(onCareer);
    // And the authored plan really does end where each job was authored to end.
    const series = projectScenario(scenarioOf(planWithJobs(jobs, "career")), CTX);
    expect(wageAt(series, "career", monthAt(64))).toBeGreaterThan(0);
    expect(wageAt(series, "career", monthAt(65))).toBe(0);
  });

  it("applies the same selection to the stop-working PREVIEW, not just the search", () => {
    // The preview exists to show what the solved age means, so it must resolve jobs the same way
    // the solve did. Run through `Projection.runAtStopWorkingAge` — the app's own entry point —
    // rather than the solver's internals, so the two cannot drift apart unnoticed.
    const jobs = [job("career", 35, 65), job("contract", 65, 70)];
    const p = Projection.fromState(stateOf(planWithJobs(jobs, "career")), mockJurisdiction());
    const previewed = p.runAtStopWorkingAge(mockJurisdiction(), 71).series;

    expect(wageAt(previewed, "career", monthAt(70))).toBeGreaterThan(0);
    expect(wageAt(previewed, "contract", monthAt(70))).toBe(0);

    // And at a preview age INSIDE the plan's last authored year, where the two used to diverge:
    // the search extended the career from 66 while the preview's own rule did not, so the chart
    // showed a different life from the one the headline age was solved under. Both read the same
    // resolution now, so both have the career running at 67 and the contract capped at 68.
    const inside = p.runAtStopWorkingAge(mockJurisdiction(), 68).series;
    expect(wageAt(inside, "career", monthAt(67))).toBeGreaterThan(0);
    expect(wageAt(inside, "career", monthAt(68))).toBe(0);
    expect(wageAt(inside, "contract", monthAt(67))).toBeGreaterThan(0);
    expect(wageAt(inside, "contract", monthAt(68))).toBe(0);
  });

  it("discloses the job a solved age assumed would continue", () => {
    // The age alone hides its premise: 74 means something different if it quietly took nine
    // years of work past the plan. `continuedJobs` is read back off the resolution the run
    // performed, so it names a job exactly when the projection really did pay it for years the
    // plan does not contain.
    const solved = solveRetirement(
      scenarioOf({
        ...baristaPlan,
        primary: { ...baristaPlan.primary, jobs: baristaJobs, continuationJobId: "career" },
      }),
      CTX,
    );
    expect(solved.fullRetirementAge).toBe(74);
    // Named the way the income legend names it — its own title if it has one, else its
    // OWNER's, never the minted id, which would mean nothing beside a retirement age.
    expect(solved.continuedJobs).toEqual([
      {
        jobId: "career",
        jobLabel: `${baristaPlan.primary.name}'s job 1`,
        jobName: null,
        ownerId: "p1",
        ownerName: baristaPlan.primary.name,
        // The owner here IS the primary, so their age and the solved age coincide — the case
        // that hid the partner bug for as long as it did.
        throughAge: 74,
        throughYear: SAMPLE_START_YEAR - BARISTA_CURRENT_AGE + 74,
        // The token job starts exactly where the career was authored to end, so continuing the
        // career runs straight through it.
        overlaps: [
          {
            jobId: "token",
            jobLabel: `${baristaPlan.primary.name}'s job 2`,
            jobName: null,
            fromAge: 65,
            toAge: 70,
            fromYear: SAMPLE_START_YEAR - BARISTA_CURRENT_AGE + 65,
            toYear: SAMPLE_START_YEAR - BARISTA_CURRENT_AGE + 70,
          },
        ],
      },
    ]);

    // Nothing to disclose where nothing was assumed: this household can stop inside its own
    // authored plan, so its age rests on no extra work at all.
    const unaided = solveRetirement(scenarioOf(planWithJobs([job("career", 35, 65)])), CTX);
    expect(unaided.fullRetirementAge).not.toBeNull();
    expect(unaided.continuedJobs).toEqual([]);
  });

  it("reports the AUTHORED plan's survival as a result of its own", () => {
    // The second first-class answer. It is a run of the plan exactly as written — no boundary,
    // no continuation — so it is untouched by the selection, and it answers a question the
    // search structurally cannot: "does what I actually wrote down work?"
    const comfortable = solveRetirement(scenarioOf(planWithJobs([job("career", 35, 65)])), CTX);
    expect(comfortable.authoredPlanSurvives).toBe(true);

    // Same plan, three selections, one authored answer: the choice is about hypotheticals.
    for (const chosen of ["career", null, undefined] as const) {
      const jobs = [job("career", 35, 65), job("contract", 65, 70)];
      const solved = solveRetirement(scenarioOf(planWithJobs(jobs, chosen)), CTX);
      expect(solved.authoredPlanSurvives).toBe(true);
    }

    // And it really does read the plan rather than always agreeing: the tight fixture's authored
    // jobs do not carry it to life expectancy.
    const tight = solveRetirement(
      scenarioOf({
        ...baristaPlan,
        primary: { ...baristaPlan.primary, jobs: baristaJobs, continuationJobId: "career" },
      }),
      CTX,
    );
    expect(tight.authoredPlanSurvives).toBe(false);
    // Two results, not one: this household HAS a feasible stop-all-work age even though the plan
    // it wrote down fails — the age assumes the career ran on, which the authored plan does not.
    expect(tight.fullRetirementAge).toBe(74);
  });

  it("does not reproduce the authored staggering as a solver candidate", () => {
    // Why the authored run has to exist separately. At a candidate of 70 — the plan's own last
    // year — the career is modelled as having run to 70 too, because the selection means the
    // same thing at every candidate. So the scenario the user actually wrote (career to 65, then
    // contract 65–70) appears nowhere in the candidate space, and nothing in the search speaks
    // for it.
    const jobs = [job("career", 35, 65), job("contract", 65, 70)];
    const scenario = scenarioOf(planWithJobs(jobs, "career"));

    const candidate = projectFullRetirement(scenario, 70, CTX);
    expect(wageAt(candidate, "career", monthAt(67))).toBeGreaterThan(0);

    // The authored run — the one `authoredPlanSurvives` judges — is the one that has it stopped.
    const authored = projectScenario(scenario, CTX);
    expect(wageAt(authored, "career", monthAt(67))).toBe(0);
    expect(wageAt(authored, "contract", monthAt(67))).toBeGreaterThan(0);
  });

  it("survives a state round-trip, for a named job and for None alike", () => {
    // The selection is authored, so it is persisted — a plan reloaded from disk must solve the
    // way it solved before it was saved. Asserted on the restored field AND on the answer, since
    // a field that round-trips into a shape nothing reads would pass the first check alone.
    const jobs = [job("career", 35, 65), job("contract", 65, 70)];
    const reload = (plan: Plan) =>
      Projection.fromState(
        JSON.parse(JSON.stringify(Projection.fromState(stateOf(plan), mockJurisdiction()).toState())),
        mockJurisdiction(),
      );

    const onContract = reload(planWithJobs(jobs, "contract"));
    expect(onContract.plan.primary.continuationJobId).toBe("contract");
    const previewed = onContract.runAtStopWorkingAge(mockJurisdiction(), 71).series;
    expect(wageAt(previewed, "contract", monthAt(70))).toBeGreaterThan(0);
    expect(wageAt(previewed, "career", monthAt(70))).toBe(0);

    // `null` and "never chosen" are different states, and neither may decay into the other.
    expect(reload(planWithJobs(jobs, null)).plan.primary.continuationJobId).toBeNull();
    expect(reload(planWithJobs(jobs)).plan.primary.continuationJobId).toBeUndefined();
  });

  it("records no continuation at a candidate that is exactly the selected job's own end", () => {
    // The boundary of the extension rule, from the side that must NOT fire. At 65 the career was
    // ending anyway, so nothing was assumed and the answer is unconditional — the headline may be
    // stated flat. One year later the same plan has something to disclose, which is what makes
    // this an assertion about the boundary rather than about a fixture that never continues.
    const scenario = scenarioOf(planWithJobs([job("career", 35, 65)], "career"));

    expect(continuedJobsAt(scenario, 65, CTX)).toEqual([]);
    expect(continuedJobsAt(scenario, 64, CTX)).toEqual([]);
    const [continued] = continuedJobsAt(scenario, 66, CTX);
    expect(continued?.jobId).toBe("career");
    expect(continued?.throughAge).toBe(66);
  });

  it("treats a FUTURE selected job by where the candidate falls against its own span", () => {
    // One selection, three candidates, three different meanings — and the middle one is the case
    // a "the selected job always runs to the boundary" reading gets wrong.
    const jobs = [job("bridge", 35, 45), job("future", 50, 60)];
    const scenario = scenarioOf(planWithJobs(jobs, "future"));

    // Before it starts: it never happens at all, selected or not.
    const before = projectFullRetirement(scenario, 48, CTX);
    for (const age of [48, 50, 55, 59]) expect(wageAt(before, "future", monthAt(age))).toBe(0);
    expect(continuedJobsAt(scenario, 48, CTX)).toEqual([]);

    // Inside its authored span: capped like any other job, and nothing to disclose.
    const inside = projectFullRetirement(scenario, 55, CTX);
    expect(wageAt(inside, "future", monthAt(54))).toBeGreaterThan(0);
    expect(wageAt(inside, "future", monthAt(55))).toBe(0);
    expect(continuedJobsAt(scenario, 55, CTX)).toEqual([]);

    // Past its authored end: extended, and said so.
    const after = projectFullRetirement(scenario, 65, CTX);
    expect(wageAt(after, "future", monthAt(64))).toBeGreaterThan(0);
    expect(wageAt(after, "future", monthAt(65))).toBe(0);
    const [continued] = continuedJobsAt(scenario, 65, CTX);
    expect(continued?.jobId).toBe("future");
    expect(continued?.throughAge).toBe(65);
  });

  it("pays a continued COMPLETED job from the salary it was authored with, and grows it as authored", () => {
    // "It never ended" has to be priced, and the price is the job's own authored terms — month 0
    // is the current salary verbatim, and everything after it follows that job's own growth.
    // Anything else would make a continuation a raise nobody entered.
    const completed = (realGrowthPct: number): Job => ({
      id: "past",
      ownerId: "p1",
      startYear: at(20),
      endYear: at(30),
      salary: {
        startingSalaryCents: dollarsToCents(20_000),
        currentSalaryCents: dollarsToCents(36_000),
        realGrowthPct,
      },
    });
    const seriesFor = (realGrowthPct: number) =>
      projectFullRetirement(
        scenarioOf(planWithJobs([completed(realGrowthPct), job("current", 35, 65)], "past")),
        70,
        CTX,
      );

    const flat = seriesFor(0);
    // Month 0 is the authored CURRENT salary, not the starting one it was hired at.
    expect(wageAt(flat, "past", 0)).toBe(dollarsToCents(36_000) / 12);
    // And it really is continuous from there — no gap where the job stopped.
    for (const age of [45, 55, 69]) expect(wageAt(flat, "past", monthAt(age))).toBeGreaterThan(0);
    expect(wageAt(flat, "past", monthAt(70))).toBe(0);

    // Real growth is the job's own field, and it still applies to the continued years: same
    // month 0, strictly more later. Compared against the flat job rather than against an
    // absolute figure, so this holds on whichever basis the series reports.
    const growing = seriesFor(0.02);
    expect(wageAt(growing, "past", 0)).toBe(wageAt(flat, "past", 0));
    expect(wageAt(growing, "past", monthAt(60))).toBeGreaterThan(wageAt(flat, "past", monthAt(60)));
  });

  it("keeps an explicit None through adding, removing and reordering jobs", () => {
    // `null` is a stated answer, and the initialization rule must never get a second chance at
    // it. Editing the job list is exactly when it would: the rule fires on read, so every read
    // after every edit is an opportunity to quietly replace the household's "no" with a default.
    const jobs = [job("career", 35, 65), job("side", 40, 50)];
    const p = Projection.fromState(stateOf(planWithJobs(jobs, null)), mockJurisdiction());
    expect(p.continuationJobOf("p1")).toBeNull();

    p.addJob("p1", { startYear: at(66), endYear: at(72), salary: job("x", 66, 72).salary });
    expect(p.continuationJobOf("p1")).toBeNull();
    p.removeJob("side");
    expect(p.continuationJobOf("p1")).toBeNull();

    // Order is not information: the same jobs listed the other way round still answer None.
    const reversed = planWithJobs([...jobs].reverse(), null);
    expect(continuationJobIdOf(reversed.primary, START_YEAR)).toBeNull();

    // And the answer is invented nowhere downstream: neither solver nor preview pays a month the
    // plan does not contain. Every job left is authored to end by 72, so past that a preview at
    // 75 must show no income at all — not the career run on, not the job just added run on.
    const scenario = { plan: p.plan, ledger: p.ledger };
    expect(solveRetirement(scenario, CTX).continuedJobs).toEqual([]);
    const previewed = p.runAtStopWorkingAge(mockJurisdiction(), 75).series;
    expect(incomeAt(previewed, monthAt(71))).toBeGreaterThan(0); // the added job, as authored
    for (const age of [72, 73, 74]) expect(incomeAt(previewed, monthAt(age))).toBe(0);
  });

  it("resolves to None when the selected job is DELETED, with no stale id left anywhere", () => {
    // A dangling selection must not become an unbounded extension. The authoring path clears it,
    // and every reader agrees on the cleared state — solver, preview and picker alike, which is
    // the point: a stale id that only one of them still honoured would show a household a
    // retirement age funded by a job they had removed.
    const jobs = [job("career", 35, 65), job("contract", 65, 70)];
    const p = Projection.fromState(stateOf(planWithJobs(jobs, "contract")), mockJurisdiction());
    p.removeJob("contract");

    expect(p.plan.primary.continuationJobId).toBeNull();
    expect(p.continuationJobOf("p1")).toBeNull();
    expect(JSON.stringify(p.toState())).not.toContain("contract");

    expect(solveRetirement({ plan: p.plan, ledger: p.ledger }, CTX).continuedJobs).toEqual([]);
    const previewed = p.runAtStopWorkingAge(mockJurisdiction(), 75).series;
    expect(wageAt(previewed, "career", monthAt(64))).toBeGreaterThan(0);
    expect(wageAt(previewed, "career", monthAt(65))).toBe(0);
  });

  it("answers a household with NO jobs at all, in both directions", () => {
    // Nothing to continue and nothing to overlap. A household living off its assets can stop
    // today — the earliest age there is — and one that cannot fund itself has no age at all,
    // which is a different answer from stopping today and must not be reported as one.
    const jobless = (openingDollars: number): Plan => ({
      ...samplePlan,
      primary: { ...samplePlan.primary, jobs: [], continuationJobId: null },
      openingBalanceCents: dollarsToCents(openingDollars),
    });

    const funded = solveRetirement(scenarioOf(jobless(3_000_000)), CTX);
    expect(funded.fullRetirementAge).toBe(CURRENT_AGE);
    expect(funded.continuedJobs).toEqual([]);
    // No jobs is no planned stop either — a household with no wages never stops receiving them.
    expect(funded.plannedWorkStopAge).toBeNull();

    const broke = solveRetirement(scenarioOf(jobless(0)), CTX);
    expect(broke.fullRetirementAge).toBeNull();
    expect(broke.continuedJobs).toEqual([]);
  });

  it("compiles no income for jobs the preview's own boundary falls before", () => {
    // The preview is the solved age made visible, so a candidate before every job the household
    // holds has to LOOK like it: not a job paid a token amount, not a flat line at zero drawn
    // from a compiled series — no pay path at all.
    const jobs = [job("first", 50, 60), job("second", 62, 70)];
    const p = Projection.fromState(stateOf(planWithJobs(jobs, "first")), mockJurisdiction());
    const previewed = p.runAtStopWorkingAge(mockJurisdiction(), 45).series;

    for (const age of [45, 50, 55, 62, 69]) {
      const sources = previewed.months[monthAt(age)]?.flows?.incomeSources ?? [];
      expect(sources.filter((s) => s.sourceId.startsWith("job:"))).toEqual([]);
    }
    expect(continuedJobsAt(scenarioOf(planWithJobs(jobs, "first")), 45, CTX)).toEqual([]);
  });

  it("discloses several overlaps deterministically, with no duplicate or empty window", () => {
    // A continuation can cross more than one later job, and each crossing is its own sentence.
    // The failure this guards is the shape a reader would notice first: the same job named
    // twice, or a window from 70 to 70 that says nothing at all.
    const jobs = [
      job("career", 35, 65),
      job("first", 65, 70),
      job("second", 68, 72),
      job("longAgo", 30, 34),
    ];
    const scenario = scenarioOf(planWithJobs(jobs, "career"));
    const [continued] = continuedJobsAt(scenario, 75, CTX);

    expect(continued?.overlaps).toEqual([
      {
        jobId: "first",
        jobLabel: `${samplePlan.primary.name}'s job 2`,
        jobName: null,
        fromAge: 65,
        toAge: 70,
        fromYear: at(65),
        toYear: at(70),
      },
      {
        jobId: "second",
        jobLabel: `${samplePlan.primary.name}'s job 3`,
        jobName: null,
        fromAge: 68,
        toAge: 72,
        fromYear: at(68),
        toYear: at(72),
      },
    ]);
    // The job that ended before "now" is not among them, and nothing is named twice or empty.
    const ids = continued!.overlaps.map((o) => o.jobId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const o of continued!.overlaps) expect(o.toAge).toBeGreaterThan(o.fromAge);
    // And the read is a pure function of the scenario: asking twice says the same thing.
    expect(continuedJobsAt(scenario, 75, CTX)).toEqual(continuedJobsAt(scenario, 75, CTX));
  });

  /**
   * **A continuation is only a continuation where the household was PAID.**
   *
   * Employment and income are the same thing for a person who is in the household throughout,
   * which is why this went unnoticed: every fixture above has one. A partner's wages belong to
   * this household only between joining and separating, so extending their employment past an
   * authored end can move the employment span and not one cent of income — and a sentence
   * crediting the answer to that work describes a household that does not exist.
   */
  describe("and only where the household was actually paid", () => {
    const PARTNER_ID = "p2";
    const partnerJobAt = (
      id: string,
      birthYear: number,
      startAge: number,
      endAge: number,
      annual = 60_000,
    ): Job => ({
      id,
      ownerId: PARTNER_ID,
      startYear: birthYear + startAge,
      endYear: birthYear + endAge,
      salary: {
        startingSalaryCents: dollarsToCents(annual),
        currentSalaryCents: dollarsToCents(annual),
        realGrowthPct: 0,
      },
    });

    const partnerWith = (opts: {
      birthYear?: number;
      jobs: readonly Job[];
      continuationJobId: string | null;
    }): Person => ({
      id: PARTNER_ID,
      name: "Partner",
      birthYear: opts.birthYear ?? BIRTH_YEAR,
      lifeExpectancy: samplePlan.primary.lifeExpectancy,
      benefitClaimingAge: 67,
      jobs: opts.jobs,
      continuationJobId: opts.continuationJobId,
    });

    /**
     * The partner joins at `joinMonth` and, where one is given, leaves at `separationMonth`.
     * The PRIMARY selects None throughout, so every continuation these tests see is the
     * partner's and no second extension can account for what they assert.
     */
    function membershipScenario(
      partner: Person,
      opts: { joinMonth?: number; separationMonth?: number } = {},
    ): Scenario {
      const plan = planWithJobs(samplePlan.primary.jobs, null);
      const base = createProjectionBase(plan, CTX);
      const married = addEvent(emptyLedger, base, {
        id: "r1",
        type: "RelationshipEvent",
        month: opts.joinMonth ?? 0,
        person: partner,
      });
      if (!married.ok) throw new Error(`fixture rejected: ${married.conflict}`);
      if (opts.separationMonth === undefined) return withLedger(scenarioOf(plan), married.ledger);
      const separated = addEvent(married.ledger, base, {
        id: "s1",
        type: "SeparationEvent",
        month: opts.separationMonth,
        partnerPersonId: PARTNER_ID,
        alimonyMonthlyCents: 0,
        alimonyDurationMonths: 0,
        childSupportMonthlyCents: 0,
      });
      if (!separated.ok) throw new Error(`fixture rejected: ${separated.conflict}`);
      return withLedger(scenarioOf(plan), separated.ledger);
    }

    it("says nothing about a job whose owner had already left before its authored end", () => {
      // The bug, in its plainest shape. The partner's job is authored to 65 and they separate at
      // 60, so the household's last wage from it arrives at 60 whatever the candidate is.
      // Extending the employment to 70 adds employment and adds no money — and "you could stop
      // at 70 if their job continued through 70" would credit the answer to work that funded
      // none of it.
      const partner = partnerWith({
        jobs: [partnerJobAt("pjob", BIRTH_YEAR, 35, 65)],
        continuationJobId: "pjob",
      });
      const separated = membershipScenario(partner, { separationMonth: monthAt(60) });

      expect(continuedJobsAt(separated, 70, CTX)).toEqual([]);
      expect(solveRetirement(separated, CTX).continuedJobs).toEqual([]);

      // The same partner who never leaves DOES continue — so this is the separation talking,
      // not a fixture that could never have disclosed anything.
      const together = membershipScenario(partner);
      expect(continuedJobsAt(together, 70, CTX).map((c) => c.jobId)).toEqual(["pjob"]);
    });

    it("discloses a continuation only through the last month the household is paid for it", () => {
      // The partial case: the extension does add paid months, and then the separation ends them
      // early. What is disclosed is where the money stopped — 68 — and not the boundary the
      // employment ran to.
      const partner = partnerWith({
        jobs: [partnerJobAt("pjob", BIRTH_YEAR, 35, 65)],
        continuationJobId: "pjob",
      });
      const scenario = membershipScenario(partner, { separationMonth: monthAt(68) });

      const [continued] = continuedJobsAt(scenario, 70, CTX);
      expect(continued?.jobId).toBe("pjob");
      expect(continued?.throughAge).toBe(68);
      expect(continued?.throughYear).toBe(at(68));
      // Strictly inside the candidate: the household is told when it stops being paid, not when
      // the hypothesis stops running.
      expect(continued!.throughYear).toBeLessThan(at(70));
    });

    it("counts a continuation only from the JOIN, never from employment the household missed", () => {
      // A job authored to end before the partner even joined pays this household nothing as
      // authored, so every paid month the hypothesis produces is added — but only the ones
      // inside the membership. The overlap window is where that shows: it opens at the join,
      // not at the authored end five years earlier.
      const partner = partnerWith({
        jobs: [partnerJobAt("early", BIRTH_YEAR, 20, 35), partnerJobAt("later", BIRTH_YEAR, 35, 55)],
        continuationJobId: "early",
      });
      const joined = membershipScenario(partner, { joinMonth: monthAt(45) });

      const [continued] = continuedJobsAt(joined, 70, CTX);
      expect(continued?.jobId).toBe("early");
      expect(continued?.throughAge).toBe(70);
      expect(continued?.overlaps).toEqual([
        {
          jobId: "later",
          jobLabel: "Partner's job 2",
          jobName: null,
          fromAge: 45,
          toAge: 55,
          fromYear: at(45),
          toYear: at(55),
        },
      ]);

      // And it really tracks the join: the same partner in the household from the start is paid
      // for those years, so the window opens at "now" instead.
      const [fromTheStart] = continuedJobsAt(membershipScenario(partner), 70, CTX);
      expect(fromTheStart?.overlaps[0]?.fromYear).toBe(START_YEAR);
      expect(fromTheStart?.overlaps[0]?.fromAge).toBe(CURRENT_AGE);
    });

    it("reports no overlap where two jobs overlap as EMPLOYMENT but not as household income", () => {
      // Both spans cross on paper — the continued job runs to 70 and the later one is authored
      // 50–60 — and the household is paid for neither crossing, because it is paid for the later
      // job not at all: the partner separates the year it starts. Measured on employment this
      // reports a ten-year doubling of income that never happens.
      const partner = partnerWith({
        jobs: [partnerJobAt("early", BIRTH_YEAR, 20, 35), partnerJobAt("late", BIRTH_YEAR, 50, 60)],
        continuationJobId: "early",
      });
      const scenario = membershipScenario(partner, { separationMonth: monthAt(50) });

      const [continued] = continuedJobsAt(scenario, 70, CTX);
      expect(continued?.jobId).toBe("early");
      expect(continued?.overlaps).toEqual([]);
      // Paid to the separation and no further.
      expect(continued?.throughAge).toBe(50);
    });

    it("states a genuine overlap in the OWNER's ages and the shared calendar years", () => {
      // The case that must keep working, and the one where the two clocks visibly disagree: a
      // partner five years older, joining part-way through. Every age here is theirs, every year
      // is the household's, and the pair is what lets a reader reconcile them.
      const partnerBirthYear = BIRTH_YEAR - 5;
      const partner = partnerWith({
        birthYear: partnerBirthYear,
        jobs: [
          partnerJobAt("long", partnerBirthYear, 30, 60),
          partnerJobAt("second", partnerBirthYear, 55, 65),
        ],
        continuationJobId: "long",
      });
      const scenario = membershipScenario(partner, { joinMonth: monthAt(45) });

      const [continued] = continuedJobsAt(scenario, 70, CTX);
      expect(continued?.ownerName).toBe("Partner");
      expect(continued?.jobId).toBe("long");
      // The candidate is the PRIMARY's 70 — the same calendar year is the partner's 75.
      expect(continued?.throughYear).toBe(at(70));
      expect(continued?.throughAge).toBe(75);
      expect(continued?.overlaps).toEqual([
        {
          jobId: "second",
          jobLabel: "Partner's job 2",
          jobName: null,
          fromAge: 60,
          toAge: 65,
          fromYear: partnerBirthYear + 60,
          toYear: partnerBirthYear + 65,
        },
      ]);
    });

    it("stops two differently-aged earners at ONE calendar boundary, each disclosed in their own years", () => {
      // One household, one stop — the boundary is a calendar year precisely so a five-year age
      // gap cannot make the two of them retire at different moments. The headline stays the
      // primary's age; each continued job is stated in its owner's, once, with no second copy
      // to contradict it.
      const partnerBirthYear = BIRTH_YEAR - 5;
      const partner = partnerWith({
        birthYear: partnerBirthYear,
        jobs: [partnerJobAt("theirs", partnerBirthYear, 30, 60)],
        continuationJobId: "theirs",
      });
      const base = createProjectionBase(planWithJobs(samplePlan.primary.jobs, "job-main"), CTX);
      const married = addEvent(emptyLedger, base, {
        id: "r1",
        type: "RelationshipEvent",
        month: 0,
        person: partner,
      });
      if (!married.ok) throw new Error(`fixture rejected: ${married.conflict}`);
      const scenario = withLedger(
        scenarioOf(planWithJobs(samplePlan.primary.jobs, "job-main")),
        married.ledger,
      );

      const continued = continuedJobsAt(scenario, 70, CTX);
      expect(continued.map((c) => c.ownerId)).toEqual(["p1", PARTNER_ID]);
      // One owner, one sentence: nothing is disclosed twice.
      expect(new Set(continued.map((c) => c.ownerId)).size).toBe(continued.length);
      // The same calendar year for both, and each in their own age — 70 and 75.
      expect(continued.map((c) => c.throughYear)).toEqual([at(70), at(70)]);
      expect(continued.map((c) => c.throughAge)).toEqual([70, 75]);

      // And the projection really does stop them together, in that year.
      const series = projectFullRetirement(scenario, 70, CTX);
      expect(wageAt(series, "job-main", monthAt(70) - 1)).toBeGreaterThan(0);
      expect(wageAt(series, "theirs", monthAt(70) - 1)).toBeGreaterThan(0);
      expect(wageAt(series, "job-main", monthAt(70))).toBe(0);
      expect(wageAt(series, "theirs", monthAt(70))).toBe(0);
    });
  });
});

/**
 * The rule that answers "which job would continue?" for a household that has never been asked —
 * see {@link continuationJobIdOf}. It runs on READ, so it follows the jobs a person holds today
 * rather than freezing an answer at the moment their plan was created (for the primary, before a
 * single job existed), and it never displaces a choice already made.
 *
 * Pinned directly on the rule rather than through a projection: every case here is about which
 * id comes out, and routing that through a simulation would test the wiring instead.
 */
describe("continuationJobIdOf — what a household that never chose gets", () => {
  const NOW = 2000;
  const job = (id: string, startYear: number, endYear: number): Job => ({
    id,
    ownerId: "p1",
    startYear,
    endYear,
    salary: { startingSalaryCents: 1, currentSalaryCents: 1, realGrowthPct: 0 },
  });
  const person = (jobs: readonly Job[], continuationJobId?: string | null): Person => ({
    id: "p1",
    name: "A",
    birthYear: 1960,
    lifeExpectancy: samplePlan.primary.lifeExpectancy,
    benefitClaimingAge: 67,
    jobs,
    ...(continuationJobId !== undefined ? { continuationJobId } : {}),
  });

  it("picks the job they are working NOW", () => {
    const jobs = [job("past", 1980, 1990), job("current", 1995, 2020), job("later", 2020, 2030)];
    expect(continuationJobIdOf(person(jobs), NOW)).toBe("current");
  });

  it("picks the earliest job still to START when none is running yet", () => {
    const jobs = [job("soon", 2005, 2030), job("later", 2010, 2040)];
    expect(continuationJobIdOf(person(jobs), NOW)).toBe("soon");
  });

  it("picks nothing when every job is behind them", () => {
    // Re-entering finished employment is not something to assume on a person's behalf. Those
    // jobs stay selectable; they are simply never chosen for them.
    expect(continuationJobIdOf(person([job("past", 1980, 1990)]), NOW)).toBeNull();
    expect(continuationJobIdOf(person([]), NOW)).toBeNull();
  });

  it("resolves several concurrent jobs to the latest-ending one, deterministically", () => {
    // Arbitrary between equals, which is exactly why it is stated: the job they would still be
    // in once the others finish. An exact tie falls to the first authored.
    const jobs = [job("short", 1995, 2010), job("long", 1998, 2025)];
    expect(continuationJobIdOf(person(jobs), NOW)).toBe("long");
    expect(continuationJobIdOf(person([...jobs].reverse()), NOW)).toBe("long");
    const tied = [job("first", 1995, 2020), job("second", 1998, 2020)];
    expect(continuationJobIdOf(person(tied), NOW)).toBe("first");
  });

  it("never revisits a choice already made — including None", () => {
    // The stability guarantee the picker depends on. Adding a job that WOULD have won the
    // initialization rule changes nothing, because the rule does not run once someone has
    // answered.
    const current = job("current", 1995, 2020);
    expect(continuationJobIdOf(person([current], "current"), NOW)).toBe("current");
    const withNewer = person([current, job("newer", 1998, 2030)], "current");
    expect(continuationJobIdOf(withNewer, NOW)).toBe("current");
    expect(continuationJobIdOf(person([current, job("newer", 1998, 2030)], null), NOW)).toBeNull();
  });

  it("reads a selection whose job is gone as None, never as an unbounded extension", () => {
    // The authoring path clears the selection with the job it named, so this only catches a
    // state restored from outside — where a dangling id must not become licence to work forever.
    expect(continuationJobIdOf(person([job("current", 1995, 2020)], "deleted"), NOW)).toBeNull();
  });
});

describe("solveRetirement — horizonAnchor names the longest-lived member", () => {
  // samplePlan: primary age 40, expectancy 85. The anchor is whose expectancy the run ends at.
  const anchorOf = (scenario: Scenario) => solveRetirement(scenario, CTX).horizonAnchor;

  const samPartner = (over: PartnerOverrides): Person => ({
    id: "p2",
    name: "Sam",
    birthYear: PRIMARY_BIRTH_YEAR,
    lifeExpectancy: samplePlan.primary.lifeExpectancy,
    benefitClaimingAge: 67,
    jobs: [],
    ...over,
  });

  function withPartner(partner: Person, separateAtMonth?: number): Scenario {
    const base = createProjectionBase(samplePlan, CTX);
    const married = addEvent(emptyLedger, base, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: partner,
    });
    if (!married.ok) throw new Error(`fixture rejected: ${married.conflict}`);
    let ledger = married.ledger;
    if (separateAtMonth !== undefined) {
      const separated = addEvent(ledger, base, {
        id: "s1",
        type: "SeparationEvent",
        month: separateAtMonth,
        partnerPersonId: partner.id,
        alimonyMonthlyCents: 0,
        alimonyDurationMonths: 0,
        childSupportMonthlyCents: 0,
      });
      if (!separated.ok) throw new Error(`fixture rejected: ${separated.conflict}`);
      ledger = separated.ledger;
    }
    return withLedger(scenarioOf(samplePlan), ledger);
  }

  it("names the primary (null) when nobody outlives them", () => {
    expect(anchorOf(scenarioOf(samplePlan))).toEqual({ age: 85, memberName: null });
  });

  it("names a younger partner who outlives the primary, at their own stated expectancy", () => {
    // Born 10 years after the primary, same expectancy age 85 → reaches it in a later calendar
    // year, so the run ends at Sam's 85, not the primary's.
    expect(anchorOf(withPartner(samPartner({ birthYear: PRIMARY_BIRTH_YEAR + 10 })))).toEqual({
      age: 85,
      memberName: "Sam",
    });
  });

  it("honours a partner's own stated expectancy over the household default", () => {
    expect(
      anchorOf(withPartner(samPartner({ birthYear: PRIMARY_BIRTH_YEAR + 10, lifeExpectancy: 95 }))),
    ).toEqual({ age: 95, memberName: "Sam" });
  });

  it("falls back to the primary when the partner would die first", () => {
    expect(anchorOf(withPartner(samPartner({ birthYear: PRIMARY_BIRTH_YEAR - 10 })))).toEqual({
      age: 85,
      memberName: null,
    });
  });

  // The anchor names whoever the SIM ran to, so it applies the same both-alive rule
  // (`memberHorizonReach`) that `buildHouseholdInput` does. Sam is born ten years after the
  // primary at the same expectancy 85, so the primary dies at month 540 and Sam at 660, and the
  // boundary a separation has to beat is the primary's 540.
  describe("a separation removes the anchor only while both are alive", () => {
    const younger = () => samPartner({ birthYear: PRIMARY_BIRTH_YEAR + 10 });
    const PRIMARY_DEATH_MONTH = (85 - 40) * 12; // 540

    it("BEFORE either death: Sam leaves, so the primary anchors", () => {
      expect(anchorOf(withPartner(younger(), 12))).toEqual({ age: 85, memberName: null });
      expect(anchorOf(withPartner(younger(), PRIMARY_DEATH_MONTH - 1))).toEqual({
        age: 85,
        memberName: null,
      });
    });

    it("EXACTLY AT the first death: too late to happen, so Sam still anchors", () => {
      expect(anchorOf(withPartner(younger(), PRIMARY_DEATH_MONTH))).toEqual({
        age: 85,
        memberName: "Sam",
      });
    });

    it("AFTER the first death: Sam anchors — they never left while alive", () => {
      expect(anchorOf(withPartner(younger(), 600))).toEqual({ age: 85, memberName: "Sam" });
      expect(anchorOf(withPartner(younger(), 700))).toEqual({ age: 85, memberName: "Sam" });
    });
  });
});
