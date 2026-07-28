/**
 * The `Job` standing authoring model — the sole source of truth for earned income. A job is
 * held by a {@link import("./person").Person} and compiles into the simulator via
 * {@link import("./compilePerson")}.
 *
 * Must not import from `projection/*`; that dependency lives in `compilePerson`.
 */

import type { Cents } from "./money";

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
