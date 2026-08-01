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
  type Job,
  type JobIncomeOverride,
  type JobInput,
  type JobPayChange,
  type PersonId,
  type Plan,
  type Projection,
} from "@finley/engine";
import { START_YEAR } from "./config";

/** The calendar year a 0-based simulation month falls in. */
export function yearOfMonth(month: number): number {
  return START_YEAR + Math.floor(month / 12);
}

/** The primary person's jobs, in plan order. */
export function primaryJobs(plan: Plan): readonly Job[] {
  return plan.jobs.filter((j) => j.ownerId === PRIMARY_PERSON_ID);
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
  /**
   * What the job pays a month, now. The form states ONE salary, so it lands on both of the
   * job's anchors — the job reads as flat from its start until a pay change says otherwise.
   * Authoring a start pay that differs from current pay is a `salary` patch, not this form.
   */
  readonly monthlyCents: number;
  readonly startAge: number;
  readonly endAge: number | null;
  readonly realGrowthPct: number;
  /** Pre-tax 401(k) deferral as a whole-number percent (0 = none). */
  readonly deferralPct: number;
  /**
   * Employer match as a whole-number percent OF the deferral (50 = a 50% match; 0 = none).
   * Only bites when there's a deferral to match — the engine deposits it on top of the
   * employee contribution, free of the elective limit.
   */
  readonly employerMatchPct: number;
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
    employerMatchPct: 0,
  };
}

/**
 * Read an existing job back into a {@link JobDraft}. Ages resolve against the OWNER's birth
 * year, which the caller supplies; pay and deferral are read through the facade, so the form
 * opens on exactly what `setJobMonthlyIncome` / `setJobDeferralFraction` would write back.
 */
export function jobToDraftFor(
  projection: Pick<Projection, "jobMonthlyIncomeCents" | "jobDeferralFraction">,
  birthYear: number,
  job: Job,
): JobDraft {
  return {
    name: job.name ?? "",
    ownerId: job.ownerId,
    monthlyCents: projection.jobMonthlyIncomeCents(job.id),
    startAge: jobStartAgeFor(birthYear, job),
    endAge: jobEndAgeFor(birthYear, job),
    realGrowthPct: job.salary.realGrowthPct,
    deferralPct: Math.round(projection.jobDeferralFraction(job.id) * 100),
    // No facade for the match — it isn't overridable, so read it straight off the job, as
    // `realGrowthPct` is. Absent means 0%, so the form binds a number rather than undefined.
    employerMatchPct: Math.round((job.deferral?.employerMatchFraction ?? 0) * 100),
  };
}

/**
 * Apply a form draft to an **existing** job in place: form fields overwrite, everything
 * else carries through untouched — `id`, {@link JobIncomeOverride}s, {@link JobPayChange}s,
 * the deferral's `fundAccountId`, and any field added to {@link Job} later. The employer
 * match is form-authored now, so it comes from the draft, not the carried remainder.
 * `birthYear` is the **owner named by the draft**, so reassigning a job re-reads its ages
 * against the new owner's clock.
 *
 * An edit must never round-trip through {@link jobInputFromDraft}: a draft is a
 * projection of a job, so building one afresh silently drops the rest.
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
      currentSalaryCents: draft.monthlyCents * 12,
      realGrowthPct: draft.realGrowthPct,
    },
    ...(draft.deferralPct > 0
      ? {
          deferral: {
            deferralFraction: draft.deferralPct / 100,
            // The funded account belongs to the employment, not the form, so it carries;
            // the match is now form-authored, so a 0% draft drops it rather than preserving.
            fundAccountId: prior?.fundAccountId ?? RETIREMENT_ID,
            ...(draft.employerMatchPct > 0
              ? { employerMatchFraction: draft.employerMatchPct / 100 }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * A draft as a {@link JobInput} (ages → years, % → fraction) — the shape every job-creating
 * facade write takes (`Projection.marry`, `Projection.addJob`, `Projection.addPartnerJob`).
 *
 * There is no `id` here and no way to supply one: the facade mints it, and it stamps the
 * `ownerId` onto whichever person the job lands on. `birthYear` is that person's, resolving
 * the draft's ages against their own clock.
 *
 * For an *existing* job use {@link applyJobDraft}: this builds a new one, carrying only what a
 * draft holds.
 */
export function jobInputFromDraft(birthYear: number, draft: JobDraft): JobInput {
  const name = draft.name.trim();
  const base: JobInput = {
    ...(name ? { name } : {}),
    startYear: birthYear + draft.startAge,
    endYear: draft.endAge === null ? null : birthYear + draft.endAge,
    salary: {
      startingSalaryCents: draft.monthlyCents * 12,
      currentSalaryCents: draft.monthlyCents * 12,
      realGrowthPct: draft.realGrowthPct,
    },
  };
  return draft.deferralPct > 0
    ? {
        ...base,
        deferral: {
          deferralFraction: draft.deferralPct / 100,
          fundAccountId: RETIREMENT_ID,
          ...(draft.employerMatchPct > 0
            ? { employerMatchFraction: draft.employerMatchPct / 100 }
            : {}),
        },
      }
    : base;
}

