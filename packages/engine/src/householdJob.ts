/**
 * **When does this household receive wages from this job?** — one derived concept, computed
 * once here, shared by every subsystem that has to answer it.
 *
 * Three independent facts decide it, and each is authored somewhere different:
 *
 * - the **job's** own employment span (`startYear`, and an explicit `endYear`);
 * - the **owner's** own working life (`retirementTargetAge`, for an open-ended job);
 * - the **household membership** (a partner earns for this household only between joining and
 *   separating; the primary is a member throughout).
 *
 * plus one that is not authored at all: the retirement solver's candidate
 * {@link StopWorkingBoundary}, a simulation-only cap layered on top while a solve is running.
 *
 * Every one of those is a CAP. Resolution intersects them and never extends: no combination of
 * a boundary, a membership, and an authored end can make a job pay a month that any one of them
 * excludes. That is the whole reason this lives in one function — the four used to be applied by
 * whichever caller happened to need them, so a household-wide read (`plannedWorkStopYear`) and
 * the projection itself could quietly disagree about when a partner stops paying the household.
 *
 * **Authored vs. derived stays split.** {@link Job} remains pure authoring: it never grows an
 * "effective end". The intersection exists only as {@link ResolvedHouseholdJob}, rebuilt from
 * authored data on every pass, which is what lets a solver candidate vary the boundary without
 * touching a byte of the scenario.
 */

import type { Job } from "./job";
import type { Person } from "./person";
import type { HouseholdMembership } from "./ledger/household";

/**
 * A household-wide simulation boundary that ends earned work, applied at resolution time in
 * place of rewriting any job. It is the retirement solver's single varied scalar, resolved to a
 * calendar year so the same cap reaches every earner — including a partner whose jobs live on a
 * RelationshipEvent rather than on the plan — without touching a single authored figure.
 */
export interface StopWorkingBoundary {
  /**
   * Exclusive calendar year past which no job pays. A calendar year, not an age, so every earner
   * stops at the same point in time regardless of their own birthday.
   */
  readonly boundaryYearExclusive: number;
  /**
   * `"full"` caps EVERY job at the boundary — the whole household stops. `"partial"` caps only
   * the open-ended jobs and leaves each authored fixed-term job its own end.
   */
  readonly mode: "full" | "partial";
}

/**
 * One authored job, with everything needed to say when the household is paid for it: who owns
 * it, and the membership that decides when that owner's wages belong to this household at all.
 *
 * `owner` is always `membership.person`. It is named separately because every rule below reads
 * it as *the job's owner* — whose retirement target ends an open-ended job — a different
 * question from *which member's window applies*, and worth keeping legible at each use. Build
 * these only through {@link householdJobContexts} / {@link personJobContexts}, so the two can
 * never come apart.
 */
export interface HouseholdJobContext {
  readonly job: Job;
  readonly owner: Person;
  readonly membership: HouseholdMembership;
}

/**
 * A {@link HouseholdJobContext} with every cap applied — the normalized answer every household
 * calculation reads instead of re-deriving spans of its own.
 *
 * Months are relative to "now" (month 0), matching the simulator; years are calendar years.
 */
export interface ResolvedHouseholdJob {
  readonly job: Job;
  readonly owner: Person;
  readonly membership: HouseholdMembership;
  /**
   * Exclusive calendar year the EMPLOYMENT ends: the job's authored `endYear`, or its owner's
   * own `retirementTargetAge` for an open-ended one, capped by any {@link StopWorkingBoundary}.
   * Membership is deliberately not folded in — this is about the job, not about who is paid for
   * it, and the salary path is compiled over the whole employment either way.
   */
  readonly endYearExclusive: number;
  /**
   * First month of the employment at or after "now" — the growth anchor for the forward salary
   * path, clamped to 0 for a job already under way. Not where the household starts being paid;
   * see {@link paidStartMonth}.
   */
  readonly employmentStartMonth: number;
  /** First month the HOUSEHOLD is paid: the employment start, or the join, whichever is later. */
  readonly paidStartMonth: number;
  /**
   * One past the last month the HOUSEHOLD is paid: the employment end, or a separation,
   * whichever comes first. `+Infinity` is impossible — the employment end always bounds it.
   */
  readonly paidEndMonthExclusive: number;
  /**
   * Does this job pay the household any month at or after "now"? False for a job that ended
   * before the projection starts, and for one whose employment and membership windows never
   * overlap (a partner who joined after the job ended, or separated before it began).
   */
  readonly paysHousehold: boolean;
}

/**
 * A job's exclusive end calendar year with no boundary and no membership in play: its authored
 * `endYear`, or its owner's own `retirementTargetAge` for an open-ended one.
 *
 * This is the job's **natural end** — the ceiling every other cap can only lower. Exported
 * because the pre-"now" covered-earnings record is deliberately built against it: a benefit is
 * priced off a person's OWN lifetime earnings, so neither joining a household late nor a
 * solver's candidate boundary may edit what they actually earned.
 */
export function naturalJobEndYearExclusive(job: Job, owner: Person): number {
  return job.endYear ?? owner.birthYear + owner.retirementTargetAge;
}

/**
 * The employment's exclusive end year once a solver candidate is in play: never later than the
 * natural end. `Math.min` is load-bearing rather than defensive — the boundary is a single
 * household-wide scalar with no idea that an individual owner (a partner especially) may have
 * authored a shorter working life of their own, so without it a solve exploring a late candidate
 * age would resurrect wages a partner's own retirement target had already ended.
 *
 * A `"full"` stop caps EVERY job. A `"partial"` stop caps only the open-ended jobs and leaves
 * each fixed-term job its own authored end, untouched in either direction.
 */
function employmentEndYearExclusive(job: Job, owner: Person, stopWorking?: StopWorkingBoundary): number {
  const natural = naturalJobEndYearExclusive(job, owner);
  if (stopWorking === undefined) return natural;
  if (stopWorking.mode === "partial" && job.endYear !== null) return job.endYear;
  return Math.min(natural, stopWorking.boundaryYearExclusive);
}

/** A membership's window as months relative to "now", open-ended at either end where it is. */
function membershipWindow(membership: HouseholdMembership): {
  startMonth: number;
  endMonthExclusive: number;
} {
  return {
    startMonth: membership.startMonth,
    // `endMonth` is the separation month — the first month they are NO LONGER a member — so it
    // is already exclusive. `null` means still a member, i.e. no end at all.
    endMonthExclusive: membership.endMonth ?? Number.POSITIVE_INFINITY,
  };
}

/** Resolve one context: intersect employment, membership, and any candidate boundary. */
export function resolveHouseholdJob(
  ctx: HouseholdJobContext,
  nowYear: number,
  stopWorking?: StopWorkingBoundary,
): ResolvedHouseholdJob {
  const { job, owner, membership } = ctx;
  const endYearExclusive = employmentEndYearExclusive(job, owner, stopWorking);
  const employmentEndMonthExclusive = (endYearExclusive - nowYear) * 12;
  // Clamped at 0: for a job already under way the forward series starts at the projection
  // boundary, since the authored current salary is month 0's pay verbatim.
  const employmentStartMonth = Math.max(0, (job.startYear - nowYear) * 12);

  const memberWindow = membershipWindow(membership);
  const paidStartMonth = Math.max(employmentStartMonth, memberWindow.startMonth);
  const paidEndMonthExclusive = Math.min(employmentEndMonthExclusive, memberWindow.endMonthExclusive);

  return {
    job,
    owner,
    membership,
    endYearExclusive,
    employmentStartMonth,
    paidStartMonth,
    paidEndMonthExclusive,
    // The first test excludes a job wholly in the past; the second, one whose employment and
    // membership never overlap.
    paysHousehold: employmentEndMonthExclusive > 0 && paidEndMonthExclusive > paidStartMonth,
  };
}

/** {@link resolveHouseholdJob} over a whole list — the shape every household calculation takes. */
export function resolveHouseholdJobs(
  contexts: readonly HouseholdJobContext[],
  nowYear: number,
  stopWorking?: StopWorkingBoundary,
): ResolvedHouseholdJob[] {
  return contexts.map((ctx) => resolveHouseholdJob(ctx, nowYear, stopWorking));
}

/** Every job one member owns, paired with that member's own window. */
export function personJobContexts(membership: HouseholdMembership): HouseholdJobContext[] {
  return membership.person.jobs.map((job) => ({
    job,
    owner: membership.person,
    membership,
  }));
}

/**
 * Every job authored anywhere in the household — the primary's plan jobs AND every partner's,
 * each carrying the membership that decides when it pays — drawn from the same
 * {@link Household.memberships} roster interpretation builds. One traversal, so no household-wide
 * read can disagree with what the projection actually rosters, and none has to special-case the
 * primary to reach a partner's jobs.
 */
export function householdJobContexts(memberships: readonly HouseholdMembership[]): HouseholdJobContext[] {
  return memberships.flatMap(personJobContexts);
}

/**
 * The exclusive calendar year a resolved job pays the household its last wage. A membership can
 * end mid-year, so this rounds UP to the end of the calendar year containing that final paid
 * month: the household is still receiving wages during that year.
 */
export function householdWageEndYearExclusive(resolved: ResolvedHouseholdJob, nowYear: number): number {
  return nowYear + Math.ceil(resolved.paidEndMonthExclusive / 12);
}
