/**
 * App-side helpers over the plan's standing {@link Job} model (§1/§6/§11 of
 * JOBS_HOUSEHOLD_REDESIGN, issue #72). Since the #72 hinge deleted the scalar
 * `incomeCents` / `careerStartAge` / `retirementDeferralPct` fields, earned income,
 * when a career began, and the pre-tax deferral all live on the primary person's
 * **career job** — the single open-ended (`endYear === null`) job the default plan
 * ships with. These read/write that job so the Budget editor and the Base +
 * Adjustments income row keep authoring "one income" without the app having to
 * reach into the job array by hand.
 */

import { PRIMARY_PERSON_ID, RETIREMENT_ID, type Job, type Plan } from "@finley/engine";
import { START_YEAR } from "./config";

/** birthYear of the primary person, derived from the frozen "now" and their current age. */
export function primaryBirthYear(plan: Plan): number {
  return START_YEAR - plan.currentAge;
}

/**
 * The primary person's **career** job — the open-ended (`endYear === null`) job that
 * ends at their retirement age (§5). Falls back to their first job if none is
 * open-ended (e.g. after a raise split the career job into a fixed-term segment plus a
 * fresh open-ended one, the fresh one is the career job). `undefined` when they hold
 * no jobs at all.
 */
export function primaryCareerJob(plan: Plan): Job | undefined {
  const mine = plan.jobs.filter((j) => j.ownerId === PRIMARY_PERSON_ID);
  return mine.find((j) => j.endYear === null) ?? mine[0];
}

/** Annual salary of the primary career job in today's dollars (0 when none). */
export function careerAnnualSalaryCents(plan: Plan): number {
  return primaryCareerJob(plan)?.salary.startingSalaryCents ?? 0;
}

/** Monthly income of the primary career job in today's dollars (0 when none). */
export function monthlyIncomeCents(plan: Plan): number {
  return Math.round(careerAnnualSalaryCents(plan) / 12);
}

/** The primary career job's pre-tax 401(k) deferral fraction (0..1), 0 when none. */
export function careerDeferralFraction(plan: Plan): number {
  return primaryCareerJob(plan)?.deferral?.deferralFraction ?? 0;
}

/** The age the primary career began — the career job's `startYear` back to an age. */
export function careerStartAge(plan: Plan): number {
  const job = primaryCareerJob(plan);
  return job ? job.startYear - primaryBirthYear(plan) : plan.currentAge;
}

/** Replace the primary career job in `plan.jobs` via `patch`, returning a new plan. */
function patchCareerJob(plan: Plan, patch: (job: Job) => Job): Plan {
  const target = primaryCareerJob(plan);
  if (target === undefined) return plan;
  return { ...plan, jobs: plan.jobs.map((j) => (j === target ? patch(j) : j)) };
}

/** Set the primary career job's monthly salary (today's dollars). */
export function setMonthlyIncome(plan: Plan, monthlyCents: number): Plan {
  return patchCareerJob(plan, (job) => ({
    ...job,
    salary: { ...job.salary, startingSalaryCents: monthlyCents * 12 },
  }));
}

/** Set the primary career job's pre-tax deferral fraction (0 removes the deferral). */
export function setCareerDeferralFraction(plan: Plan, fraction: number): Plan {
  return patchCareerJob(plan, (job) => {
    if (fraction <= 0) {
      const { deferral: _drop, ...rest } = job;
      return rest;
    }
    return {
      ...job,
      deferral: {
        deferralFraction: fraction,
        fundAccountId: job.deferral?.fundAccountId ?? RETIREMENT_ID,
        ...(job.deferral?.employerMatchFraction !== undefined
          ? { employerMatchFraction: job.deferral.employerMatchFraction }
          : {}),
      },
    };
  });
}

/** Set the age the primary career began — moves the career job's `startYear`. */
export function setCareerStartAge(plan: Plan, age: number): Plan {
  const birthYear = primaryBirthYear(plan);
  return patchCareerJob(plan, (job) => ({ ...job, startYear: birthYear + age }));
}

/** The calendar year a simulation month falls in, relative to the frozen "now". */
export function yearOfMonth(month: number): number {
  return START_YEAR + Math.floor(month / 12);
}

/**
 * Apply a standing income change from `month` forward — a **raise** on the primary
 * career job (§6/§20): "from here forward" income edits ride the job, never a budget
 * line. The career job is split at the raise's calendar year — the existing segment
 * gets an explicit `endYear` there, and a fresh open-ended segment starts that year at
 * the new salary (a real-flat `realGrowthPct: 0` salary, so the typed figure is what it
 * pays and it grows with CPI from there). The 401(k) deferral carries onto the new
 * segment. Jobs key by calendar year (§2), so the raise takes hold at the start of that
 * year. Returns a new plan; a no-op when the person has no career job.
 */
export function applyIncomeRaise(plan: Plan, month: number, newMonthlyCents: number): Plan {
  const target = primaryCareerJob(plan);
  if (target === undefined) return plan;
  const raiseYear = yearOfMonth(month);
  const raisedSalary = { startingSalaryCents: newMonthlyCents * 12, realGrowthPct: 0 };

  // The raise lands at or before the job's own start → just restate its salary; there
  // is no earlier segment to preserve.
  if (target.startYear >= raiseYear) {
    return { ...plan, jobs: plan.jobs.map((j) => (j === target ? { ...j, salary: raisedSalary } : j)) };
  }

  const priorSegment: Job = { ...target, endYear: raiseYear };
  const raisedSegment: Job = {
    ...target,
    id: `${target.id}-raise-${raiseYear}`,
    startYear: raiseYear,
    endYear: null,
    salary: raisedSalary,
  };
  return {
    ...plan,
    jobs: plan.jobs.flatMap((j) => (j === target ? [priorSegment, raisedSegment] : [j])),
  };
}
