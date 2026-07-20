/**
 * The first-class `Job` standing authoring model (§4, §6, §11 of
 * JOBS_HOUSEHOLD_REDESIGN, issue #64, slice 1) — the *new* source of truth for
 * earned income. Pure types plus one salary-entry converter; a job is held by a
 * {@link import("./person").Person}, and the standing model compiles into the
 * simulator via {@link import("./compilePerson")}.
 *
 * This module imports nothing from `projection/*`, so the standing types stay
 * clear of the simulator core (the sim dependency lives in `compilePerson`).
 * It lands **additively**, alongside the scalar `Plan.incomeCents` /
 * `careerStartAge` / `JobChangeEvent` path — both compile into the same
 * `LedgerBaseConfig`, so nothing existing is removed here (that is #72's job).
 */

import type { Cents } from "./money";

/** Stable id of a household member — a job's owner(s) reference these. */
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
 * A job (§4): an earned, covered income stream owned by one or more persons,
 * with a calendar span and a salary trajectory.
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
  readonly owners: readonly PersonId[];
  readonly startYear: number;
  /** `null` = open-ended (ends at the owner's `retirementTargetAge`); else the exclusive stop year. */
  readonly endYear: number | null;
  readonly salary: SalaryTrajectory;
  readonly deferral?: JobDeferral;
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
