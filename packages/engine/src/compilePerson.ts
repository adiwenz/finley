/**
 * Pure compilation from the standing {@link Person}/{@link Job} authoring model into the
 * simulator's inputs: a forward income {@link SimOwnedSeries} per still-paying job, plus
 * the pre-"now" covered-earnings record computed directly from the jobs (never simulated).
 *
 * The one standing-model module that depends on the simulator (`SimOwnedSeries`);
 * isolating it here keeps the {@link Person}/{@link Job} *type* modules free of any
 * `projection/*` import, so the standing model and the sim core cannot form an import
 * cycle. Pure and jurisdiction-agnostic: it needs only the caller-supplied calendar "now"
 * (`nowYear`) and CPI (`inflationRate`).
 */

import type { Cents } from "./money";
import { SimCashFlowSeries, type GrowthMode } from "./cashFlowSeries";
import type { SimOwnedSeries } from "./projection/simulate";
import type { SimPerson } from "./projection/simulate.types";
import type { Job } from "./job";
import type { Person } from "./person";

/**
 * Compile a standing authoring {@link Person} into the simulator's {@link SimPerson} — the
 * seam keeping the authoring roster (identity + retirement inputs + jobs) out of the pure
 * sim core. The sim needs only identity, the benefit basis (`birthYear` +
 * `benefitClaimingAge`), and the pre-"now" covered-earnings record derived from the
 * person's jobs. `retirementTargetAge` and `jobs` do not cross into the sim — they drive
 * the forward income series ({@link compilePersonIncomeSeries}) and the job spans.
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
 * Nominal covered earnings this person's jobs imply for the working years **before**
 * "now", keyed by calendar year. Computed directly from the jobs — never simulated, since
 * the sim starts at "now". Each year's covered wage is the real (today's-dollars) salary
 * at that year, CPI-deflated from now back to it (past years are worth fewer nominal
 * dollars). Overlapping jobs sum.
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
 * Compile one job into a forward income {@link SimOwnedSeries} covering "now" through the
 * job's end. The series starts at the later of month 0 and the job's start, carries the
 * salary at "now" as a monthly baseline, and grows nominally (real growth compounded with
 * CPI). An open-ended (`null`-end) job runs to the owner's `retirementTargetAge`. Returns
 * `null` for a job that ended before "now" — its earnings are entirely in the
 * prior-earnings record.
 *
 * `membership` clips the *paid* span to a household-membership interval: a partner's job
 * only pays the household while they are a member — from the join month, stopping at a
 * separation. It narrows where the series pays, never the growth anchor, so the salary
 * path (real+CPI compounding from the job's own start) is unchanged; only outside months
 * are zeroed. Absent (the primary earner, always a member) it is a no-op.
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

  // The job's own start anchors salary growth even when a membership window clips the
  // paid span later, preserving the today's-dollars salary at every month.
  const naturalStart = Math.max(0, (job.startYear - nowYear) * 12);
  const paidStart = membership ? Math.max(naturalStart, membership.startMonth) : naturalStart;
  const paidEndExclusive = membership
    ? Math.min(endMonthExclusive, membership.endMonthExclusive)
    : endMonthExclusive;
  if (paidEndExclusive <= paidStart) return null; // no paid month falls inside the window

  const annualNowCents = realSalaryCentsAt(job, nowYear);
  const monthlyNowCents = Math.round(annualNowCents / 12);

  const realGrowth = job.salary.realGrowthPct / 100;
  // Real-flat salary grows at exactly CPI nominally, so tag it `inflationLinked` to
  // reproduce the scalar model's income series byte-for-byte; only a nonzero real slope
  // needs the compounded nominal rate.
  const growthMode: GrowthMode =
    realGrowth === 0
      ? { type: "inflationLinked", annualRate: inflationRate }
      : { type: "customRate", annualRate: (1 + realGrowth) * (1 + inflationRate) - 1 };

  const series = new SimCashFlowSeries(paidStart, monthlyNowCents, growthMode, {
    baselineUnit: "monthly",
    endMonth: paidEndExclusive - 1,
    // Anchored at the job's own start, so a clipped partner job pays the correctly-grown
    // salary from its join month.
    anchorMonth: naturalStart,
    // A job pays `wages` — see the note in projectionBase's scalar income series.
    taxCategory: "wages",
  });

  // Permanent pay changes hold from their month forward: each opens a new salary segment
  // via a `fromHereForward` override with `resetAnchor`, so the new pay compounds from here
  // at the job's own real+CPI rate. `changeBy` adds to the month's pre-change baseline (a
  // negative delta is a cut); `setTo` replaces it. Applied in month order (so successive
  // changes compound) and BEFORE the one-month overrides below, so a later bonus lands on
  // top of the changed pay. Changes outside the paid span are ignored — a job cannot be
  // repriced in a month it is not worked.
  for (const c of [...(job.payChanges ?? [])].sort((a, b) => a.month - b.month)) {
    if (c.month < paidStart || c.month > paidEndExclusive - 1) continue;
    const newMonthly = c.kind === "setTo" ? c.cents : series.getMonthlyCents(c.month) + c.cents;
    series.addOverride(c.month, Math.max(0, newMonthly), "fromHereForward", { resetAnchor: true });
  }

  // One-month perturbations (bonus, missed paycheck, correction) ride the job's own series
  // as `thisMonthOnly` overrides, so they are taxed as wages and run through the 401(k)
  // deferral like regular pay. `addBonus` adds to the month's baseline (grown pay, before
  // any override); `setTo` replaces it. Overrides outside the paid span are ignored — a job
  // cannot pay in a month it is not worked. Applied in month order so two edits to one
  // month compose predictably.
  for (const ov of [...(job.incomeOverrides ?? [])].sort((a, b) => a.month - b.month)) {
    if (ov.month < paidStart || ov.month > paidEndExclusive - 1) continue;
    const target = ov.kind === "setTo" ? ov.cents : series.getMonthlyCents(ov.month) + ov.cents;
    series.addOverride(ov.month, Math.max(0, target), "thisMonthOnly");
  }

  return {
    series,
    ownerId: owner.id,
    // Display text only — the band's stable identity is `sourceId` below. Named by human
    // title when the user set one, else by owner: a legend is read by a person, and
    // "p-0-job-1" tells them nothing.
    label: `Income · ${displayName}`,
    // Per-source income reporting keys each job's band by this stable id, so two jobs read
    // apart on the income graph and one ending is legible as that job.
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
 * A household-membership interval that clips a person's paid job span.
 * `startMonth` is the month they joined; `endMonthExclusive` is one past the last
 * month they are a member (a separation month), or `+Infinity` while still a member.
 */
export interface MembershipWindow {
  readonly startMonth: number;
  readonly endMonthExclusive: number;
}

/**
 * Compile all of a person's jobs into forward income series. One {@link SimOwnedSeries}
 * per job that still pays at or after "now"; wholly-past jobs contribute only to {@link
 * compilePersonPriorEarnings}. Any number of jobs may be open-ended (`null`-end); each ends
 * at the owner's `retirementTargetAge`.
 *
 * `membership` clips each job's paid span to a household-membership interval, so a
 * partner's jobs pay only while they are a member. Omit it for the primary earner, who is
 * always present.
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
 * What to call each of a person's jobs in a report or chart legend, by job id. Display
 * names only — a band's stable identity is its `sourceId` throughout.
 *
 * A titled job is called that. An untitled one is named after its **owner** ("Sam's job")
 * rather than its id: ids are minted, not written — a partner's are generated from their
 * person id (`p-0-job-1`), meaningless to whoever reads the legend.
 *
 * Ordinals appear only where they must: SEVERAL untitled jobs get "Sam's job 1", "Sam's
 * job 2", since one name for two bands identifies neither. A single untitled job stays
 * unnumbered, so its label cannot shift as other jobs come and go.
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
