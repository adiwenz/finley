/**
 * Plan-shaped builders, for tests only.
 *
 * These take a {@link Plan} and return a new one — a shape the app itself does not have, since
 * every authored edit goes through `Projection`, which owns the id mint and the rules. A test
 * needs a way to state "a plan with a $9,000/mo job on it" without narrating the authoring
 * gestures that would produce it, so the plan-level writers live here — outside the app layer,
 * where the guard test can prove nothing in production reaches for them.
 *
 * All of them ADJUST a job the plan already holds. None creates one, because creating means
 * minting, and the counter that mints belongs to `Projection`.
 *
 * A fixture that wants the *authored* result rather than a stated one should use
 * `useTestProjection` (see `./projectionHarness`) and write through the facade.
 */

import {
  mapJob,
  withDeferralFraction,
  withIncomeOverride,
  withMonthlyIncome,
  withPayChange,
  type JobIncomeOverride,
  type JobPayChange,
  type Plan,
} from "@finley/engine";
/** Attach a permanent pay change to one job. */
export function addJobPayChange(plan: Plan, jobId: string, payChange: JobPayChange): Plan {
  return { ...plan, jobs: mapJob(plan.jobs, jobId, (j) => withPayChange(j, payChange)) };
}

/** Attach a one-month income override to one job. */
export function addIncomeOverride(plan: Plan, jobId: string, override: JobIncomeOverride): Plan {
  return { ...plan, jobs: mapJob(plan.jobs, jobId, (j) => withIncomeOverride(j, override)) };
}

/** Set a job's monthly salary (today's dollars). */
export function setJobMonthlyIncome(plan: Plan, id: string, monthlyCents: number): Plan {
  return { ...plan, jobs: mapJob(plan.jobs, id, (j) => withMonthlyIncome(j, monthlyCents)) };
}

/** Set a job's pre-tax 401(k) deferral fraction (0 removes the deferral). */
export function setJobDeferralFraction(plan: Plan, id: string, fraction: number): Plan {
  return { ...plan, jobs: mapJob(plan.jobs, id, (j) => withDeferralFraction(j, fraction)) };
}
