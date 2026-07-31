/**
 * Pure compilation from the standing {@link Person}/{@link Job} authoring model into the
 * simulator's inputs: a forward income {@link SimOwnedSeries} per still-paying job, plus
 * the pre-"now" covered-earnings record computed directly from the jobs (never simulated).
 *
 * The one standing-model module that depends on the simulator (`SimOwnedSeries`);
 * isolating it here keeps the {@link Person}/{@link Job} *type* modules free of any
 * `projection/*` import, so the standing model and the sim core cannot form an import cycle.
 */

import type { Cents } from "./money";
import { SimCashFlowSeries, type GrowthMode } from "./cashFlowSeries";
import type { SimOwnedSeries } from "./projection/simulate";
import type { SimPerson } from "./projection/simulate.types";
import type { Job, JobPayChange, JobIncomeOverride } from "./job";
import type { Person } from "./person";

/**
 * Compile a standing authoring {@link Person} into the simulator's {@link SimPerson} — the
 * seam keeping the authoring roster out of the pure sim core. `retirementTargetAge` and
 * `jobs` do not cross into the sim; they drive the forward income series ({@link
 * compilePersonIncomeSeries}) and the job spans.
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

/** An open-ended job stops at the owner's retirement target age. */
function jobEndYearExclusive(job: Job, owner: Person): number {
  return job.endYear ?? owner.birthYear + owner.retirementTargetAge;
}

/**
 * The nominal growth of a real-anchored salary: a real-flat job (0% real) grows at exactly
 * CPI, so tagging it `inflationLinked` reproduces the scalar model byte-for-byte; a job with
 * real growth compounds real and CPI together.
 */
function salaryGrowthMode(realGrowthPct: number, inflationRate: number): GrowthMode {
  const realGrowth = realGrowthPct / 100;
  return realGrowth === 0
    ? { type: "inflationLinked", annualRate: inflationRate }
    : { type: "customRate", annualRate: (1 + realGrowth) * (1 + inflationRate) - 1 };
}

/**
 * Layer a job's permanent pay changes onto its salary series, in month order, within the
 * inclusive `[loMonth, hiMonth]` span (a change outside it — before the job is worked or
 * after it ends — is ignored). Each opens a new segment (`fromHereForward` + `resetAnchor`)
 * so the new pay compounds from there; `changeBy` adds to the month's pre-change baseline (a
 * negative delta is a cut), `setTo` replaces it. Applied BEFORE {@link applyIncomeOverrides}
 * so a later bonus lands on top of the changed pay.
 */
function applyPayChanges(
  series: SimCashFlowSeries,
  payChanges: readonly JobPayChange[],
  loMonth: number,
  hiMonth: number,
): void {
  for (const c of [...payChanges].sort((a, b) => a.month - b.month)) {
    if (c.month < loMonth || c.month > hiMonth) continue;
    const newMonthly = c.kind === "setTo" ? c.cents : series.getMonthlyCents(c.month) + c.cents;
    series.addOverride(c.month, Math.max(0, newMonthly), "fromHereForward", { resetAnchor: true });
  }
}

/**
 * Layer a job's one-month perturbations (bonus, missed paycheck, correction) onto its salary
 * series as `thisMonthOnly` overrides, within the inclusive `[loMonth, hiMonth]` span.
 * `addBonus` adds to the month's baseline (grown pay, after any pay change); `setTo` replaces
 * it. So they are taxed as wages and run through the job's deferral like regular pay.
 */
function applyIncomeOverrides(
  series: SimCashFlowSeries,
  overrides: readonly JobIncomeOverride[],
  loMonth: number,
  hiMonth: number,
): void {
  for (const ov of [...overrides].sort((a, b) => a.month - b.month)) {
    if (ov.month < loMonth || ov.month > hiMonth) continue;
    const target = ov.kind === "setTo" ? ov.cents : series.getMonthlyCents(ov.month) + ov.cents;
    series.addOverride(ov.month, Math.max(0, target), "thisMonthOnly");
  }
}

/**
 * Nominal covered earnings this person's jobs imply for the working years **before** "now",
 * keyed by calendar year. Built from the SAME compiled compensation the forward projection
 * uses — actual monthly pay summed per calendar year — never a flat annual reconstruction, so
 * pre-"now" raises and bonuses land exactly as they did in life. Computed directly (never
 * simulated: the sim starts at "now"), and covering only months strictly before "now" so the
 * forward accumulation, which owns month 0 onward, never double-counts a year.
 *
 * The series anchors at the job's own (possibly long-past) start month with the salary
 * nominal-at-that-start, growing forward at real+CPI. Evaluated at "now" this reproduces the
 * forward series' now-salary, so the pre-"now" and forward records join seamlessly; evaluated
 * backward it de-CPIs each earlier year. Overlapping jobs sum.
 *
 * The split is at month 0, which the sim treats as the start of the current calendar year: the
 * pre-"now" record runs whole years up to it and forward accumulation owns it onward. Known
 * simplification — a run beginning partway through a calendar year neither records that year's
 * already-elapsed months here nor re-derives them forward, so the current year's covered wage
 * is the full simulated year rather than a partial one.
 */
export function compilePersonPriorEarnings(
  person: Person,
  nowYear: number,
  inflationRate: number,
): Record<number, Cents> {
  const earnings: Record<number, Cents> = {};
  for (const job of person.jobs) {
    const naturalStartMonth = (job.startYear - nowYear) * 12;
    // Pre-"now" is months < 0; clip a still-running job at "now" and skip a job that only
    // starts at or after it (its earnings are entirely in the forward series).
    const preNowEndExclusive = Math.min((jobEndYearExclusive(job, person) - nowYear) * 12, 0);
    if (preNowEndExclusive <= naturalStartMonth) continue;

    const nominalStartAnnualCents = Math.round(
      job.salary.startingSalaryCents * Math.pow(1 + inflationRate, job.startYear - nowYear),
    );
    const series = new SimCashFlowSeries(
      naturalStartMonth,
      Math.round(nominalStartAnnualCents / 12),
      salaryGrowthMode(job.salary.realGrowthPct, inflationRate),
      { baselineUnit: "monthly", endMonth: preNowEndExclusive - 1, anchorMonth: naturalStartMonth },
    );
    // Only pre-"now" edits: a month-0-or-later change belongs to the forward series, and
    // applying it here would reprice years the forward accumulation also covers.
    applyPayChanges(series, job.payChanges ?? [], naturalStartMonth, preNowEndExclusive - 1);
    applyIncomeOverrides(series, job.incomeOverrides ?? [], naturalStartMonth, preNowEndExclusive - 1);

    for (let month = naturalStartMonth; month < preNowEndExclusive; month++) {
      const cents = series.getMonthlyCents(month);
      if (cents <= 0) continue;
      const year = nowYear + Math.floor(month / 12);
      earnings[year] = (earnings[year] ?? 0) + cents;
    }
  }
  return earnings;
}

/**
 * Compile one job into a forward income {@link SimOwnedSeries}: the salary at "now" as a
 * monthly baseline, growing nominally (real growth compounded with CPI), from the later of
 * month 0 and the job's start through its end. Returns `null` for a job that ended before
 * "now" — its earnings are entirely in the prior-earnings record.
 *
 * `membership` clips the *paid* span to a household-membership interval: a partner's job
 * only pays the household while they are a member. It narrows where the series pays, never
 * the growth anchor, so the salary path is unchanged and only outside months are zeroed.
 * Absent (the primary earner, always a member) it is a no-op.
 */
function compileJobIncome(
  job: Job,
  owner: Person,
  nowYear: number,
  inflationRate: number,
  displayName: string,
  membership?: MembershipWindow,
): SimOwnedSeries | null {
  const endYearExclusive = jobEndYearExclusive(job, owner);
  const endMonthExclusive = (endYearExclusive - nowYear) * 12;
  if (endMonthExclusive <= 0) return null; // wholly in the past

  const naturalStart = Math.max(0, (job.startYear - nowYear) * 12);
  const paidStart = membership ? Math.max(naturalStart, membership.startMonth) : naturalStart;
  const paidEndExclusive = membership
    ? Math.min(endMonthExclusive, membership.endMonthExclusive)
    : endMonthExclusive;
  if (paidEndExclusive <= paidStart) return null; // no paid month falls inside the window

  const monthlyNowCents = Math.round(realSalaryCentsAt(job, nowYear) / 12);

  const series = new SimCashFlowSeries(
    paidStart,
    monthlyNowCents,
    salaryGrowthMode(job.salary.realGrowthPct, inflationRate),
    {
      baselineUnit: "monthly",
      endMonth: paidEndExclusive - 1,
      // Anchored at the job's own start, so a clipped partner job pays the correctly-grown
      // salary from its join month.
      anchorMonth: naturalStart,
      taxCategory: "wages",
    },
  );

  // Same effective-dated pay changes and one-month perturbations the pre-"now" record folds,
  // applied over the paid span — so both sides of "now" read one continuous compensation
  // history. Overrides tax as wages and run through the 401(k) deferral like regular pay.
  applyPayChanges(series, job.payChanges ?? [], paidStart, paidEndExclusive - 1);
  applyIncomeOverrides(series, job.incomeOverrides ?? [], paidStart, paidEndExclusive - 1);

  return {
    series,
    ownerId: owner.id,
    // Display text only — the band's stable identity is `sourceId` below.
    label: `Income · ${displayName}`,
    // Stable per-source key: two jobs read apart on the income graph, and one ending is
    // legible as that job.
    sourceId: `job:${job.id}`,
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
 * A household-membership interval that clips a person's paid job span. `endMonthExclusive`
 * is one past their last member month (a separation), or `+Infinity` while still a member.
 */
export interface MembershipWindow {
  readonly startMonth: number;
  readonly endMonthExclusive: number;
}

/**
 * One {@link SimOwnedSeries} per job that still pays at or after "now"; wholly-past jobs
 * contribute only to {@link compilePersonPriorEarnings}. Any number of jobs may be
 * open-ended (`null`-end); each ends at the owner's `retirementTargetAge`. Omit
 * `membership` for the primary earner, who is always present.
 */
export function compilePersonIncomeSeries(
  person: Person,
  nowYear: number,
  inflationRate: number,
  membership?: MembershipWindow,
): SimOwnedSeries[] {
  const names = jobDisplayNames(person);
  const series: SimOwnedSeries[] = [];
  for (const job of person.jobs) {
    const compiled = compileJobIncome(job, person, nowYear, inflationRate, names.get(job.id)!, membership);
    if (compiled) series.push(compiled);
  }
  return series;
}

/**
 * What to call each of a person's jobs in a report or chart legend, by job id.
 *
 * A titled job is called that. An untitled one is named after its **owner** ("Sam's job")
 * rather than its id: ids are minted (`p-0-job-1`), meaningless to whoever reads the legend.
 * SEVERAL untitled jobs get ordinals ("Sam's job 1"), since one name for two bands
 * identifies neither; a single untitled job stays unnumbered, so its label cannot shift as
 * other jobs come and go.
 */
function jobDisplayNames(person: Person): Map<string, string> {
  const titleOf = (job: Job): string | undefined => job.name?.trim() || undefined;
  const untitled = person.jobs.filter((j) => titleOf(j) === undefined).length;
  const names = new Map<string, string>();
  let n = 0;
  for (const job of person.jobs) {
    const title = titleOf(job);
    names.set(
      job.id,
      title ?? (untitled > 1 ? `${person.name}'s job ${++n}` : `${person.name}'s job`),
    );
  }
  return names;
}
