/**
 * Plan-shaped builders, for tests only.
 *
 * These take a {@link Plan} and return a new one — a shape the app itself does not have, since
 * every authored edit goes through `Projection`, which owns the id mint and the rules. A test
 * needs a way to state "a plan with a $9,000/mo job on it" without narrating the authoring
 * gestures that would produce it.
 *
 * Each builder makes exactly the edit its name describes by driving the real `Projection` API
 * over a throwaway handle and reading the plan back — so the fixture is the *authored* result,
 * and nothing here reaches for an engine internal the app itself could not name. Authoring
 * validates against `nullJurisdiction`: these adjust standing numbers, never the affordability
 * gate, so the jurisdiction is immaterial and the tax-free one keeps the setup independent of
 * the rules package.
 *
 * All of them ADJUST a job the plan already holds. None creates one, because creating means
 * minting, and the counter that mints belongs to `Projection`.
 *
 * A fixture that wants to hold the handle open rather than snapshot a plan should use
 * `useTestProjection` (see `./projectionHarness`) and write through the facade directly.
 */

import { Projection, nullJurisdiction } from "@finley/engine";
import type { JobIncomeOverride, JobPayChange, Plan } from "@finley/engine";
import { START_YEAR } from "../config";

/** The plan after one authored edit, made through the facade over a throwaway handle. */
function edited(plan: Plan, edit: (projection: Projection) => void): Plan {
  const projection = Projection.create({ plan, startYear: START_YEAR }, nullJurisdiction);
  edit(projection);
  return projection.plan;
}

/** Attach a permanent pay change to one job. */
export function addJobPayChange(plan: Plan, jobId: string, payChange: JobPayChange): Plan {
  return edited(plan, (p) => p.addJobPayChange(jobId, payChange));
}

/** Attach a one-month income override to one job. */
export function addIncomeOverride(plan: Plan, jobId: string, override: JobIncomeOverride): Plan {
  return edited(plan, (p) => p.addJobIncomeOverride(jobId, override));
}

/** Set a job's monthly salary (today's dollars). */
export function setJobMonthlyIncome(plan: Plan, id: string, monthlyCents: number): Plan {
  return edited(plan, (p) => p.setJobMonthlyIncome(id, monthlyCents));
}

/** Set a job's pre-tax 401(k) deferral fraction (0 removes the deferral). */
export function setJobDeferralFraction(plan: Plan, id: string, fraction: number): Plan {
  return edited(plan, (p) => p.setJobDeferralFraction(id, fraction));
}
