/**
 * `flows.wagesByOwner` across a run: the engine's statement of what each person earns from work
 * in a given month, checked against JOB SPANS rather than against authored job records.
 *
 * The spans are the whole point. Every consumer that answered "what do you earn now?" by adding
 * up the plan's jobs got the same three cases wrong — a job that already ended kept paying, one
 * that has not started paid early, and its deferral election tugged a blend it has no part in.
 * So the cases live here, at the layer that owns the answer, and not in a panel's rendered HTML.
 */
import { describe, expect, it } from "vitest";
import { Projection } from "../facade/projectionFacade";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { dollarsToCents } from "../money/cashFlowSeries";
import { RETIREMENT_ID } from "../plan/ids";
import { SAMPLE_START_YEAR, salariedJob, samplePlan, stateOf } from "../testing/samplePlan";
import type { Job } from "../job/job";
import type { Plan } from "../plan/plan";
import { EMPTY_MONTHLY_WAGES } from "./simulate.types";

/** The fixture's current job: $8,000/mo, flat in real terms, electing 10%. */
const CURRENT_JOB = salariedJob(dollarsToCents(8_000), { deferralFraction: 0.1 });

/** Long over: it stopped paying five years before the run's first month. */
const PAST_JOB: Job = {
  id: "job-past",
  ownerId: "p1",
  startYear: SAMPLE_START_YEAR - 20,
  endYear: SAMPLE_START_YEAR - 5,
  salary: {
    startingSalaryCents: dollarsToCents(30_000) * 12,
    currentSalaryCents: dollarsToCents(30_000) * 12,
    realGrowthPct: 0,
  },
};

/** Not started: a planned move five years out, electing half its pay to retirement. */
const FUTURE_JOB: Job = {
  id: "job-future",
  ownerId: "p1",
  startYear: SAMPLE_START_YEAR + 5,
  endYear: SAMPLE_START_YEAR + 10,
  salary: {
    startingSalaryCents: dollarsToCents(20_000) * 12,
    currentSalaryCents: dollarsToCents(20_000) * 12,
    realGrowthPct: 0,
  },
  deferral: { deferralFraction: 0.5, fundAccountId: RETIREMENT_ID },
};

function wagesAt(jobs: readonly Job[], month: number) {
  const plan: Plan = { ...samplePlan, primary: { ...samplePlan.primary, jobs } };
  const months = Projection.fromState(stateOf(plan), nullJurisdiction).run(nullJurisdiction).series.months;
  return months[month]?.flows?.wagesByOwner["p1"] ?? EMPTY_MONTHLY_WAGES;
}

describe("wagesByOwner — only the jobs paying in that month", () => {
  it("reports the current job's pay, deferral and count on its own", () => {
    expect(wagesAt([CURRENT_JOB], 0)).toEqual({
      jobCount: 1,
      grossCents: dollarsToCents(8_000),
      deferralCents: dollarsToCents(800),
      deferralFraction: 0.1,
    });
  });

  it("leaves an already-ended job out of both the pay and the job count", () => {
    // $30,000/mo that stopped five years ago is not income now, and the job behind it is not
    // one of the jobs paying now — the reading is identical to the plan without it.
    expect(wagesAt([CURRENT_JOB, PAST_JOB], 0)).toEqual(wagesAt([CURRENT_JOB], 0));
  });

  it("leaves a not-yet-started job out, and its election out of the blend", () => {
    // The future job elects 50%; the blend stays at the current job's 10% because a job that
    // paid nothing defers nothing and weighs nothing.
    expect(wagesAt([CURRENT_JOB, FUTURE_JOB], 0)).toEqual(wagesAt([CURRENT_JOB], 0));
  });

  it("counts the future job once it starts paying, blending the two elections by pay", () => {
    const startMonth = 5 * 12;
    // Stated against the same month with each job ALONE rather than against literal dollars:
    // five years of CPI have moved the pay by then, and what is under test is the rollup, not
    // the raise schedule.
    const both = wagesAt([CURRENT_JOB, FUTURE_JOB], startMonth);
    const current = wagesAt([CURRENT_JOB], startMonth);
    const future = wagesAt([FUTURE_JOB], startMonth);
    expect(both.jobCount).toBe(2);
    expect(both.grossCents).toBe(current.grossCents + future.grossCents);
    expect(both.deferralCents).toBe(current.deferralCents + future.deferralCents);
    // Weighted by pay: the larger, 50%-electing job pulls the blend well past the midpoint of
    // the two elections (30%), which is what an unweighted average would have reported.
    expect(both.deferralFraction).toBeCloseTo(both.deferralCents / both.grossCents, 10);
    expect(both.deferralFraction).toBeGreaterThan(0.35);
  });

  it("reports no wages at all once every job has ended", () => {
    // A month past the current job's end: nothing banded, so the owner has no entry and a
    // consumer reads the empty record rather than stale pay.
    const afterEveryJob = (SAMPLE_START_YEAR + 25 - SAMPLE_START_YEAR) * 12;
    expect(wagesAt([CURRENT_JOB], afterEveryJob)).toEqual(EMPTY_MONTHLY_WAGES);
  });
});
