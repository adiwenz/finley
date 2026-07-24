/**
 * The first-class `Job` standing authoring model (§4, §6, §11 of
 * JOBS_HOUSEHOLD_REDESIGN, issue #64, slice 1) — the *new* source of truth for
 * earned income. Pure types plus one salary-entry converter; a job is held by a
 * {@link import("./person").Person}, and the standing model compiles into the
 * simulator via {@link import("./compilePerson")}.
 *
 * This module imports nothing from `projection/*`, so the standing types stay
 * clear of the simulator core (the sim dependency lives in `compilePerson`).
 * Since the #72 hinge this is the **sole** source of truth for earned income —
 * the scalar `Plan.incomeCents` / `careerStartAge` / `JobChangeEvent` path it
 * was built alongside has been deleted.
 */

import type { Cents } from "./money";

/** Stable id of a household member — a job's owner references one of these. */
export type PersonId = string;

/**
 * A job's salary path (§6). Canonical form: a single starting salary in *today's
 * dollars* anchored at the job's `startYear`, plus a *real* growth rate (growth
 * above CPI). The engine layers CPI on top — CPI-indexing backward for the
 * covered-wage record and nominal growth forward for the projected income series
 * — so the same authored pair drives both. A single forward rate for v1 (§6).
 */
export interface SalaryTrajectory {
  /** Annual salary in today's dollars, as of the owning job's `startYear`. */
  readonly startingSalaryCents: Cents;
  /**
   * Real (above-CPI) annual growth as a whole-number percent. 0 = flat in real
   * terms (income holds constant against inflation), which reproduces the scalar
   * model's inflation-linked, real-flat salary exactly.
   */
  readonly realGrowthPct: number;
}

/**
 * A one-month perturbation of a job's earned income (§10.3, §20) — a bonus, a missed
 * paycheck, or a one-off "this month I actually earned X" correction. Keyed by the
 * absolute simulation `month` (relative to "now"), like the plan's expense overrides.
 * It is a **value edit on the standing job**, never a timeline life event: the same
 * job pays a different amount for exactly one month.
 *
 *   - `setTo` overrides the month's pay to an absolute figure — `cents: 0` is a missed
 *     paycheck, any other value is a one-month salary correction.
 *   - `addBonus` adds `cents` on top of what the job would otherwise pay that month.
 *
 * Both ride the job's own income series, so they are taxed as `wages` and flow through
 * the job's 401(k) deferral exactly as regular pay does — a bonus is not tax-free cash.
 */
export interface JobIncomeOverride {
  /** Absolute simulation month (from "now") the override applies to. */
  readonly month: number;
  readonly kind: "setTo" | "addBonus";
  /** For `setTo`, the month's absolute monthly pay; for `addBonus`, the amount added. */
  readonly cents: Cents;
}

/**
 * A **permanent** step change to a job's pay from a given month onward (§6, §10.3) — a
 * raise OR a pay cut (the reason this is a *pay change*, not a "raise": the new pay can be
 * lower than before). Where a {@link JobIncomeOverride} perturbs a single month, a pay
 * change opens a new salary segment: the new pay is in force from `month` and then keeps
 * growing at the job's own real-plus-CPI rate. It is a value edit on the standing job (the
 * same job now pays differently), never a timeline life event — and it is what lets a pay
 * change ride ONE continuous job instead of forcing a job to be split in two.
 *
 *   - `setTo` sets pay to an absolute monthly figure from `month` on (a new salary).
 *   - `changeBy` adds `cents` on top of what the job would otherwise pay that month, from
 *     `month` on (a delta). A negative `cents` is a pay cut.
 *
 * Like overrides, a pay change rides the job's own series, so the new pay is taxed as
 * `wages` and flows through the 401(k) deferral. `cents` is nominal at `month` (the actual
 * paycheck that month), matching the one-month `setTo`.
 */
export interface JobPayChange {
  /** Absolute simulation month (from "now") the new pay takes effect and holds from. */
  readonly month: number;
  readonly kind: "setTo" | "changeBy";
  /** For `setTo`, the new absolute monthly pay; for `changeBy`, the monthly amount added on. */
  readonly cents: Cents;
}

/**
 * The pre-tax 401(k)-style deferral a job carries (§11). Deferral lives on the
 * **job**, not the person, because the employer match and the elected fraction
 * are a property of that employment. Compiles to the income source's
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
 * A job (§4): an earned, covered income stream owned by exactly one person, with
 * a calendar span and a salary trajectory. Employment is per-person — a
 * two-earner household is two jobs, not one job with two owners — which is what
 * lets an open-ended job resolve its stop year against *the* owner's
 * `retirementTargetAge` (§5) without ambiguity.
 *
 * `endYear === null` marks an **open-ended** job — it has no authored stop date, so
 * it runs until the owner's `retirementTargetAge` (the person's default stop age),
 * which the retirement solver varies. A person may hold **any number** of open-ended
 * jobs — none is elevated over the others. An explicit `endYear` is a fixed-term job
 * (past, straddling, or future); the year is exclusive — the job is worked in calendar
 * years `[startYear, endYear)`.
 */
export interface Job {
  readonly id: string;
  readonly ownerId: PersonId;
  readonly startYear: number;
  /** `null` = open-ended (ends at the owner's `retirementTargetAge`); else the exclusive stop year. */
  readonly endYear: number | null;
  readonly salary: SalaryTrajectory;
  readonly deferral?: JobDeferral;
  /**
   * One-month pay perturbations (bonuses, missed paychecks, single-month corrections),
   * each keyed by simulation month. Optional — a job with none omits it. See
   * {@link JobIncomeOverride}.
   */
  readonly incomeOverrides?: readonly JobIncomeOverride[];
  /**
   * Permanent step changes to pay (raises / cuts), each keyed by simulation month and in
   * force from that month forward. Optional. See {@link JobPayChange}. Applied BEFORE the
   * one-month {@link incomeOverrides}, so a later bonus adds on top of the changed pay.
   */
  readonly payChanges?: readonly JobPayChange[];
}

/**
 * Derive a real growth rate (whole-number percent) from two salary points in
 * today's dollars — the default "two salary points" entry mode (§6). Both points
 * are real (today's dollars), so the derived rate is the real, above-CPI slope.
 * Returns 0 when the span is a single year or the earlier salary is zero.
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
