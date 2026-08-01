/**
 * Pure compilation from the standing {@link Person}/{@link Job} authoring model into the
 * simulator's inputs: a forward income {@link SimOwnedSeries} per still-paying job, plus
 * the pre-"now" covered-earnings record computed directly from the jobs (never simulated).
 *
 * Both halves are built here, and month 0 is the seam between them:
 *
 *   starting salary → historical pay changes through month −1
 *                   → CURRENT-SALARY ANCHOR at month 0
 *                   → future pay changes and future growth
 *
 * The two halves share `applyPayChanges` and `applyIncomeOverrides`, so a raise or a bonus
 * composes by ONE rule wherever it is dated. Two things they deliberately do not share:
 *
 * - **A baseline.** History reconstructs from `startingSalaryCents`; the projection rebases on
 *   the authored `currentSalaryCents`. A step between them at the boundary is expected and never
 *   reconciled — see {@link import("./job").SalaryTrajectory}.
 * - **Growth.** Only the forward half grows. `salaryGrowthMode` applies to months from 0 onward;
 *   the past is held flat at what was authored, because it is remembered rather than projected.
 *   Filling in the unstated years is a user's explicit act
 *   ({@link import("./job").estimateHistoryPayChanges}), not a compiler default.
 *
 * Household membership narrows only where a series PAYS. The salary path is compiled over the
 * job's whole natural span either way, so a raise a partner collected before joining is part of
 * the pay they arrive on.
 *
 * The one standing-model module that depends on the simulator (`SimOwnedSeries`);
 * isolating it here keeps the {@link Person}/{@link Job} *type* modules free of any
 * `projection/*` import, so the standing model and the sim core cannot form an import cycle.
 */

import type { Cents } from "./money";
import { SimCashFlowSeries, type GrowthMode } from "./cashFlowSeries";
import type { SimOwnedSeries } from "./projection/simulate";
import type { SimPerson } from "./projection/simulate.types";
import { effectivePayChanges, type Job, type JobPayChange, type JobIncomeOverride } from "./job";
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
 * Layer a job's permanent pay changes onto its salary series, in the order they take force,
 * within the inclusive `[loMonth, hiMonth]` span (a change effective outside it — before the
 * job is worked or after it ends — is ignored). Each opens a new segment (`fromHereForward` +
 * `resetAnchor`) so the new pay compounds from there; `changeBy` adds to the month's pre-change
 * baseline (a negative delta is a cut), `setTo` replaces it. Applied BEFORE
 * {@link applyIncomeOverrides} so a later bonus lands on top of the changed pay.
 *
 * The month a change lands on is {@link payChangeEffectiveMonth}, not its authored `month` —
 * which differs only at month 0, where the authored current salary owns the month and the raise
 * begins the next one. Bounds are tested against the effective month too, so a change deferred
 * past the job's last paid month drops out rather than paying after it ended.
 */
function applyPayChanges(
  series: SimCashFlowSeries,
  payChanges: readonly JobPayChange[],
  loMonth: number,
  hiMonth: number,
): void {
  for (const { change, month } of effectivePayChanges(payChanges)) {
    if (month < loMonth || month > hiMonth) continue;
    const newMonthly =
      change.kind === "setTo" ? change.cents : series.getMonthlyCents(month) + change.cents;
    series.addOverride(month, Math.max(0, newMonthly), "fromHereForward", { resetAnchor: true });
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
 * **Historical compensation reconstruction** for one job: what it actually paid, month by
 * month, from its own (possibly long-past) start through month −1.
 *
 * Anchored at the job's start month with `startingSalaryCents` — the paycheck of that year — and
 * held FLAT from there, with every pre-"now" {@link JobPayChange} and {@link JobIncomeOverride}
 * layered on in date order. `null` when the job contributes no pre-"now" month at all (it starts
 * at or after "now").
 *
 * **Nothing grows here.** Neither CPI nor `realGrowthPct` is applied to a month before 0, and
 * that is the whole rule: the past is not projected, it is remembered. Inventing raises nobody
 * mentioned would put fabricated wages into the covered-earnings record that prices a benefit —
 * and it did, silently, which is what made "Estimate missing pay history" a lie the moment it
 * was offered as an explicit choice. A user who wants the unstated years filled in asks for it
 * ({@link import("./job").estimateHistoryPayChanges}), and gets dated changes they can see and
 * remove. Growth belongs to the forward half, where a projection is the point.
 *
 * Deliberately stops at month −1 and is never continued across the boundary: month 0 belongs
 * to the authored current salary. Carrying this series forward would reapply historical raises
 * on top of a figure that already reflects them.
 */
function reconstructHistoricalCompensation(
  job: Job,
  owner: Person,
  nowYear: number,
): { series: SimCashFlowSeries; startMonth: number; endMonthExclusive: number } | null {
  const startMonth = (job.startYear - nowYear) * 12;
  // History is months < 0: clip a still-running job at "now", and skip one that only starts at
  // or after it (all of its earnings are the forward series' job).
  const endMonthExclusive = Math.min((jobEndYearExclusive(job, owner) - nowYear) * 12, 0);
  if (endMonthExclusive <= startMonth) return null;

  // Taken VERBATIM: `startingSalaryCents` is the paycheck of the job's own start year, in that
  // year's money, so there is nothing to convert. It used to be read as today's dollars and
  // CPI-de-indexed to here, which asked the user to state a past wage in money that did not
  // exist yet — see {@link SalaryTrajectory}.
  const series = new SimCashFlowSeries(
    startMonth,
    Math.round(job.salary.startingSalaryCents / 12),
    // Flat, not `salaryGrowthMode`: see above. The rate is 0 rather than "inflationLinked at 0"
    // so the intent survives a future change to what an inflation-linked series means.
    { type: "customRate", annualRate: 0 },
    { baselineUnit: "monthly", endMonth: endMonthExclusive - 1, anchorMonth: startMonth },
  );
  // Bounded to months < 0: a month-0-or-later change is a FUTURE raise, applied by
  // `compileJobIncome` on top of the current-salary anchor instead.
  applyPayChanges(series, job.payChanges ?? [], startMonth, endMonthExclusive - 1);
  applyIncomeOverrides(series, job.incomeOverrides ?? [], startMonth, endMonthExclusive - 1);
  return { series, startMonth, endMonthExclusive };
}

/**
 * Nominal covered earnings this person's jobs imply for the working years **before** "now",
 * keyed by calendar year — the historical half of the AIME input, summed straight off
 * {@link reconstructHistoricalCompensation} so pre-"now" raises and bonuses land exactly as
 * they did in life. Computed directly, never simulated: the sim starts at "now". Overlapping
 * jobs sum; the wage-base cap is a downstream, jurisdiction-owned step.
 *
 * Covers only months strictly before "now", so the forward accumulation — which owns month 0
 * onward off the authored current salary — never double-counts a year. The reconstruction's
 * month −1 salary is NOT reconciled against that current salary: the two are independent
 * authored facts and a step between them is expected.
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
  /**
   * No longer read: the pre-"now" record is authored figures held flat, and nothing about it
   * depends on CPI. Kept so the seam's shape does not churn across every caller, and because
   * the forward half beside it genuinely needs the rate.
   */
  _inflationRate?: number,
): Record<number, Cents> {
  const earnings: Record<number, Cents> = {};
  for (const job of person.jobs) {
    const history = reconstructHistoricalCompensation(job, person, nowYear);
    if (history === null) continue;
    for (let month = history.startMonth; month < history.endMonthExclusive; month++) {
      const cents = history.series.getMonthlyCents(month);
      if (cents <= 0) continue;
      const year = nowYear + Math.floor(month / 12);
      earnings[year] = (earnings[year] ?? 0) + cents;
    }
  }
  return earnings;
}

/**
 * Compile one job into a forward income {@link SimOwnedSeries}, based on the **current-salary
 * anchor**: the authored `currentSalaryCents` as the monthly baseline at month 0, growing
 * nominally (real growth compounded with CPI) from the later of month 0 and the job's start
 * through its end. Returns `null` for a job that ended before "now" — its earnings are
 * entirely in the prior-earnings record.
 *
 * The anchor is what makes the authored current salary authoritative. The reconstructed
 * history stops at month −1 and no part of it is carried across: no historical cost basis, and
 * no historical raise reapplied on top of a current salary that already includes it. Only
 * month-0-and-later pay changes ride this series, compounding from the anchor — one authored
 * at month 0 taking force at month 1, since the anchor owns month 0 (see
 * {@link payChangeEffectiveMonth}).
 *
 * Growth is a scalar rate off that boundary, not a schedule: for a job already under way the
 * first raise lands at month 12, and a job's real historical raise cadence is neither carried
 * over nor inferred. Calendar- and work-anniversary recurring raises are not modelled here at
 * all; they belong to the recurring-compensation work, which is where a raise *schedule* would
 * be authored.
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

  // THE CURRENT-SALARY ANCHOR. The authored figure enters here and nowhere else, which is what
  // makes it authoritative: the series is built fresh on it rather than continued from the
  // reconstructed history, so no historical raise can be reapplied on top of it.
  const currentSalaryAnchorMonthlyCents = Math.round(job.salary.currentSalaryCents / 12);

  const series = new SimCashFlowSeries(
    // The job's OWN start, not the join month: the salary path is a fact about the employment,
    // and membership decides only who gets paid from it. Starting the series at `paidStart`
    // would leave every pre-join raise with no segment to open, silently discarding the pay
    // rises a partner brings into the household with them.
    naturalStart,
    currentSalaryAnchorMonthlyCents,
    salaryGrowthMode(job.salary.realGrowthPct, inflationRate),
    {
      baselineUnit: "monthly",
      endMonth: paidEndExclusive - 1,
      // `naturalStart` is CLAMPED at 0, so for a job already under way the growth clock runs
      // from the projection boundary, not from the job's own start: the authored current
      // salary is month 0's pay verbatim and the first raise lands at month 12. That is the
      // only reading that works — counting from a start years back would compound that many
      // raises onto a figure that already reflects them.
      //
      // Growth here is a single scalar rate, not a schedule. A job's start is a YEAR, so a
      // raise cadence that isn't January cannot be expressed at all; calendar- and
      // work-anniversary recurring raises are deferred to the recurring-compensation work.
      // Beware a coincidence when changing this: `(startYear - nowYear) * 12` is always a
      // multiple of 12, so an unclamped anchor would fire on the same months and only the
      // accumulated amount would differ — the timing assertions cannot tell the two apart.
      //
      // A job starting in the FUTURE keeps its own start as the clock, which is also where it
      // first pays.
      anchorMonth: naturalStart,
      taxCategory: "wages",
    },
  );

  // FUTURE changes only — `naturalStart` is >= 0, so the pre-"now" ones stay in the historical
  // reconstruction. Same two helpers the history uses, so raises and bonuses compose by one
  // rule on both sides of the boundary; here they compound from the current-salary anchor.
  //
  // PERMANENT changes run the job's whole natural span, membership or not: a raise a partner
  // got before joining is part of the salary they arrive on, so it has to be layered even
  // though nobody was paid for it at the time.
  applyPayChanges(series, job.payChanges ?? [], naturalStart, endMonthExclusive - 1);
  // One-month perturbations are the opposite case: a bonus is a payment, not a salary state, so
  // one landing before the join never reaches this household. Bounded to the paid window, and
  // the clip below would exclude it regardless. Overrides tax as wages and run through the
  // 401(k) deferral like regular pay.
  applyIncomeOverrides(series, job.incomeOverrides ?? [], paidStart, paidEndExclusive - 1);

  // LAST, once the path is complete: everything above reads the month's standing pay to
  // compose against, and those reads must see the real salary rather than a clipped zero.
  if (paidStart > naturalStart) series.clipPaymentsBefore(paidStart);

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
