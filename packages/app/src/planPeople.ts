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
  type JobPayChange,
  type PersonId,
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

/**
 * The age the owner was in a job's start year (its `startYear` back to an age). Every
 * age in the Jobs form is the OWNER's age, so a partner's job reads against the
 * partner's birth year, not the primary person's (issue #118).
 */
export function jobStartAgeFor(birthYear: number, job: Job): number {
  return job.startYear - birthYear;
}

/** The age the owner reaches in a job's (exclusive) end year, or `null` if open-ended. */
export function jobEndAgeFor(birthYear: number, job: Job): number | null {
  return job.endYear === null ? null : job.endYear - birthYear;
}

/** The age the owner reaches in a given simulation month — for "from age N" copy. */
export function ownerAgeAtMonth(birthYear: number, month: number): number {
  return yearOfMonth(month) - birthYear;
}


// ── Authoring: add / edit / remove a job from a form draft ──

/**
 * The editable shape of a job, in the terms the Jobs form speaks (ages and dollars,
 * not calendar years and cents) — the seam between the UI and the standing {@link Job}.
 * `endAge: null` is an open-ended job (runs to retirement).
 */
export interface JobDraft {
  /** Optional human title; blank leaves the job unnamed (reports fall back to its id). */
  readonly name: string;
  /**
   * Whose job this is (§8, issue #118). A household member earns each job, and every
   * age in this draft is THAT person's age — so the owner is part of the draft rather
   * than something the caller remembers on the side. Changing it reassigns the job.
   */
  readonly ownerId: PersonId;
  readonly monthlyCents: number;
  readonly startAge: number;
  readonly endAge: number | null;
  readonly realGrowthPct: number;
  /** Pre-tax 401(k) deferral as a whole-number percent (0 = none). */
  readonly deferralPct: number;
}

/** The draft that seeds a fresh job for an owner: unnamed, real-flat $3,000/mo, open-ended. */
export function blankJobDraftFor(ownerId: PersonId, currentAge: number): JobDraft {
  return {
    name: "",
    ownerId,
    monthlyCents: 3000 * 100,
    startAge: currentAge,
    endAge: null,
    realGrowthPct: 0,
    deferralPct: 0,
  };
}

/** The draft that seeds a fresh job for the primary person (starts at their current age). */
export function blankJobDraft(plan: Plan): JobDraft {
  return blankJobDraftFor(PRIMARY_PERSON_ID, plan.currentAge);
}

/**
 * Read an existing job back into a {@link JobDraft} to seed the edit form. Ages resolve
 * against the OWNER's birth year — the job already names its owner, so the caller only
 * has to say when that person was born.
 */
export function jobToDraftFor(birthYear: number, job: Job): JobDraft {
  return {
    name: job.name ?? "",
    ownerId: job.ownerId,
    monthlyCents: Math.round(job.salary.startingSalaryCents / 12),
    startAge: jobStartAgeFor(birthYear, job),
    endAge: jobEndAgeFor(birthYear, job),
    realGrowthPct: job.salary.realGrowthPct,
    deferralPct: Math.round((job.deferral?.deferralFraction ?? 0) * 100),
  };
}

/** {@link jobToDraftFor} for a job owned by the primary person. */
export function jobToDraft(plan: Plan, job: Job): JobDraft {
  return jobToDraftFor(primaryBirthYear(plan), job);
}

/**
 * A stable, collision-free id for a job freshly added to `jobs`, namespaced by owner —
 * the primary person's stay `job-N` (what every existing plan holds), a partner's are
 * prefixed with their person id so two members' jobs can never collide.
 */
export function nextJobIdFor(ownerId: PersonId, jobs: readonly Job[]): string {
  const prefix = ownerId === PRIMARY_PERSON_ID ? "job" : `${ownerId}-job`;
  const ids = new Set(jobs.map((j) => j.id));
  let n = jobs.length + 1;
  while (ids.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

/**
 * Build a {@link Job} from a draft (ages → years, %→fraction). The draft names its owner
 * and `birthYear` is that owner's, so one builder serves the primary person's jobs and a
 * partner's (issue #118).
 */
export function buildJobFromDraft(id: string, birthYear: number, draft: JobDraft): Job {
  const name = draft.name.trim();
  const base: Job = {
    id,
    ...(name ? { name } : {}),
    ownerId: draft.ownerId,
    startYear: birthYear + draft.startAge,
    endYear: draft.endAge === null ? null : birthYear + draft.endAge,
    salary: { startingSalaryCents: draft.monthlyCents * 12, realGrowthPct: draft.realGrowthPct },
  };
  return draft.deferralPct > 0
    ? { ...base, deferral: { deferralFraction: draft.deferralPct / 100, fundAccountId: RETIREMENT_ID } }
    : base;
}

// ── Authoring against a bare job list ──
// A person's jobs are a list wherever they live: the primary's on `Plan.jobs`, a
// partner's on the `Person` inside their RelationshipEvent (issue #118). These operate
// on the list so both planes get identical behaviour, and the Plan-level helpers below
// are thin wrappers.

/** Append a job built from `draft` to `jobs`, minting an id in the owner's namespace. */
export function addJobToList(jobs: readonly Job[], birthYear: number, draft: JobDraft): readonly Job[] {
  return [...jobs, buildJobFromDraft(nextJobIdFor(draft.ownerId, jobs), birthYear, draft)];
}

/**
 * Rewrite the job with `id` from a form draft, preserving the parts the form doesn't
 * edit: any one-month {@link JobIncomeOverride}s, permanent {@link JobPayChange}s, and an
 * employer match on the deferral.
 */
export function updateJobInList(
  jobs: readonly Job[],
  id: string,
  birthYear: number,
  draft: JobDraft,
): readonly Job[] {
  return jobs.map((j) => {
    if (j.id !== id) return j;
    const rebuilt = buildJobFromDraft(j.id, birthYear, draft);
    const withMatch =
      rebuilt.deferral && j.deferral?.employerMatchFraction !== undefined
        ? { ...rebuilt, deferral: { ...rebuilt.deferral, employerMatchFraction: j.deferral.employerMatchFraction } }
        : rebuilt;
    return {
      ...withMatch,
      ...(j.incomeOverrides ? { incomeOverrides: j.incomeOverrides } : {}),
      ...(j.payChanges ? { payChanges: j.payChanges } : {}),
    };
  });
}

/** Drop the job with `id` from `jobs`. */
export function removeJobFromList(jobs: readonly Job[], id: string): readonly Job[] {
  return jobs.filter((j) => j.id !== id);
}

/**
 * Append a new job to the primary person from a form draft. The Jobs panel writes
 * through the list helpers above (it authors for whichever member owns the job); this
 * stays as the plan-level shorthand for fixtures and one-shot plan edits.
 */
export function addJobFromDraft(plan: Plan, draft: JobDraft): Plan {
  return { ...plan, jobs: [...addJobToList(plan.jobs, primaryBirthYear(plan), draft)] };
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

/**
 * Attach a permanent pay change (a raise OR a cut) to a specific job (§6, §10.3) — a step
 * change that holds from `payChange.month` forward, distinct from the one-month
 * {@link addIncomeOverride}. At most one pay change per (job, month): a new one replaces any
 * existing at that month, so re-editing the same month is idempotent.
 */
export function addJobPayChange(plan: Plan, jobId: string, payChange: JobPayChange): Plan {
  return {
    ...plan,
    jobs: plan.jobs.map((j) =>
      j.id === jobId
        ? {
            ...j,
            payChanges: [
              ...(j.payChanges ?? []).filter((c) => c.month !== payChange.month),
              payChange,
            ],
          }
        : j,
    ),
  };
}

/** Drop the permanent pay change at `month` from a specific job (undo a raise/cut). */
export function removeJobPayChange(plan: Plan, jobId: string, month: number): Plan {
  return {
    ...plan,
    jobs: plan.jobs.map((j) => {
      if (j.id !== jobId || j.payChanges === undefined) return j;
      const kept = j.payChanges.filter((c) => c.month !== month);
      if (kept.length === j.payChanges.length) return j;
      // Drop the array entirely when empty, so a job with no pay changes stays clean.
      if (kept.length === 0) {
        const { payChanges: _drop, ...rest } = j;
        return rest;
      }
      return { ...j, payChanges: kept };
    }),
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
