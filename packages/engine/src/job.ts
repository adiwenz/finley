/**
 * The `Job` standing authoring model — the sole source of truth for earned income. A job is
 * held by a {@link import("./person").Person} and compiles into the simulator via
 * {@link import("./compilePerson")}.
 *
 * Must not import from `projection/*`; that dependency lives in `compilePerson`.
 */

import type { Cents } from "./money";
import { RETIREMENT_ID } from "./ids";

/** Stable id of a household member. */
export type PersonId = string;

/**
 * A job's salary path: a starting salary in *today's dollars* anchored at the job's
 * `startYear`, plus a *real* (above-CPI) growth rate. The engine layers CPI on top —
 * indexing backward for the covered-wage record, nominal growth forward for the projected
 * income series.
 */
export interface SalaryTrajectory {
  /** Annual, as of the owning job's `startYear`. */
  readonly startingSalaryCents: Cents;
  /** Whole-number percent; 0 = flat in real terms. */
  readonly realGrowthPct: number;
}

/**
 * A one-month perturbation of a job's earned income — a bonus, a missed paycheck, a one-off
 * correction. A value edit on the standing job, never a timeline life event.
 *
 * Rides the job's own income series, so it is taxed as `wages` and flows through the job's
 * 401(k) deferral like regular pay.
 */
export interface JobIncomeOverride {
  /** Absolute simulation month (from "now") the override applies to. */
  readonly month: number;
  readonly kind: "setTo" | "addBonus";
  /** For `setTo`, the month's absolute monthly pay; for `addBonus`, the amount added. */
  readonly cents: Cents;
}

/**
 * A raise or a cut. Where a {@link JobIncomeOverride} perturbs one month, a pay change opens a
 * new salary segment: in force from `month`, then growing at the job's own real-plus-CPI rate.
 * A value edit, so it rides ONE continuous job instead of splitting it in two.
 *
 * Taxed as `wages` and flows through the 401(k) deferral, like overrides. `cents` is nominal at
 * `month` (the actual paycheck), matching the one-month `setTo`.
 */
export interface JobPayChange {
  /** Absolute simulation month (from "now") the new pay takes effect and holds from. */
  readonly month: number;
  readonly kind: "setTo" | "changeBy";
  /** For `setTo`, the new monthly pay; for `changeBy`, the amount added on — negative is a cut. */
  readonly cents: Cents;
}

/**
 * Lives on the **job**, not the person, because the employer match and elected fraction are
 * properties of that employment. Compiles to the income source's
 * {@link import("./projection/waterfall").PlanDescriptor}.
 */
export interface JobDeferral {
  /** Fraction of THIS job's gross deferred pre-tax (0..1). */
  readonly deferralFraction: number;
  /** Person-owned account the deferral (and any match) funds. */
  readonly fundAccountId: string;
  /** Employer match as a fraction of the amount deferred (e.g. 0.5 = 50%). */
  readonly employerMatchFraction?: number;
}

/**
 * An earned, covered income stream owned by exactly one person. Employment is per-person — a
 * two-earner household is two jobs, not one job with two owners — so an open-ended job
 * resolves its stop year against *the* owner's `retirementTargetAge` without ambiguity. A
 * person may hold any number of open-ended jobs; none is elevated over the others.
 */
export interface Job {
  readonly id: string;
  /**
   * Display-only: reports and the income graph show it in place of the `id` when set. Never
   * an identity — the `id` keys the job and its income band's `sourceId`, so two jobs may
   * share a name or have none.
   */
  readonly name?: string;
  readonly ownerId: PersonId;
  readonly startYear: number;
  /**
   * `null` = open-ended: runs until the owner's `retirementTargetAge`, which the retirement
   * solver varies. Otherwise exclusive — worked in calendar years `[startYear, endYear)`.
   */
  readonly endYear: number | null;
  readonly salary: SalaryTrajectory;
  readonly deferral?: JobDeferral;
  readonly incomeOverrides?: readonly JobIncomeOverride[];
  /**
   * Applied BEFORE the one-month {@link incomeOverrides}, so a bonus adds on top of the
   * changed pay.
   */
  readonly payChanges?: readonly JobPayChange[];
}

/**
 * Real growth rate (whole-number percent) between two salary points. Both are in today's
 * dollars, so the slope is real (above-CPI). Returns 0 for a non-positive span or a
 * non-positive earlier salary.
 */
export function deriveRealGrowthPct(
  earlierCents: Cents,
  earlierYear: number,
  laterCents: Cents,
  laterYear: number,
): number {
  const years = laterYear - earlierYear;
  if (years <= 0 || earlierCents <= 0) return 0;
  return (Math.pow(laterCents / earlierCents, 1 / years) - 1) * 100;
}

// ── Authoring transforms ──
//
// Pure, id-free, one job in and one job out. They live here, beside the type they edit,
// because BOTH write paths over a `Job` — the `Projection` API and the app's Jobs and
// Base + Adjustments panels — must apply the SAME rule. Two implementations of "0 removes
// the deferral" is a rule that can drift; keeping the rule in one place and duplicating
// only the wiring is what makes the two surfaces safe to keep.

/** Every {@link Job} field except the stable `id`. `ownerId` is patchable — an edit can
 * reassign a job to another household member. */
export type JobPatch = Partial<Omit<Job, "id">>;

/** Apply `f` to the job with `id`, leaving the rest of the list alone. */
export function mapJob(
  jobs: readonly Job[],
  id: string,
  f: (job: Job) => Job,
): readonly Job[] {
  return jobs.map((j) => (j.id === id ? f(j) : j));
}

/**
 * Overwrite the named fields, carrying everything else through — the other salary fields,
 * the deferral's funded account and employer match, accumulated adjustments, and any field
 * added to {@link Job} later. The `id` is stripped, so an edit can never re-point a job.
 */
export function withJobPatch(job: Job, patch: JobPatch): Job {
  const { id: _drop, ...rest } = patch as Partial<Job>;
  return { ...job, ...rest };
}

/** Set pay in **monthly** cents, the denomination a person states income in; {@link Job}
 * stores the annualized figure. Leaves the growth rate alone. */
export function withMonthlyIncome(job: Job, monthlyCents: Cents): Job {
  return { ...job, salary: { ...job.salary, startingSalaryCents: monthlyCents * 12 } };
}

/**
 * Read pay back in **monthly** cents — the inverse of {@link withMonthlyIncome}, and the
 * reason it exists: a job stores an annual figure and every surface states a monthly one, so
 * the two halves of that conversion have to round the same way or a number typed into a form
 * comes back a cent different from what was typed.
 *
 * The STARTING salary, before growth and before any {@link JobPayChange} — what a headline
 * quotes and what an edit form seeds from.
 */
export function monthlyIncomeCentsOf(job: Job): Cents {
  return Math.round(job.salary.startingSalaryCents / 12);
}

/**
 * The elected pre-tax 401(k) fraction (0..1), 0 when there is no deferral — the inverse of
 * {@link withDeferralFraction}, which removes the deferral outright at 0. The absent case is
 * that rule read back: no deferral and a 0% deferral are the same elected rate.
 */
export function deferralFractionOf(job: Job): number {
  return job.deferral?.deferralFraction ?? 0;
}

/**
 * Set the pre-tax 401(k) deferral as a fraction of THIS job's gross (0..1). A fraction of 0
 * *removes* the deferral rather than recording a 0% one, and any positive fraction preserves
 * the funded account and employer match — both properties of the employment, not of the
 * elected rate.
 */
export function withDeferralFraction(job: Job, fraction: number): Job {
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
}

/**
 * Attach a permanent raise or cut, in force from its month forward. At most one per
 * (job, month) — re-authoring the same month replaces rather than stacking.
 */
export function withPayChange(job: Job, payChange: JobPayChange): Job {
  return {
    ...job,
    payChanges: [...(job.payChanges ?? []).filter((c) => c.month !== payChange.month), payChange],
  };
}

/** Drop the pay change at `month`, if any; the field goes away entirely once empty. */
export function withoutPayChange(job: Job, month: number): Job {
  if (job.payChanges === undefined) return job;
  const kept = job.payChanges.filter((c) => c.month !== month);
  if (kept.length === job.payChanges.length) return job;
  if (kept.length === 0) {
    const { payChanges: _drop, ...rest } = job;
    return rest;
  }
  return { ...job, payChanges: kept };
}

/**
 * Attach a one-month income perturbation — a bonus, a missed paycheck, a correction. Where
 * {@link withPayChange} opens a new salary segment, this touches exactly one month. At most
 * one per (job, month).
 */
export function withIncomeOverride(job: Job, override: JobIncomeOverride): Job {
  return {
    ...job,
    incomeOverrides: [
      ...(job.incomeOverrides ?? []).filter((o) => o.month !== override.month),
      override,
    ],
  };
}

/** Drop the one-month override at `month`, if any; the field goes away entirely once empty. */
export function withoutIncomeOverride(job: Job, month: number): Job {
  if (job.incomeOverrides === undefined) return job;
  const kept = job.incomeOverrides.filter((o) => o.month !== month);
  if (kept.length === job.incomeOverrides.length) return job;
  if (kept.length === 0) {
    const { incomeOverrides: _drop, ...rest } = job;
    return rest;
  }
  return { ...job, incomeOverrides: kept };
}
