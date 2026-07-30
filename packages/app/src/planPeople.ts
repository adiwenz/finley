/**
 * App-side helpers over the plan's standing {@link Job} model. Earned income lives
 * entirely on the primary person's jobs — any number, several possibly open-ended, none
 * privileged; there is no "career job". The Jobs editor is the single authoring surface
 * for income; the Budget editor and the Base + Adjustments income row only display the
 * compiled result.
 */

import {
  PRIMARY_PERSON_ID,
  RETIREMENT_ID,
  mapJob,
  withDeferralFraction,
  withIncomeOverride,
  withMonthlyIncome,
  withPayChange,
  withoutPayChange,
  type Job,
  type JobIncomeOverride,
  type JobInput,
  type JobPayChange,
  type PersonId,
  type Plan,
} from "@finley/engine";
import { START_YEAR } from "./config";

export function primaryBirthYear(plan: Plan): number {
  return START_YEAR - plan.currentAge;
}

/** The calendar year a 0-based simulation month falls in. */
export function yearOfMonth(month: number): number {
  return START_YEAR + Math.floor(month / 12);
}

/** The primary person's jobs, in plan order. */
export function primaryJobs(plan: Plan): readonly Job[] {
  return plan.jobs.filter((j) => j.ownerId === PRIMARY_PERSON_ID);
}

/**
 * Total earned income across the primary person's jobs, as today's-dollars monthly
 * cents. A display figure only: the projection compiles each job's own series (growth,
 * spans, overrides), so this is "standing income now", not what any month pays.
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
 * The age the owner was in a job's start year. Every age in the Jobs form is the OWNER's
 * age, so a partner's job reads against the partner's birth year.
 */
export function jobStartAgeFor(birthYear: number, job: Job): number {
  return job.startYear - birthYear;
}

/** The age the owner reaches in a job's (exclusive) end year, or `null` if open-ended. */
export function jobEndAgeFor(birthYear: number, job: Job): number | null {
  return job.endYear === null ? null : job.endYear - birthYear;
}

/** The age the owner reaches in a given simulation month. */
export function ownerAgeAtMonth(birthYear: number, month: number): number {
  return yearOfMonth(month) - birthYear;
}


// ── Authoring: add / edit / remove a job from a form draft ──

/**
 * A job in the terms the Jobs form speaks (ages and dollars, not calendar years and
 * cents) — the seam between the UI and the standing {@link Job}. `endAge: null` is
 * open-ended (runs to retirement).
 */
export interface JobDraft {
  /** Blank leaves the job unnamed; reports fall back to its id. */
  readonly name: string;
  /**
   * Whose job this is; every age in this draft is THAT person's age. Changing it
   * reassigns the job.
   */
  readonly ownerId: PersonId;
  readonly monthlyCents: number;
  readonly startAge: number;
  readonly endAge: number | null;
  readonly realGrowthPct: number;
  /** Pre-tax 401(k) deferral as a whole-number percent (0 = none). */
  readonly deferralPct: number;
}

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

export function blankJobDraft(plan: Plan): JobDraft {
  return blankJobDraftFor(PRIMARY_PERSON_ID, plan.currentAge);
}

/**
 * Read an existing job back into a {@link JobDraft}. Ages resolve against the OWNER's
 * birth year, which the caller supplies.
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

export function jobToDraft(plan: Plan, job: Job): JobDraft {
  return jobToDraftFor(primaryBirthYear(plan), job);
}

/**
 * A collision-free id for a job added to `jobs`, namespaced by owner: the primary
 * person's stay `job-N` (what existing plans hold), a partner's carry their person id.
 */
export function nextJobIdFor(ownerId: PersonId, jobs: readonly Job[]): string {
  const prefix = ownerId === PRIMARY_PERSON_ID ? "job" : `${ownerId}-job`;
  const ids = new Set(jobs.map((j) => j.id));
  let n = jobs.length + 1;
  while (ids.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

/**
 * Apply a form draft to an **existing** job in place: form fields overwrite, everything
 * else carries through untouched — `id`, {@link JobIncomeOverride}s, {@link JobPayChange}s,
 * the deferral's `fundAccountId` and employer match, and any field added to {@link Job}
 * later. `birthYear` is the **owner named by the draft**, so reassigning a job re-reads
 * its ages against the new owner's clock.
 *
 * An edit must never round-trip through {@link buildJobFromDraft}: a draft is a
 * projection of a job, so minting one silently drops the rest.
 */
export function applyJobDraft(job: Job, birthYear: number, draft: JobDraft): Job {
  const name = draft.name.trim();
  // `name` and `deferral` leave the carried remainder: a blank name and a 0% deferral
  // must *remove* them, not leave the old value standing.
  const { name: _priorName, deferral: prior, ...carried } = job;
  return {
    ...carried,
    ...(name ? { name } : {}),
    ownerId: draft.ownerId,
    startYear: birthYear + draft.startAge,
    endYear: draft.endAge === null ? null : birthYear + draft.endAge,
    salary: {
      ...job.salary,
      startingSalaryCents: draft.monthlyCents * 12,
      realGrowthPct: draft.realGrowthPct,
    },
    ...(draft.deferralPct > 0
      ? {
          deferral: {
            deferralFraction: draft.deferralPct / 100,
            // Funded account and employer match belong to the employment, not the form.
            fundAccountId: prior?.fundAccountId ?? RETIREMENT_ID,
            ...(prior?.employerMatchFraction !== undefined
              ? { employerMatchFraction: prior.employerMatchFraction }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * Build a {@link Job} from a draft (ages → years, % → fraction); `birthYear` is the
 * draft owner's. For an *existing* job use {@link applyJobDraft} — this mints a new one
 * and carries only what a draft holds.
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

/**
 * A draft as a {@link JobInput} for `Projection.marry`, which mints the job's id and stamps its
 * owner to the person it creates — so neither is supplied here. `birthYear` is the partner's,
 * resolving the draft's ages against their own clock.
 */
export function jobInputFromDraft(birthYear: number, draft: JobDraft): JobInput {
  const { id: _id, ownerId: _ownerId, ...rest } = buildJobFromDraft("", birthYear, draft);
  return rest;
}

// Authoring against a bare job list. Jobs are a list wherever they live — the primary's
// on `Plan.jobs`, a partner's on the `Person` inside their RelationshipEvent — so both
// planes get identical behaviour; the Plan-level helpers below are thin wrappers.

/** Append a job built from `draft` to `jobs`, minting an id in the owner's namespace. */
export function addJobToList(jobs: readonly Job[], birthYear: number, draft: JobDraft): readonly Job[] {
  return [...jobs, buildJobFromDraft(nextJobIdFor(draft.ownerId, jobs), birthYear, draft)];
}

export function updateJobInList(
  jobs: readonly Job[],
  id: string,
  birthYear: number,
  draft: JobDraft,
): readonly Job[] {
  return jobs.map((j) => (j.id === id ? applyJobDraft(j, birthYear, draft) : j));
}

export function removeJobFromList(jobs: readonly Job[], id: string): readonly Job[] {
  return jobs.filter((j) => j.id !== id);
}

/**
 * Append a job to the primary person from a draft — plan-level shorthand for fixtures
 * and one-shot plan edits. The Jobs panel uses the list helpers above.
 */
export function addJobFromDraft(plan: Plan, draft: JobDraft): Plan {
  return { ...plan, jobs: [...addJobToList(plan.jobs, primaryBirthYear(plan), draft)] };
}

// ── Adjustments on ONE job ──
//
// The transforms themselves live in the engine (`@finley/engine`'s `job` module), because
// the published `Projection` API applies the SAME edits and a rule with two implementations
// is a rule that can drift — "a 0% deferral is removed, not recorded" is the sharp one.
// Re-exported here so the panels and `jobEditing`'s owner-aware routing keep one import
// site, and wrapped below at plan level for callers holding a whole {@link Plan}.
export {
  withIncomeOverride,
  withPayChange,
  withoutPayChange,
  withoutIncomeOverride,
} from "@finley/engine";

export function addIncomeOverride(plan: Plan, jobId: string, override: JobIncomeOverride): Plan {
  return { ...plan, jobs: mapJob(plan.jobs, jobId, (j) => withIncomeOverride(j, override)) };
}

export function addJobPayChange(plan: Plan, jobId: string, payChange: JobPayChange): Plan {
  return { ...plan, jobs: mapJob(plan.jobs, jobId, (j) => withPayChange(j, payChange)) };
}

export function removeJobPayChange(plan: Plan, jobId: string, month: number): Plan {
  return { ...plan, jobs: mapJob(plan.jobs, jobId, (j) => withoutPayChange(j, month)) };
}

// ── Thin single-job setters, for fixtures and callers that build a one-job plan ──

/** Set a job's monthly salary (today's dollars). */
export function setJobMonthlyIncome(plan: Plan, id: string, monthlyCents: number): Plan {
  return { ...plan, jobs: mapJob(plan.jobs, id, (j) => withMonthlyIncome(j, monthlyCents)) };
}

/** Set a job's pre-tax 401(k) deferral fraction (0 removes the deferral). */
export function setJobDeferralFraction(plan: Plan, id: string, fraction: number): Plan {
  return { ...plan, jobs: mapJob(plan.jobs, id, (j) => withDeferralFraction(j, fraction)) };
}
