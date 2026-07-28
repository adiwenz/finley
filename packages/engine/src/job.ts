/**
 * The `Job` standing authoring model — the sole source of truth for earned income. Pure
 * types plus one salary-entry converter; a job is held by a
 * {@link import("./person").Person} and compiles into the simulator via
 * {@link import("./compilePerson")}.
 *
 * Imports nothing from `projection/*`, keeping the standing types clear of the simulator
 * core (that dependency lives in `compilePerson`).
 */

import type { Cents } from "./money";

/** Stable id of a household member — a job's owner references one of these. */
export type PersonId = string;

/**
 * A job's salary path: a starting salary in *today's dollars* anchored at the job's
 * `startYear`, plus a *real* (above-CPI) growth rate. The engine layers CPI on top —
 * indexing backward for the covered-wage record, nominal growth forward for the projected
 * income series — so one authored pair drives both. A single forward rate for v1.
 */
export interface SalaryTrajectory {
  /** Annual salary in today's dollars, as of the owning job's `startYear`. */
  readonly startingSalaryCents: Cents;
  /**
   * Real (above-CPI) annual growth as a whole-number percent. 0 = flat in real terms —
   * income holds constant against inflation.
   */
  readonly realGrowthPct: number;
}

/**
 * A one-month perturbation of a job's earned income — a bonus, a missed paycheck, a one-off
 * correction. Keyed by absolute simulation `month` (relative to "now"), like the plan's
 * expense overrides. A **value edit on the standing job**, never a timeline life event.
 *
 *   - `setTo` overrides the month's pay to an absolute figure — `cents: 0` is a missed
 *     paycheck.
 *   - `addBonus` adds `cents` on top of what the job would otherwise pay that month.
 *
 * Both ride the job's own income series, so they are taxed as `wages` and flow through the
 * job's 401(k) deferral like regular pay — a bonus is not tax-free cash.
 */
export interface JobIncomeOverride {
  /** Absolute simulation month (from "now") the override applies to. */
  readonly month: number;
  readonly kind: "setTo" | "addBonus";
  /** For `setTo`, the month's absolute monthly pay; for `addBonus`, the amount added. */
  readonly cents: Cents;
}

/**
 * A **permanent** step change to a job's pay from a given month onward — a raise OR a cut
 * (hence *pay change*, not "raise"). Where a {@link JobIncomeOverride} perturbs one month, a
 * pay change opens a new salary segment: in force from `month`, then growing at the job's
 * own real-plus-CPI rate. A value edit on the standing job, never a timeline life event —
 * which lets a pay change ride ONE continuous job instead of splitting it in two.
 *
 *   - `setTo` sets pay to an absolute monthly figure from `month` on.
 *   - `changeBy` adds `cents` to what the job would otherwise pay, from `month` on. Negative
 *     `cents` is a pay cut.
 *
 * Like overrides, it rides the job's own series, so the new pay is taxed as `wages` and
 * flows through the 401(k) deferral. `cents` is nominal at `month` (the actual paycheck that
 * month), matching the one-month `setTo`.
 */
export interface JobPayChange {
  /** Absolute simulation month (from "now") the new pay takes effect and holds from. */
  readonly month: number;
  readonly kind: "setTo" | "changeBy";
  /** For `setTo`, the new absolute monthly pay; for `changeBy`, the monthly amount added on. */
  readonly cents: Cents;
}

/**
 * The pre-tax 401(k)-style deferral a job carries. It lives on the **job**, not the person,
 * because the employer match and elected fraction are properties of that employment.
 * Compiles to the income source's
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
 * An earned, covered income stream owned by exactly one person, with a calendar span and a
 * salary trajectory. Employment is per-person — a two-earner household is two jobs, not one
 * job with two owners — so an open-ended job resolves its stop year against *the* owner's
 * `retirementTargetAge` without ambiguity.
 *
 * `endYear === null` marks an **open-ended** job: no authored stop date, so it runs until
 * the owner's `retirementTargetAge`, which the retirement solver varies. A person may hold
 * any number of open-ended jobs — none is elevated over the others. An explicit `endYear` is
 * a fixed-term job (past, straddling, or future) and is exclusive: worked in calendar years
 * `[startYear, endYear)`.
 */
export interface Job {
  readonly id: string;
  /**
   * Human-facing job title. Display-only: reports and the income graph show it in place of
   * the `id` when set (see {@link import("./compilePerson").compilePerson}). Never an
   * identity — the `id` keys the job and its income band's `sourceId`, so two jobs may
   * share a name or have none.
   */
  readonly name?: string;
  readonly ownerId: PersonId;
  readonly startYear: number;
  /** `null` = open-ended (ends at the owner's `retirementTargetAge`); else the exclusive stop year. */
  readonly endYear: number | null;
  readonly salary: SalaryTrajectory;
  readonly deferral?: JobDeferral;
  /**
   * One-month pay perturbations keyed by simulation month. See {@link JobIncomeOverride}.
   */
  readonly incomeOverrides?: readonly JobIncomeOverride[];
  /**
   * Permanent step changes to pay (raises / cuts), keyed by simulation month and in force
   * from that month on. See {@link JobPayChange}. Applied BEFORE the one-month
   * {@link incomeOverrides}, so a later bonus adds on top of the changed pay.
   */
  readonly payChanges?: readonly JobPayChange[];
}

/**
 * Real growth rate (whole-number percent) from two salary points — the default "two salary
 * points" entry mode. Both points are in today's dollars, so the slope is real (above-CPI).
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
