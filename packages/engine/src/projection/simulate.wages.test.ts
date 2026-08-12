/**
 * `flows.wagesByOwner` as a projection reads it: the engine's statement of what each person
 * earns from work in a given month, checked against JOB SPANS rather than authored job records.
 *
 * The spans are the whole point. Every consumer that answered "what do you earn now?" by adding
 * up the plan's jobs got the same three cases wrong — a job that already ended kept paying, one
 * that has not started paid early, and its deferral election tugged a blend it has no part in.
 * So one household holding all three jobs at once is run through the public `Projection` API and
 * its months are read the way a consumer reads them, no reporting internals in sight.
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

/** The one job paying in month 0: $8,000/mo, flat in real terms, electing 10%. */
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
const FUTURE_JOB_START_MONTH = 5 * 12;
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

/** One household holding all three jobs — the past one, the current one, the future one. */
const THREE_JOB_PLAN: Plan = {
  ...samplePlan,
  primary: { ...samplePlan.primary, jobs: [PAST_JOB, CURRENT_JOB, FUTURE_JOB] },
};

const months = Projection.fromState(stateOf(THREE_JOB_PLAN), nullJurisdiction)
  .run(nullJurisdiction)
  .series.months;

/** The projection's own month record, read as any consumer reads it. */
const wagesAt = (month: number) => months[month]?.flows?.wagesByOwner ?? {};
const primaryWagesAt = (month: number) => wagesAt(month)["p1"] ?? EMPTY_MONTHLY_WAGES;

describe("wagesByOwner — a household with a past, current and future job", () => {
  it("reports month 0 from the current job alone", () => {
    // $8,000/mo at 10%. The ended job's $30,000/mo and the not-yet-started job's $20,000/mo are
    // absent from every figure — pay, job count, deferral and the blend alike, which is what
    // pins the 10%: the future job's 50% election would move it the moment it were counted.
    expect(primaryWagesAt(0)).toEqual({
      jobCount: 1,
      grossCents: dollarsToCents(8_000),
      deferralCents: dollarsToCents(800),
      deferralFraction: 0.1,
    });
  });

  it("keys only the people actually earning", () => {
    // The household's one earner, not an entry per authored job or per roster member.
    expect(Object.keys(wagesAt(0))).toEqual(["p1"]);
  });

  it("starts counting the future job in the month it starts paying, not before", () => {
    expect(primaryWagesAt(FUTURE_JOB_START_MONTH - 1).jobCount).toBe(1);

    const started = primaryWagesAt(FUTURE_JOB_START_MONTH);
    expect(started.jobCount).toBe(2);
    // Both jobs' pay and both elections are now in play: the blend sits between the 10% and the
    // 50%, weighted by pay — the larger, 50%-electing job pulls it past their midpoint.
    expect(started.grossCents).toBeGreaterThan(primaryWagesAt(FUTURE_JOB_START_MONTH - 1).grossCents);
    expect(started.deferralFraction).toBeCloseTo(started.deferralCents / started.grossCents, 10);
    expect(started.deferralFraction).toBeGreaterThan(0.35);
    expect(started.deferralFraction).toBeLessThan(0.5);
  });

  it("reports no wages at all once every job has ended", () => {
    // Past the last job's end: nothing is banded, so the earner has no entry and a consumer
    // reads the empty record rather than stale pay.
    const afterEveryJob = months.length - 1;
    expect(wagesAt(afterEveryJob)).toEqual({});
    expect(primaryWagesAt(afterEveryJob)).toEqual(EMPTY_MONTHLY_WAGES);
  });
});
