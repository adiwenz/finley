/**
 * Slice 1 (issue #64): the first-class Job/Person standing model and its
 * additive compilation into the existing Household pipeline. New coverage only —
 * the scalar path's own tests are untouched.
 *
 * The headline pin: a single open-ended job authored to mirror the scalar model
 * produces a `simulateHousehold` output that is equal to the scalar model's,
 * month-for-month. The discriminating variant proves the branch actually reads
 * the jobs (a deliberately wrong scalar `incomeCents` still yields the job's
 * result).
 */
import { describe, it, expect } from "vitest";
import { emptyLedger, replayLedger, nullJurisdiction } from "./index";
import { createProjectionBase, PRIMARY_PERSON_ID, RETIREMENT_ID, type ProjectionContext } from "./projectionBase";
import { samplePlan } from "./testing/samplePlan";
import { deriveRealGrowthPct, type Job } from "./job";
import type { Person } from "./person";
import { compilePersonIncomeSeries } from "./compilePerson";
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
 * A single open-ended job that reproduces `samplePlan`'s scalar income exactly:
 * flat-real salary (grows only with CPI), starting the same year the scalar
 * career start age implies, ending at the scalar retirement age (null-end), and
 * deferring the same fraction into the same retirement account.
 */
const openEndedJob: Job = {
  id: "job-main",
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

describe("Job/Person standing model — additive compilation (issue #64)", () => {
  it("allows any number of open-ended (null-end) jobs — no elevated career job (§5, issue #66)", () => {
    const birthYear = START_YEAR - samplePlan.currentAge;
    // Two open-ended jobs is legal now: neither is elevated over the other, and both
    // compile to forward income ending at the owner's retirementTargetAge.
    const person: Person = {
      id: PRIMARY_PERSON_ID,
      name: "P",
      birthYear,
      retirementTargetAge: samplePlan.retirementAge,
      ssClaimingAge: samplePlan.ssClaimingAge,
      jobs: [openEndedJob, { ...openEndedJob, id: "job-2" }],
    };
    const series = compilePersonIncomeSeries(person, START_YEAR, samplePlan.inflationPct / 100);
    expect(series).toHaveLength(2);
    const retireEndMonth = (samplePlan.retirementAge - samplePlan.currentAge) * 12 - 1;
    expect(series.every((s) => s.series.endMonth === retireEndMonth)).toBe(true);
  });

  it("retirementTargetAge is the per-person input that sets an open-ended job's end (§5, issue #66)", () => {
    const birthYear = START_YEAR - samplePlan.currentAge;
    const base: Person = {
      id: PRIMARY_PERSON_ID,
      name: "P",
      birthYear,
      retirementTargetAge: samplePlan.retirementAge,
      ssClaimingAge: samplePlan.ssClaimingAge,
      jobs: [openEndedJob],
    };
    const openEndedEndMonth = (age: number) =>
      compilePersonIncomeSeries(
        { ...base, retirementTargetAge: age },
        START_YEAR,
        samplePlan.inflationPct / 100,
      )[0].series.endMonth;
    // The open-ended (null-end) job's forward income stops the month before the owner
    // turns `retirementTargetAge` — the input alone moves the end; nothing else changes.
    expect(openEndedEndMonth(60)).toBe((60 - samplePlan.currentAge) * 12 - 1);
    expect(openEndedEndMonth(65)).toBe((65 - samplePlan.currentAge) * 12 - 1);
    expect(openEndedEndMonth(65)).toBeGreaterThan(openEndedEndMonth(60) as number);
  });

  it("a single open-ended job matches the scalar model month-for-month", () => {
    const scalar = project(samplePlan);
    const jobbed = project({ ...samplePlan, jobs: [openEndedJob] });
    expect(jobbed).toEqual(scalar);
  });

  it("actually compiles jobs, not the scalar income (bogus incomeCents is ignored when jobs are present)", () => {
    const scalar = project(samplePlan);
    const jobbed = project({ ...samplePlan, incomeCents: dollarsToCents(1), jobs: [openEndedJob] });
    expect(jobbed).toEqual(scalar);
  });

  it("computes pre-'now' earnings directly from jobs, matching the scalar seed", () => {
    const scalarBase = createProjectionBase(samplePlan, ctx());
    const jobbedBase = createProjectionBase({ ...samplePlan, jobs: [openEndedJob] }, ctx());
    expect(jobbedBase.initialPersons![0].priorEarningsCents).toEqual(
      scalarBase.initialPersons![0].priorEarningsCents,
    );
    // Sim still starts at "now" — no pre-"now" months are simulated (§4.6).
    expect(project({ ...samplePlan, jobs: [openEndedJob] }).months[0].month).toBe(0);
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
