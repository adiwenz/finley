/**
 * Issue #64/#72: the first-class Job/Person standing model — the sole source of
 * truth for earned income now that the scalar `incomeCents` path is deleted. These
 * pin the §5/§66 open-ended-job semantics and that the pre-"now" covered-earnings
 * record falls directly out of the jobs.
 */
import { describe, it, expect } from "vitest";
import { emptyLedger, replayLedger, nullJurisdiction } from "./index";
import { createProjectionBase, PRIMARY_PERSON_ID, type ProjectionContext } from "./projectionBase";
import { samplePlan, careerJob } from "./testing/samplePlan";
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

/** The sample plan's single open-ended career job (real-flat salary, deferral on it). */
const openEndedJob: Job = careerJob(dollarsToCents(8000), { deferralFraction: 0.1 });

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
      benefitClaimingAge: samplePlan.benefitClaimingAge,
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
      benefitClaimingAge: samplePlan.benefitClaimingAge,
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

  it("computes pre-'now' earnings directly from the jobs (§4.6)", () => {
    const base = createProjectionBase({ ...samplePlan, jobs: [openEndedJob] }, ctx());
    const prior = base.initialPersons![0].priorEarningsCents!;
    // The record covers exactly the pre-"now" working years [careerStart … now).
    expect(Object.keys(prior).length).toBeGreaterThan(0);
    // Sim still starts at "now" — no pre-"now" months are simulated (§4.6).
    expect(project({ ...samplePlan, jobs: [openEndedJob] }).months[0].month).toBe(0);
  });

  it("derives a real growth rate from two salary points", () => {
    // Doubling in real terms over 10 years ≈ 7.18%/yr.
    expect(deriveRealGrowthPct(100, 2020, 200, 2030)).toBeCloseTo(7.177, 2);
    expect(deriveRealGrowthPct(100, 2020, 100, 2020)).toBe(0);
  });
});
