/**
 * Plan-shaped builders, for tests only.
 *
 * These take a {@link Plan} and return a new one. That is the shape the app itself no longer
 * has: every authored edit goes through `Projection`, which owns the id mint and the rules.
 * A test still needs a way to state "a plan with a $9,000/mo job on it" without narrating the
 * authoring gestures that would produce it, so the plan-level writers live here — outside the
 * app layer, where the guard test can prove nothing in production reaches for them.
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
import { buildJobFromDraft, primaryBirthYear, type JobDraft } from "../planPeople";

/**
 * A free `job-N` for a fixture, scanning the list it is being added to.
 *
 * Deliberately NOT the app's id authority — there isn't one any more. `Projection` mints every
 * authored job id off one counter across both planes; this only has to produce something that
 * does not collide inside a hand-built plan, and `fromScenario` floors the counter past it
 * when that plan reaches a projection.
 */
function freeJobId(jobs: readonly Plan["jobs"][number][]): string {
  const taken = new Set(jobs.map((j) => j.id));
  let n = jobs.length + 1;
  while (taken.has(`job-${n}`)) n++;
  return `job-${n}`;
}

/** Append a job to the primary person from a draft. */
export function addJobFromDraft(plan: Plan, draft: JobDraft): Plan {
  const id = freeJobId(plan.jobs);
  return { ...plan, jobs: [...plan.jobs, buildJobFromDraft(id, primaryBirthYear(plan), draft)] };
}

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
