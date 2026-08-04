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
} from "./retirementSolver";
import { continuationJobIdOf } from "./householdJob";
import { scenarioOf, withLedger } from "./scenario";
import { addEvent } from "./ledger/addEvent";
import { emptyLedger } from "./ledger/ledger";
import { dollarsToCents } from "./cashFlowSeries";
import { createProjectionBase } from "./projectionBase";
import { RETIREMENT_ID } from "./ids";
import type { ProjectionContext } from "./projectionBase";
import { mockJurisdiction } from "./testing/mockJurisdiction";
import { samplePlan, baristaPlan, salariedJob, stateOf, SAMPLE_START_YEAR } from "./testing/samplePlan";
import { Projection } from "./projectionFacade";
import type { Plan } from "./plan";
import type { Person } from "./person";
import type { Job } from "./job";
import type { Scenario } from "./scenario";
import type { ProjectionSeries } from "./projection/simulate";

const START_YEAR = SAMPLE_START_YEAR;
const CTX: ProjectionContext = { jurisdiction: mockJurisdiction(), startYear: START_YEAR };

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
    for (let age = samplePlan.currentAge; age <= samplePlan.lifeExpectancy; age++) {
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
    expect(age as number).toBeGreaterThan(tight.retirementAge);
    // And it is a real threshold, not an artefact: one year earlier does not survive.
    expect(survivesAt(tight, age as number)).toBe(true);
    expect(survivesAt(tight, (age as number) - 1)).toBe(false);
    // The authored plan never moved.
    expect(tight.jobs[0]!.endYear).toBe(SAMPLE_START_YEAR - tight.currentAge + 60);
  });

  it("returns null when even working to life expectancy fails", () => {
    const broke: Plan = { ...samplePlan, openingBalanceCents: 0, jobs: [] };
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
      jobs: [salariedJob(dollarsToCents(8000), { deferralFraction: 0.1, endAge: samplePlan.lifeExpectancy })],
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
    const broke: Plan = { ...samplePlan, openingBalanceCents: 0, jobs: [] };
    const series = projectScenario(scenarioOf(broke), CTX);
    // Precondition: the plan really does produce null net-worth months.
    expect(series.months.some((m) => m.netWorthRealCents === null)).toBe(true);
    expect(planSurvives(series)).toBe(false);
  });
});

describe("retirementSolver — target mode", () => {
  // evaluateFullRetirementAtAge reports only at-that-age facts (feasible + on-track);
  // nearestFeasibleAge is composed by retirementView from the headline, covered there.
  it("is 100% and feasible at a comfortably-fundable pinned age", () => {
    // Life expectancy is the safest possible pin: feasible if any age is.
    const evaluation = evaluateFullRetirementAtAge(scenarioOf(samplePlan), samplePlan.lifeExpectancy, CTX);
    expect(evaluation.feasible).toBe(true);
    expect(evaluation.onTrackFraction).toBe(1);
  });

  it("is a fraction in (0,1) short of a barely-infeasible pinned age", () => {
    const floor = earliestFullRetirementAge(scenarioOf(samplePlan), CTX) as number;
    const evaluation = evaluateFullRetirementAtAge(scenarioOf(samplePlan), floor - 1, CTX);
    expect(evaluation.feasible).toBe(false);
    expect(evaluation.onTrackFraction).toBeGreaterThan(0);
    expect(evaluation.onTrackFraction).toBeLessThan(1);
  });
});

describe("retirementSolver — one retirement search", () => {
  // There is one search: cease every job at the candidate age. A second, "partial" one used to
  // sit beside it, ending only the jobs with no authored end while the rest kept paying — a
  // distinction that needed open-ended jobs to exist as a category. Every job states its own
  // end now, so there is nothing to tell apart.
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

  it("is strictly harder to stop earlier than the jobs' own ends — a later age never hurts", () => {
    // What the two-age split used to express, as one property of the single search: a plan
    // whose jobs run to 60 and 75 cannot be made to survive an earlier stop by dropping less,
    // because there is no "less" any more. The threshold is the threshold.
    const scenario = scenarioOf(baristaPlan);
    const age = earliestFullRetirementAge(scenario, CTX) as number;
    expect(age).not.toBeNull();
    for (let later = age; later <= baristaPlan.lifeExpectancy; later++) {
      expect(evaluateFullRetirementAtAge(scenario, later, CTX).feasible).toBe(true);
    }
  });

  it("reports the planned work-stop age as the age the household's own jobs stop paying", () => {
    // max job endYear across the household is the barista's (birthYear + 75) → age 75.
    const solution = solveRetirement(scenarioOf(baristaPlan), CTX);
    expect(solution.plannedWorkStopAge).toBe(75);
  });
});

/** Primary's birth year in every solver test below: SAMPLE_START_YEAR − samplePlan.currentAge. */
const PRIMARY_BIRTH_YEAR = START_YEAR - samplePlan.currentAge;

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

  function partnerWith(overrides: Partial<Person> & { jobs: Job[] }): Person {
    return {
      id: "p2",
      name: "Partner",
      birthYear: PRIMARY_BIRTH_YEAR,
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

  function partnerWith(overrides: Partial<Person> & { jobs: Job[] }): Person {
    return {
      id: "p2",
      name: "Partner",
      birthYear: PRIMARY_BIRTH_YEAR,
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
    // Primary's only job is open-ended, natural end birthYear + 60 (samplePlan.retirementAge)
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
    const scenario = twoEarnerScenario(
      partnerWith({ birthYear: PRIMARY_BIRTH_YEAR - 10, jobs: [partnerJob()] }),
    );
    expect(solveRetirement(scenario, CTX).plannedWorkStopAge).toBe(80);
  });

  it("a partner job is read via its authored endYear, and nothing else", () => {
    const explicitEndYear = PRIMARY_BIRTH_YEAR + 95; // later than every other job here
    const scenario = twoEarnerScenario(
      partnerWith({ jobs: [partnerJob({ endYear: explicitEndYear })] }),
    );
    expect(solveRetirement(scenario, CTX).plannedWorkStopAge).toBe(95);
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
    // job ends at `samplePlan.retirementAge`. The household's final wage is the primary's.
    const scenario = separatedScenario(
      partnerWith({ jobs: [partnerJob()] }),
      12,
    );
    expect(solveRetirement(scenario, CTX).plannedWorkStopAge).toBe(samplePlan.retirementAge);
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
  const monthAt = (age: number) => (age - samplePlan.currentAge) * 12;

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
    jobs,
    ...(continuationJobId !== undefined ? { continuationJobId } : {}),
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
    const birthYear = START_YEAR - baristaPlan.currentAge;
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
        scenarioOf({ ...baristaPlan, jobs: baristaJobs, continuationJobId: chosen }),
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

  it("still truncates normally at a candidate age INSIDE the authored plan", () => {
    // Below the plan's own end nothing is extended, whoever was selected — the question is only
    // how much of the authored plan survives. In particular the selected job, which here ends
    // EARLY, is not pulled forward to cover the later job's years: asked about stopping at 68,
    // the career does not come back for the three years the contract was going to fill.
    const jobs = [job("career", 35, 65), job("contract", 65, 70)];
    const series = projectFullRetirement(scenarioOf(planWithJobs(jobs, "career")), 68, CTX);

    expect(wageAt(series, "career", monthAt(64))).toBeGreaterThan(0);
    expect(wageAt(series, "career", monthAt(65))).toBe(0); // its own end, not stretched to 68
    expect(wageAt(series, "contract", monthAt(67))).toBeGreaterThan(0);
    expect(wageAt(series, "contract", monthAt(68))).toBe(0); // cut at the candidate
  });

  it("lets a COMPLETED job be the selection", () => {
    // A job already behind them is a legitimate answer — "I could go back to that" is knowledge
    // the plan does not have — so it is honoured rather than quietly ignored. Note what carrying
    // one means in a model where a job is one continuous span: it resumes from now, alongside
    // whatever else is running, not only for the years past the authored plan. That is the same
    // overlap the spec's own career-plus-contract example produces, made more visible.
    const jobs = [job("past", 25, 30, 20_000), job("current", 35, 65)];
    const series = projectFullRetirement(scenarioOf(planWithJobs(jobs, "past")), 70, CTX);

    expect(wageAt(series, "past", monthAt(69))).toBeGreaterThan(0);
    expect(wageAt(series, "past", monthAt(70))).toBe(0);
    // And the unselected job still stops exactly where it was authored to.
    expect(wageAt(series, "current", monthAt(65))).toBe(0);
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
  });

  it("discloses the job a solved age assumed would continue", () => {
    // The age alone hides its premise: 74 means something different if it quietly took nine
    // years of work past the plan. `continuedJobs` is read back off the resolution the run
    // performed, so it names a job exactly when the projection really did pay it for years the
    // plan does not contain.
    const solved = solveRetirement(
      scenarioOf({ ...baristaPlan, jobs: baristaJobs, continuationJobId: "career" }),
      CTX,
    );
    expect(solved.fullRetirementAge).toBe(74);
    // Named the way the income legend names it — its own title if it has one, else its
    // OWNER's, never the minted id, which would mean nothing beside a retirement age.
    expect(solved.continuedJobs).toEqual([
      {
        jobId: "career",
        jobLabel: `${baristaPlan.name}'s job 1`,
        ownerId: "p1",
        ownerName: baristaPlan.name,
      },
    ]);

    // Nothing to disclose where nothing was assumed: this household can stop inside its own
    // authored plan, so its age rests on no extra work at all.
    const unaided = solveRetirement(scenarioOf(planWithJobs([job("career", 35, 65)])), CTX);
    expect(unaided.fullRetirementAge).not.toBeNull();
    expect(unaided.continuedJobs).toEqual([]);
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
    expect(onContract.plan.continuationJobId).toBe("contract");
    const previewed = onContract.runAtStopWorkingAge(mockJurisdiction(), 71).series;
    expect(wageAt(previewed, "contract", monthAt(70))).toBeGreaterThan(0);
    expect(wageAt(previewed, "career", monthAt(70))).toBe(0);

    // `null` and "never chosen" are different states, and neither may decay into the other.
    expect(reload(planWithJobs(jobs, null)).plan.continuationJobId).toBeNull();
    expect(reload(planWithJobs(jobs)).plan.continuationJobId).toBeUndefined();
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
