/**
 * Pure compilation from the standing {@link Person}/{@link Job} authoring model into
 * the simulator's inputs (§3, §4.6, §6 of JOBS_HOUSEHOLD_REDESIGN, issue #64):
 * a forward income {@link SimOwnedSeries} per still-paying job, plus the pre-"now"
 * covered-earnings record computed directly from the jobs (never simulated).
 *
 * This is the one module in the standing model that depends on the simulator
 * (`SimOwnedSeries`); isolating it here keeps the {@link Person}/{@link Job} *type*
 * modules free of any `projection/*` import, so the standing model and the sim
 * core cannot form an import cycle. Everything here is pure and
 * jurisdiction-agnostic: it needs only the calendar "now" (`nowYear`) and CPI
 * (`inflationRate`), which the caller supplies.
 */

import type { Cents } from "./money";
import { SimCashFlowSeries, type GrowthMode } from "./cashFlowSeries";
import type { SimOwnedSeries } from "./projection/simulate";
import type { SimPerson } from "./projection/simulate.types";
import type { Job } from "./job";
import type { Person } from "./person";

/**
 * Compile a standing authoring {@link Person} into the simulator's {@link SimPerson}
 * (§3, §4.6, §8) — the seam that keeps the authoring roster (identity + retirement
 * inputs + jobs) out of the pure sim core. The sim needs only identity, the benefit
 * basis (`birthYear` + `benefitClaimingAge`), and the pre-"now" covered-earnings record,
 * which is derived directly from the person's jobs (never simulated). `retirementTargetAge`
 * and `jobs` do not cross into the sim — they drive the forward income series
 * (compiled separately by {@link compilePersonIncomeSeries}) and the job spans.
 */
export function compilePerson(person: Person, nowYear: number, inflationRate: number): SimPerson {
  return {
    id: person.id,
    name: person.name,
    birthYear: person.birthYear,
    benefitClaimingAge: person.benefitClaimingAge,
    priorEarningsCents: compilePersonPriorEarnings(person, nowYear, inflationRate),
  };
}

/** Annual salary (nominal = real, since it is today's dollars) at a calendar year. */
function realSalaryCentsAt(job: Job, year: number): number {
  const realGrowth = job.salary.realGrowthPct / 100;
  return job.salary.startingSalaryCents * Math.pow(1 + realGrowth, year - job.startYear);
}

/**
 * The exclusive calendar year a job stops paying: for an open-ended job the owner's
 * `birthYear + retirementTargetAge` (the default stop age); for a fixed-term job its
 * authored `endYear`.
 */
function jobEndYearExclusive(job: Job, owner: Person): number {
  return job.endYear ?? owner.birthYear + owner.retirementTargetAge;
}

/**
 * Nominal covered earnings this person's jobs imply for the working years
 * **before** "now", keyed by calendar year (§3, §4.6). Computed directly from the
 * jobs — never simulated, since the sim starts at "now". Each pre-"now" year's
 * covered wage is the real (today's-dollars) salary at that year, CPI-deflated
 * from now to that year (past years are worth fewer nominal dollars). Overlapping
 * jobs sum.
 */
export function compilePersonPriorEarnings(
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
 * Compile one job into a forward income {@link SimOwnedSeries} covering "now" through
 * the job's end (§6, §4.6). The series starts at the later of month 0 and the
 * job's start, carries the salary at "now" as a monthly baseline, and grows
 * nominally (real growth compounded with CPI). A `null`-end (open-ended) job runs to
 * the owner's `retirementTargetAge`. Returns `null` for a job that has already
 * ended before "now" (its earnings are entirely in the prior-earnings record).
 */
function compileJobIncome(job: Job, owner: Person, nowYear: number, inflationRate: number): SimOwnedSeries | null {
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

  const series = new SimCashFlowSeries(startMonth, monthlyNowCents, growthMode, {
    baselineUnit: "monthly",
    endMonth: endMonthExclusive - 1,
    // A job pays `wages` — see the note in projectionBase's scalar income series.
    taxCategory: "wages",
  });

  return {
    series,
    ownerId: owner.id,
    // A household can hold several jobs, so name each by its own id rather than
    // letting a report fall back to positional numbering.
    label: `Income · ${job.id}`,
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
 * Compile all of a person's jobs into forward income series (§6). One
 * {@link SimOwnedSeries} per job that still pays at or after "now"; wholly-past jobs
 * contribute only to {@link compilePersonPriorEarnings}. Any number of jobs may be
 * open-ended (`null`-end); each simply ends at the owner's `retirementTargetAge`.
 */
export function compilePersonIncomeSeries(
  person: Person,
  nowYear: number,
  inflationRate: number,
): SimOwnedSeries[] {
  const series: SimOwnedSeries[] = [];
  for (const job of person.jobs) {
    const compiled = compileJobIncome(job, person, nowYear, inflationRate);
    if (compiled) series.push(compiled);
  }
  return series;
}
