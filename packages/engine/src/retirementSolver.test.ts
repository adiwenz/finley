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
import { scenarioOf, withLedger } from "./scenario";
import { addEvent } from "./ledger/addEvent";
import { emptyLedger } from "./ledger/ledger";
import { dollarsToCents } from "./cashFlowSeries";
import { createProjectionBase } from "./projectionBase";
import { RETIREMENT_ID } from "./ids";
import type { ProjectionContext } from "./projectionBase";
import { mockJurisdiction } from "./testing/mockJurisdiction";
import { samplePlan, baristaPlan, salariedJob, SAMPLE_START_YEAR } from "./testing/samplePlan";
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
