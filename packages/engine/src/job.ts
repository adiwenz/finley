/**
 * First-class `Job` / `Person` standing authoring model (§1–§8 of
 * JOBS_HOUSEHOLD_REDESIGN, issue #64, slice 1).
 *
 * This is the *new* source of truth for earned income. It lands **additively**,
 * alongside the scalar `Plan.incomeCents` / `careerStartAge` / `JobChangeEvent`
 * path — both lower into the same `LedgerBaseConfig`, so nothing existing is
 * removed here (that is #72's job). See {@link Job}, {@link Person}, and the
 * pure lowering helpers ({@link lowerPersonIncomeSeries},
 * {@link lowerPersonPriorEarnings}) that translate a standing person's jobs into
 * the engine's `OwnedSeries` income + pre-"now" earnings record.
 *
 * The whole module is pure and jurisdiction-agnostic: it needs only the calendar
 * "now" (`nowYear`) and CPI (`inflationRate`), which the caller supplies.
 */

import type { Cents } from "./money";
import { CashFlowSeries, type GrowthMode } from "./cashFlowSeries";
import type { OwnedSeries } from "./projection/simulate";

/** Stable id of a household member — a job's owner(s) reference these. */
export type PersonId = string;

/**
 * A job's salary path (§6). Canonical form: a single starting salary in *today's
 * dollars* anchored at the job's `startYear`, plus a *real* growth rate (growth
 * above CPI). The engine layers CPI on top — CPI-indexing backward for the SS
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
 * are a property of that employment. Lowers to the income source's
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
 * A job (§4): an earned, SS-covered income stream owned by one or more persons,
 * with a calendar span and a salary trajectory.
 *
 * `endYear === null` marks the **career job** — it ends at the owner's
 * `retirementTargetAge`, which the retirement solver varies. A person may hold
 * **at most one** null-end job ({@link careerJobOf} enforces it). An explicit
 * `endYear` is a fixed-term / supplemental job (past, straddling, or future);
 * the year is exclusive — the job is worked in calendar years
 * `[startYear, endYear)`.
 */
export interface Job {
  readonly id: string;
  readonly owners: readonly PersonId[];
  readonly startYear: number;
  /** `null` = career job (ends at `retirementTargetAge`); else the exclusive stop year. */
  readonly endYear: number | null;
  readonly salary: SalaryTrajectory;
  readonly deferral?: JobDeferral;
}

/**
 * A household member (§8) — standing data, not a life event. Holds ≥0 jobs with
 * spans plus the person-level retirement/SS inputs the lowering reads.
 *
 * Barrel-exported as `HouseholdPerson` to avoid colliding with the lower-level
 * simulator `Person` (`./projection/simulate`); the two are unified in #72.
 */
export interface Person {
  readonly id: PersonId;
  readonly name: string;
  readonly birthYear: number;
  /** Career-exit age (§5): the null-end job ends here. */
  readonly retirementTargetAge: number;
  /** Pinned Social Security claiming age (an input, never solved). */
  readonly ssClaimingAge: number;
  readonly jobs: readonly Job[];
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

/**
 * The person's career job (the ≤1 `null`-end job, §4), or `undefined` if they
 * have none. Throws if a person holds more than one — the "≤1 null-end job per
 * person" invariant is a hard model constraint, refused where it is authored.
 */
export function careerJobOf(person: Person): Job | undefined {
  const career = person.jobs.filter((j) => j.endYear === null);
  if (career.length > 1) {
    throw new Error(
      `Person "${person.id}" has ${career.length} career (null-end) jobs; at most one is allowed.`,
    );
  }
  return career[0];
}

/** Annual salary (nominal = real, since it is today's dollars) at a calendar year. */
function realSalaryCentsAt(job: Job, year: number): number {
  const realGrowth = job.salary.realGrowthPct / 100;
  return job.salary.startingSalaryCents * Math.pow(1 + realGrowth, year - job.startYear);
}

/**
 * The exclusive calendar year a job stops paying: for the career job the owner's
 * `birthYear + retirementTargetAge` (career exit); for a fixed-term job its
 * authored `endYear`.
 */
function jobEndYearExclusive(job: Job, owner: Person): number {
  return job.endYear ?? owner.birthYear + owner.retirementTargetAge;
}

/**
 * Nominal SS-covered earnings this person's jobs imply for the working years
 * **before** "now", keyed by calendar year (§3, §4.6). Computed directly from the
 * jobs — never simulated, since the sim starts at "now". Each pre-"now" year's
 * covered wage is the real (today's-dollars) salary at that year, CPI-deflated
 * from now to that year (past years are worth fewer nominal dollars). Overlapping
 * jobs sum.
 */
export function lowerPersonPriorEarnings(
  person: Person,
  nowYear: number,
  inflationRate: number,
): Record<number, Cents> {
  const earnings: Record<number, Cents> = {};
  for (const job of person.jobs) {
    const lastPastYear = Math.min(jobEndYearExclusive(job, person), nowYear);
    for (let year = job.startYear; year < lastPastYear; year++) {
      const nominal = Math.round(realSalaryCentsAt(job, year) * Math.pow(1 + inflationRate, year - nowYear));
      earnings[year] = (earnings[year] ?? 0) + nominal;
    }
  }
  return earnings;
}

/**
 * Lower one job into a forward income {@link OwnedSeries} covering "now" through
 * the job's end (§6, §4.6). The series starts at the later of month 0 and the
 * job's start, carries the salary at "now" as a monthly baseline, and grows
 * nominally (real growth compounded with CPI). A `null`-end (career) job runs to
 * the owner's `retirementTargetAge`. Returns `null` for a job that has already
 * ended before "now" (its earnings are entirely in the prior-earnings record).
 */
function lowerJobIncome(job: Job, owner: Person, nowYear: number, inflationRate: number): OwnedSeries | null {
  const endYearExclusive = jobEndYearExclusive(job, owner);
  const endMonthExclusive = (endYearExclusive - nowYear) * 12;
  if (endMonthExclusive <= 0) return null; // wholly in the past

  const startMonth = Math.max(0, (job.startYear - nowYear) * 12);
  const annualNowCents = realSalaryCentsAt(job, nowYear);
  const monthlyNowCents = Math.round(annualNowCents / 12);

  const realGrowth = job.salary.realGrowthPct / 100;
  // Real-flat salary grows at exactly CPI nominally, so tag it `inflationLinked`
  // to reproduce the scalar model's income series byte-for-byte; only a nonzero
  // real slope needs the compounded nominal rate.
  const growthMode: GrowthMode =
    realGrowth === 0
      ? { type: "inflationLinked", annualRate: inflationRate }
      : { type: "customRate", annualRate: (1 + realGrowth) * (1 + inflationRate) - 1 };

  const series = new CashFlowSeries(startMonth, monthlyNowCents, growthMode, {
    baselineUnit: "monthly",
    endMonth: endMonthExclusive - 1,
  });

  return {
    series,
    ownerId: owner.id,
    planDescriptor: job.deferral
      ? {
          deferralFraction: job.deferral.deferralFraction,
          fundAccountId: job.deferral.fundAccountId,
          ...(job.deferral.employerMatchFraction !== undefined
            ? { employerMatchFraction: job.deferral.employerMatchFraction }
            : {}),
        }
      : undefined,
  };
}

/**
 * Lower all of a person's jobs into forward income series (§6). One
 * {@link OwnedSeries} per job that still pays at or after "now"; wholly-past jobs
 * contribute only to {@link lowerPersonPriorEarnings}. `careerJobOf` is consulted
 * first so the ≤1 null-end invariant is enforced even when a caller ignores the
 * income result.
 */
export function lowerPersonIncomeSeries(
  person: Person,
  nowYear: number,
  inflationRate: number,
): OwnedSeries[] {
  careerJobOf(person);
  const series: OwnedSeries[] = [];
  for (const job of person.jobs) {
    const lowered = lowerJobIncome(job, person, nowYear, inflationRate);
    if (lowered) series.push(lowered);
  }
  return series;
}
