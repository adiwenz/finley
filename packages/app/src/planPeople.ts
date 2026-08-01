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
  jobPayPath,
  type Job,
  type JobIncomeOverride,
  type JobInput,
  type JobPayChange,
  type JobPayPath,
  type JobPaySpan,
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

/** The simulation month an owner's age falls on — negative for an age already behind them. */
export function monthAtOwnerAge(birthYear: number, age: number): number {
  return (birthYear + age - START_YEAR) * 12;
}

/** Whose clock a job's span is read against: their birth year, and where an open-ended job stops. */
export interface JobSpanOwner {
  readonly birthYear: number;
  /** An open-ended job runs to THIS person's retirement age — a job alone cannot say when. */
  readonly retirementTargetAge: number;
}

/**
 * A job's paying window in simulation months, both bounds resolved: an open-ended job stops at
 * its owner's retirement age. Negative months are the job's history — the span a job already
 * under way spends before "now".
 */
export function jobPaySpanFor(owner: JobSpanOwner, job: Job): JobPaySpan {
  const endYear = job.endYear ?? owner.birthYear + owner.retirementTargetAge;
  return {
    startMonth: (job.startYear - START_YEAR) * 12,
    endMonthExclusive: (endYear - START_YEAR) * 12,
  };
}

/**
 * A job's pay across its whole span — the reading the Jobs panel charts and lists, including
 * the size of the month-0 seam.
 *
 * The plan's CPI is always passed, because it is what a past paycheck grew by whichever
 * denomination is being read; `inTodaysDollars` is the one that picks the reading. See
 * {@link jobPayPath}.
 */
export function jobPayPathFor(
  owner: JobSpanOwner,
  job: Job,
  inflationRate = 0,
  inTodaysDollars = false,
): JobPayPath {
  return jobPayPath(job, jobPaySpanFor(owner, job), {
    inflationRate,
    denomination: inTodaysDollars ? "todaysDollars" : "paycheck",
  });
}


// ── Authoring: add / edit / remove a job from a form draft ──

/**
 * A job in the terms the Jobs form speaks (ages and dollars, not calendar years and
 * cents) — the seam between the UI and the standing {@link Job}. `endAge: null` is
 * open-ended (runs to retirement).
 *
 * **Ownership is not among these fields, and that is the point.** A job belongs to the member
 * it was created for, for good: every age here is that person's age, so moving a job re-reads
 * its whole calendar against a different birth year, restating what year it started, when it
 * ends, and which of its pay changes still have a job to sit on. That is a decision with
 * consequences to review — ages, pay changes, the deferral's account, household membership —
 * and not something an ordinary field edit may do in passing. Correcting an owner would be an
 * explicit transfer operation; none exists, and until one does the answer is to delete the job
 * and add it to the other member.
 *
 * So ownership rides {@link NewJobDraft} only, where it is chosen once. An edit submission
 * *cannot express* a different owner, which is why {@link applyJobDraft} needs no check.
 */
export interface JobEditDraft {
  /** Blank leaves the job unnamed; reports fall back to its id. */
  readonly name: string;
  /**
   * What the job pays a month **now** — the month-0 anchor the projection starts from.
   *
   * For a job that ended before "now" this is not asked for and not authored: the engine never
   * reads it (`compileJobIncome` returns null on the span before it touches the anchor), so
   * {@link applyJobDraft} pins it to what the job last paid rather than leaving the user to
   * state today's pay for an employment that is over.
   */
  readonly monthlyCents: number;
  /**
   * What it paid a month in its **start** year. Drives the historical reconstruction — the
   * pre-"now" covered-earnings record — and nothing forward.
   *
   * A second field rather than a figure derived from {@link monthlyCents}: the two are
   * independent authored facts, and growing one into the other reapplies raises the other
   * already includes. A job authored in one number simply states the same figure twice, which
   * is what "flat until a pay change says otherwise" means.
   *
   * Its date is the job's `startAge`, not a date of its own. Moving the start age therefore
   * keeps this VALUE and changes what it means — $5,000 authored "at 30" becomes $5,000 "at 28".
   */
  readonly startingMonthlyCents: number;
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

/**
 * A job being **created**: every editable field, plus the one decision only creation makes —
 * whose job it is. The ages below are that person's, so the owner has to be settled before the
 * rest of the draft means anything.
 */
export interface NewJobDraft extends JobEditDraft {
  /** Whose job this will be. Chosen here, once, and never again — see {@link JobEditDraft}. */
  readonly ownerId: PersonId;
}

/**
 * A blank job's fields, for a form where the owner is not in question — authoring a partner's
 * jobs as part of the event that brings them into the household, where `marry` stamps every
 * job's owner and there is nobody else the form could mean.
 */
export function blankJobDraft(currentAge: number): JobEditDraft {
  return {
    name: "",
    // A brand-new job states one salary: it has no authored history to differ from yet, so both
    // anchors open on the same figure and the start-pay field only earns its place once the
    // start age moves back before "now".
    monthlyCents: 3000 * 100,
    startingMonthlyCents: 3000 * 100,
    startAge: currentAge,
    endAge: null,
    realGrowthPct: 0,
    deferralPct: 0,
    employerMatchPct: 0,
  };
}

/** A blank job for a form that must also settle whose it is — the Jobs panel's Add. */
export function blankJobDraftFor(ownerId: PersonId, currentAge: number): NewJobDraft {
  return { ...blankJobDraft(currentAge), ownerId };
}

/**
 * Read an existing job back into a {@link JobEditDraft} — no `ownerId`, because an edit cannot
 * restate one. Ages resolve against the OWNER's birth year, which the caller supplies; pay and
 * deferral are read through the facade, so the form opens on exactly what
 * `setJobMonthlyIncome` / `setJobDeferralFraction` would write back.
 */
export function jobToDraftFor(
  projection: Pick<
    Projection,
    "jobMonthlyIncomeCents" | "jobStartingMonthlyIncomeCents" | "jobDeferralFraction"
  >,
  birthYear: number,
  job: Job,
): JobEditDraft {
  return {
    name: job.name ?? "",
    monthlyCents: projection.jobMonthlyIncomeCents(job.id),
    startingMonthlyCents: projection.jobStartingMonthlyIncomeCents(job.id),
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
 * The whole outcome of applying a draft: the edited job, and any {@link JobPayChange} the edit
 * **stranded**.
 *
 * Moving a start age forward orphans a change dated before it — there is no baseline left for
 * it to apply to. Clamping it to the new start age was rejected (two changes stack onto one
 * month) and so was deleting it silently (an authored fact disappears with no trace), so the
 * changes are dropped and named. The caller says which ones went.
 */
export interface AppliedJobDraft {
  readonly job: Job;
  /** Dropped because they now predate the job. Empty on an edit that strands nothing. */
  readonly strandedPayChanges: readonly JobPayChange[];
}

/**
 * Apply a form draft to an **existing** job in place: form fields overwrite, everything
 * else carries through untouched — `id`, {@link JobIncomeOverride}s, {@link JobPayChange}s,
 * the deferral's `fundAccountId`, and any field added to {@link Job} later. The employer
 * match is form-authored now, so it comes from the draft, not the carried remainder.
 *
 * `ownerId` carries through from `job` and cannot be restated: a {@link JobEditDraft} holds no
 * owner to restate it with. `birthYear` must therefore be that same owner's — the caller reads
 * it off the member who holds the job, and there is no second clock in play.
 *
 * The two salary anchors are written from their own fields and never from each other, so
 * restating today's pay leaves what the job paid on day one alone. The exception is a job whose
 * span is wholly past: its month-0 anchor is dead weight the engine never reads, so it is
 * pinned to what the job last paid rather than asked for. Zeroing it would cost nothing today
 * and silently pay $0/mo the moment the end age moved past "now".
 *
 * An edit must never round-trip through {@link jobInputFromDraft}: a draft is a
 * projection of a job, so building one afresh silently drops the rest.
 */
export function applyJobDraft(job: Job, birthYear: number, draft: JobEditDraft): AppliedJobDraft {
  const name = draft.name.trim();
  // `name`, `deferral` and `payChanges` leave the carried remainder: a blank name, a 0%
  // deferral and a fully stranded change list must *remove* them, not leave the old value
  // standing. Everything else — id, overrides, employer match, later fields — carries.
  const { name: _priorName, deferral: prior, payChanges: _priorChanges, ...carried } = job;

  const startMonth = monthAtOwnerAge(birthYear, draft.startAge);
  const endMonthExclusive =
    draft.endAge === null ? Infinity : monthAtOwnerAge(birthYear, draft.endAge);
  const strandedPayChanges = (job.payChanges ?? []).filter((c) => c.month < startMonth);
  const kept = (job.payChanges ?? []).filter((c) => c.month >= startMonth);

  const edited: Job = {
    ...carried,
    ...(name ? { name } : {}),
    ...(kept.length > 0 ? { payChanges: kept } : {}),
    // Stated rather than left to the carried remainder, so an edit is visibly owner-preserving
    // at the one line that could ever have written a different one.
    ownerId: job.ownerId,
    startYear: birthYear + draft.startAge,
    endYear: draft.endAge === null ? null : birthYear + draft.endAge,
    salary: {
      ...job.salary,
      startingSalaryCents: draft.startingMonthlyCents * 12,
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
  return { job: withPinnedDeadAnchor(edited, startMonth, endMonthExclusive), strandedPayChanges };
}

/**
 * Pin a wholly-past job's month-0 anchor to the pay it ended on. A no-op for every job that
 * still pays at or after "now" — there the anchor is the authored figure and authoritative.
 */
function withPinnedDeadAnchor(job: Job, startMonth: number, endMonthExclusive: number): Job {
  if (endMonthExclusive > 0) return job;
  const lastPaid = jobPayPath(job, { startMonth, endMonthExclusive }).historyReachMonthlyCents;
  if (lastPaid === null) return job;
  return { ...job, salary: { ...job.salary, currentSalaryCents: lastPaid * 12 } };
}

/**
 * A draft as a {@link JobInput} (ages → years, % → fraction) — the shape every job-creating
 * facade write takes (`Projection.marry`, `Projection.addJob`, `Projection.addPartnerJob`).
 *
 * There is no `id` here and no `ownerId` either — `JobInput` is `Omit<Job, "id" | "ownerId">`.
 * The facade mints the id, and the member the job is added *for* stamps the owner, so the
 * choice is made by naming that member and never by a field travelling in the payload.
 * `birthYear` is that person's, resolving the draft's ages against their own clock.
 *
 * For an *existing* job use {@link applyJobDraft}: this builds a new one, carrying only what a
 * draft holds.
 */
export function jobInputFromDraft(birthYear: number, draft: JobEditDraft): JobInput {
  const name = draft.name.trim();
  // A job added with an end age already behind us has no month-0 pay to state, and the form
  // does not ask for one — see {@link applyJobDraft}, which pins the same dead anchor. A new
  // job carries no pay changes, so what it "last paid" is simply its start pay.
  const alreadyOver = draft.endAge !== null && monthAtOwnerAge(birthYear, draft.endAge) <= 0;
  const base: JobInput = {
    ...(name ? { name } : {}),
    startYear: birthYear + draft.startAge,
    endYear: draft.endAge === null ? null : birthYear + draft.endAge,
    salary: {
      startingSalaryCents: draft.startingMonthlyCents * 12,
      currentSalaryCents: (alreadyOver ? draft.startingMonthlyCents : draft.monthlyCents) * 12,
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

