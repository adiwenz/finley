/**
 * App-side helpers over the plan's standing {@link Job} model (§1/§6/§11 of
 * JOBS_HOUSEHOLD_REDESIGN, issue #72). Earned income lives entirely on the primary
 * person's **jobs** — a person may hold any number, several possibly open-ended, and
 * none is privileged. There is no "career job": these helpers read and mutate the job
 * array directly (add / update / remove from a {@link JobDraft}, plus one-month income
 * overrides), the way `goalsView` edits `plan.goals`. The Jobs editor is the single
 * authoring surface for income; the Budget editor and the Base + Adjustments income row
 * only *display* the compiled result.
 */

import {
  PRIMARY_PERSON_ID,
  RETIREMENT_ID,
  type Job,
  type JobIncomeOverride,
  type Plan,
} from "@finley/engine";
import { START_YEAR } from "./config";

/** birthYear of the primary person, derived from the frozen "now" and their current age. */
export function primaryBirthYear(plan: Plan): number {
  return START_YEAR - plan.currentAge;
}

/** The calendar year a simulation month falls in, relative to the frozen "now". */
export function yearOfMonth(month: number): number {
  return START_YEAR + Math.floor(month / 12);
}

/** The primary person's jobs, in plan order. Any number, any of them open-ended. */
export function primaryJobs(plan: Plan): readonly Job[] {
  return plan.jobs.filter((j) => j.ownerId === PRIMARY_PERSON_ID);
}

/**
 * Total earned income across the primary person's jobs, as today's-dollars monthly
 * cents (each job's starting annual salary / 12, summed). A display figure — the debug
 * panel echoes it; the actual projection compiles each job's own series (with growth,
 * spans, and overrides), so this is the "standing income now", not what any month pays.
 */
export function totalMonthlyIncomeCents(plan: Plan): number {
  return primaryJobs(plan).reduce(
    (sum, j) => sum + Math.round(j.salary.startingSalaryCents / 12),
    0,
  );
}

/** Blended pre-tax 401(k) deferral across the primary person's jobs, as a fraction of gross. */
export function blendedDeferralFraction(plan: Plan): number {
  const jobs = primaryJobs(plan);
  const grossCents = jobs.reduce((s, j) => s + j.salary.startingSalaryCents, 0);
  if (grossCents <= 0) return 0;
  const deferredCents = jobs.reduce(
    (s, j) => s + j.salary.startingSalaryCents * (j.deferral?.deferralFraction ?? 0),
    0,
  );
  return deferredCents / grossCents;
}

/** The age the owner was in a job's start year (its `startYear` back to an age). */
export function jobStartAge(plan: Plan, job: Job): number {
  return job.startYear - primaryBirthYear(plan);
}

/** The age the owner reaches in a job's (exclusive) end year, or `null` if open-ended. */
export function jobEndAge(plan: Plan, job: Job): number | null {
  return job.endYear === null ? null : job.endYear - primaryBirthYear(plan);
}

// ── Authoring: add / edit / remove a job from a form draft ──

/**
 * The editable shape of a job, in the terms the Jobs form speaks (ages and dollars,
 * not calendar years and cents) — the seam between the UI and the standing {@link Job}.
 * `endAge: null` is an open-ended job (runs to retirement).
 */
export interface JobDraft {
  readonly monthlyCents: number;
  readonly startAge: number;
  readonly endAge: number | null;
  readonly realGrowthPct: number;
  /** Pre-tax 401(k) deferral as a whole-number percent (0 = none). */
  readonly deferralPct: number;
}

/** The draft that seeds a fresh job: real-flat $3,000/mo, starting now, open-ended. */
export function blankJobDraft(plan: Plan): JobDraft {
  return { monthlyCents: 3000 * 100, startAge: plan.currentAge, endAge: null, realGrowthPct: 0, deferralPct: 0 };
}

/** Read an existing job back into a {@link JobDraft} to seed the edit form. */
export function jobToDraft(plan: Plan, job: Job): JobDraft {
  return {
    monthlyCents: Math.round(job.salary.startingSalaryCents / 12),
    startAge: jobStartAge(plan, job),
    endAge: jobEndAge(plan, job),
    realGrowthPct: job.salary.realGrowthPct,
    deferralPct: Math.round((job.deferral?.deferralFraction ?? 0) * 100),
  };
}

/** A stable, collision-free id for a freshly added job. */
function nextJobId(plan: Plan): string {
  const ids = new Set(plan.jobs.map((j) => j.id));
  let n = plan.jobs.length + 1;
  while (ids.has(`job-${n}`)) n++;
  return `job-${n}`;
}

/** Build a {@link Job} for the primary person from a draft (ages → years, %→fraction). */
function jobFromDraft(id: string, birthYear: number, draft: JobDraft): Job {
  const base: Job = {
    id,
    ownerId: PRIMARY_PERSON_ID,
    startYear: birthYear + draft.startAge,
    endYear: draft.endAge === null ? null : birthYear + draft.endAge,
    salary: { startingSalaryCents: draft.monthlyCents * 12, realGrowthPct: draft.realGrowthPct },
  };
  return draft.deferralPct > 0
    ? { ...base, deferral: { deferralFraction: draft.deferralPct / 100, fundAccountId: RETIREMENT_ID } }
    : base;
}

/** Append a new job to the primary person from a form draft. */
export function addJobFromDraft(plan: Plan, draft: JobDraft): Plan {
  const job = jobFromDraft(nextJobId(plan), primaryBirthYear(plan), draft);
  return { ...plan, jobs: [...plan.jobs, job] };
}

/**
 * Rewrite the job with `id` from a form draft, preserving the parts the form doesn't
 * edit: any one-month {@link JobIncomeOverride}s and an employer match on the deferral.
 */
export function updateJobFromDraft(plan: Plan, id: string, draft: JobDraft): Plan {
  const birthYear = primaryBirthYear(plan);
  return {
    ...plan,
    jobs: plan.jobs.map((j) => {
      if (j.id !== id) return j;
      const rebuilt = jobFromDraft(j.id, birthYear, draft);
      const withMatch =
        rebuilt.deferral && j.deferral?.employerMatchFraction !== undefined
          ? { ...rebuilt, deferral: { ...rebuilt.deferral, employerMatchFraction: j.deferral.employerMatchFraction } }
          : rebuilt;
      return j.incomeOverrides ? { ...withMatch, incomeOverrides: j.incomeOverrides } : withMatch;
    }),
  };
}

/** Drop the job with `id` from the plan. */
export function removeJob(plan: Plan, id: string): Plan {
  return { ...plan, jobs: plan.jobs.filter((j) => j.id !== id) };
}

/**
 * Attach a one-month income perturbation (§10.3, §20) — a bonus, a missed paycheck, or a
 * one-month salary correction — to a specific job. At most one override per (job, month):
 * a new one replaces any existing at that month, so re-editing the same month is idempotent.
 */
export function addIncomeOverride(plan: Plan, jobId: string, override: JobIncomeOverride): Plan {
  return {
    ...plan,
    jobs: plan.jobs.map((j) =>
      j.id === jobId
        ? {
            ...j,
            incomeOverrides: [
              ...(j.incomeOverrides ?? []).filter((o) => o.month !== override.month),
              override,
            ],
          }
        : j,
    ),
  };
}

// ── Thin single-job setters, for fixtures and callers that build a one-job plan ──

/** Set a job's monthly salary (today's dollars). */
export function setJobMonthlyIncome(plan: Plan, id: string, monthlyCents: number): Plan {
  return {
    ...plan,
    jobs: plan.jobs.map((j) =>
      j.id === id ? { ...j, salary: { ...j.salary, startingSalaryCents: monthlyCents * 12 } } : j,
    ),
  };
}

/** Set a job's pre-tax 401(k) deferral fraction (0 removes the deferral). */
export function setJobDeferralFraction(plan: Plan, id: string, fraction: number): Plan {
  return {
    ...plan,
    jobs: plan.jobs.map((j) => {
      if (j.id !== id) return j;
      if (fraction <= 0) {
        const { deferral: _drop, ...rest } = j;
        return rest;
      }
      return {
        ...j,
        deferral: {
          deferralFraction: fraction,
          fundAccountId: j.deferral?.fundAccountId ?? RETIREMENT_ID,
          ...(j.deferral?.employerMatchFraction !== undefined
            ? { employerMatchFraction: j.deferral.employerMatchFraction }
            : {}),
        },
      };
    }),
  };
}
