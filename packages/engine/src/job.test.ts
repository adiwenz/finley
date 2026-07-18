/**
 * Slice 1 (issue #64): the first-class Job/Person standing model and its
 * additive lowering into the existing Household pipeline. New coverage only —
 * the scalar path's own tests are untouched.
 *
 * The headline pin: a single career job authored to mirror the scalar model
 * produces a `simulateHousehold` output that is equal to the scalar model's,
 * month-for-month. The discriminating variant proves the branch actually reads
 * the jobs (a deliberately wrong scalar `incomeCents` still yields the job's
 * result).
 */
import { describe, it, expect } from "vitest";
import { emptyLedger, replayLedger, nullJurisdiction } from "./index";
import { createProjectionBase, PRIMARY_PERSON_ID, RETIREMENT_ID, type ProjectionContext } from "./projectionBase";
import { samplePlan } from "./testing/samplePlan";
import { deriveRealGrowthPct, careerJobOf, type Job, type Person } from "./job";
import type { Plan } from "./plan";
import { dollarsToCents } from "./cashFlowSeries";

const START_YEAR = 2026;

function ctx(): ProjectionContext {
  return { jurisdiction: nullJurisdiction, startYear: START_YEAR };
}

function project(plan: Plan) {
  return replayLedger(emptyLedger, createProjectionBase(plan, ctx()), nullJurisdiction);
}

/**
 * The single career job that reproduces `samplePlan`'s scalar income exactly:
 * flat-real salary (grows only with CPI), starting the same year the scalar
 * career start age implies, ending at the scalar retirement age (null-end), and
 * deferring the same fraction into the same retirement account.
 */
const careerJob: Job = {
  id: "job-career",
  owners: [PRIMARY_PERSON_ID],
  startYear: START_YEAR - (samplePlan.currentAge - samplePlan.careerStartAge),
  endYear: null,
  salary: {
    startingSalaryCents: samplePlan.incomeCents * 12, // annual, today's dollars
    realGrowthPct: 0,
  },
  deferral: {
    deferralFraction: samplePlan.retirementDeferralPct / 100,
    fundAccountId: RETIREMENT_ID,
  },
};

describe("Job/Person standing model — additive lowering (issue #64)", () => {
  it("holds ≥0 jobs with spans; career job is the ≤1 null-end job", () => {
    const person: Person = {
      id: PRIMARY_PERSON_ID,
      name: "P",
      birthYear: START_YEAR - samplePlan.currentAge,
      retirementTargetAge: samplePlan.retirementAge,
      ssClaimingAge: samplePlan.ssClaimingAge,
      jobs: [careerJob, { ...careerJob, id: "job-side", endYear: START_YEAR + 3 }],
    };
    expect(careerJobOf(person)?.id).toBe("job-career");
    expect(careerJobOf({ ...person, jobs: [] })).toBeUndefined();
    // Two null-end jobs is a hard model violation.
    expect(() => careerJobOf({ ...person, jobs: [careerJob, { ...careerJob, id: "j2" }] })).toThrow();
  });

  it("a single career job matches the scalar model month-for-month", () => {
    const scalar = project(samplePlan);
    const jobbed = project({ ...samplePlan, jobs: [careerJob] });
    expect(jobbed).toEqual(scalar);
  });

  it("actually lowers jobs, not the scalar income (bogus incomeCents is ignored when jobs are present)", () => {
    const scalar = project(samplePlan);
    const jobbed = project({ ...samplePlan, incomeCents: dollarsToCents(1), jobs: [careerJob] });
    expect(jobbed).toEqual(scalar);
  });

  it("computes pre-'now' earnings directly from jobs, matching the scalar seed", () => {
    const scalarBase = createProjectionBase(samplePlan, ctx());
    const jobbedBase = createProjectionBase({ ...samplePlan, jobs: [careerJob] }, ctx());
    expect(jobbedBase.initialPersons![0].priorEarningsCents).toEqual(
      scalarBase.initialPersons![0].priorEarningsCents,
    );
    // Sim still starts at "now" — no pre-"now" months are simulated (§4.6).
    expect(project({ ...samplePlan, jobs: [careerJob] }).months[0].month).toBe(0);
  });

  it("an empty jobs list falls through to the scalar path", () => {
    const scalar = project(samplePlan);
    const emptyJobs = project({ ...samplePlan, jobs: [] });
    expect(emptyJobs).toEqual(scalar);
  });

  it("derives a real growth rate from two salary points", () => {
    // Doubling in real terms over 10 years ≈ 7.18%/yr.
    expect(deriveRealGrowthPct(100, 2020, 200, 2030)).toBeCloseTo(7.177, 2);
    expect(deriveRealGrowthPct(100, 2020, 100, 2020)).toBe(0);
  });
});
