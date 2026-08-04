/**
 * **When does this household receive wages from this job?** — one derived concept, computed
 * once here, shared by every subsystem that has to answer it.
 *
 * Three independent facts decide it, and each is authored somewhere different:
 *
 * - the **job's** own employment span (`startYear`, and an explicit `endYear`);
 * - nothing else about the owner: a retirement age is a target the household aims at, and never
 *   an end date (see {@link authoredJobEndYearExclusive});
 * - the **household membership** (a partner earns for this household only between joining and
 *   separating; the primary is a member throughout).
 *
 * plus one that is not authored at all: the retirement solver's candidate
 * {@link StopWorkingBoundary}, a simulation-only hypothesis layered on top while a solve runs.
 *
 * The authored facts only ever CAP: no membership and no authored end can make a job pay a month
 * another excludes. The hypothesis is the one thing that can also EXTEND, and only ever the last
 * job — because "could we retire at 70?" is a question about working longer, and there is no way
 * to ask it out of facts alone. That is the whole reason this lives in one function — these used
 * to be applied by whichever caller happened to need them, so a household-wide read
 * (`plannedWorkStopYear`) and the projection itself could quietly disagree.
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
   * Exclusive calendar year the household's working life ends under this hypothesis. A calendar
   * year, not an age, so every earner stops at the same point in time regardless of their own
   * birthday.
   *
   * It moves employment in BOTH directions, which is the whole substance of "what if we retired
   * at X" and is why this is not simply a cap:
   *
   *  - each person's **latest-ending** job ends exactly here — brought forward if it was
   *    authored to end later, and **extended** if it was authored to end sooner;
   *  - every **other** job keeps its own authored end, capped here so nothing pays past the
   *    boundary.
   *
   * Extending only the last job is what makes the answer mean something. "Could you retire at
   * 70?" has to be allowed to run your CURRENT employment five years longer than you wrote down
   * — that is the question — but it must not resurrect a job you left at 30 to do it, or restart
   * a fixed-term contract that ended on its own terms. The last job is the one you would still
   * be holding, so it is the one a later retirement extends. A job that ended in the past is
   * extended only when it IS the latest — i.e. when the household has stopped working entirely,
   * and the hypothesis is that they go back to it.
   */
  readonly boundaryYearExclusive: number;
}

/**
 * WHICH QUESTION a resolution is answering — the plan as the user wrote it down, or a
 * hypothesis about stopping work early.
 *
 * Spelled as a two-case union rather than an optional `stopWorking` argument, because those are
 * not the same thing with a detail attached. They are the two readings of a household's jobs,
 * and the authored one used to be the reading you got by FORGETTING an argument — which is how
 * a stop-working age ended up truncating the authored income chart in the first place. A caller
 * now has to say which it wants, and `"hypothetical"` cannot be spelled without the hypothesis.
 */
export type JobResolutionScope =
  /** The plan exactly as authored. Every job ends where its own `endYear` says and nowhere else. */
  | { readonly kind: "authored" }
  /**
   * A what-if: the retirement solver testing a candidate age, or the "preview if everyone
   * stopped working" toggle. Both are the same question — "what if the household retired
   * then?" — so both resolve through the same {@link StopWorkingBoundary}, and the preview
   * shows exactly what the solved headline age means.
   */
  | { readonly kind: "hypothetical"; readonly stopWorking: StopWorkingBoundary };

/**
 * One authored job, with everything needed to say when the household is paid for it: who owns
 * it, and the membership that decides when that owner's wages belong to this household at all.
 *
 * `owner` is always `membership.person`. It is named separately because every rule below reads
 * it as *the job's owner* — whose job this is — a different question from *which member's window
 * applies*, and worth keeping legible at each use. Build
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
   * Exclusive calendar year the EMPLOYMENT ends: the job's authored `endYear`, capped by a
   * hypothetical {@link StopWorkingBoundary} when one is in scope.
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
 * A job's exclusive end calendar year **as the user authored it** — its own `endYear`, and
 * nothing else.
 *
 * A one-line function with a name, because the rule it states used to be three rules. A job's
 * end was its `endYear` OR its owner's retirement age OR a solver's candidate boundary,
 * depending on which caller was asking, and a retirement age — a planning target the household
 * is aiming at — silently became an employment boundary: a job authored to start at 70 under a
 * stop-working age of 65 vanished from the income chart the moment it was saved. What ends an
 * authored job is what the user said ends it.
 *
 * A hypothesis about stopping work is a different question and stays one — see
 * {@link StopWorkingBoundary}, applied on top of this by {@link resolveHouseholdJob} and only
 * ever by a caller that is asking a hypothetical.
 *
 * Exported because the pre-"now" covered-earnings record is built against it: a benefit is
 * priced off a person's OWN lifetime earnings, so neither joining a household late nor a
 * solver's candidate boundary may edit what they actually earned.
 */
export function authoredJobEndYearExclusive(job: Job): number {
  return job.endYear;
}

/**
 * The employment's exclusive end year, given what is being asked. Authored: the job's own end.
 * Hypothetical: {@link StopWorkingBoundary}'s two-direction rule.
 */
function employmentEndYearExclusive(job: Job, owner: Person, scope: JobResolutionScope): number {
  const authored = authoredJobEndYearExclusive(job);
  if (scope.kind === "authored") return authored;
  const boundary = scope.stopWorking.boundaryYearExclusive;
  // The job the owner would still be holding moves to the boundary either way; everything else
  // keeps its own end and is merely capped. See {@link StopWorkingBoundary}.
  return isLatestJobOf(job, owner) ? boundary : Math.min(authored, boundary);
}

/**
 * Is this the job its owner works LAST — the one a later retirement would extend?
 *
 * Compared by end year rather than by identity, so concurrent jobs that finish together are all
 * "last" and a hypothesis moves them as one. Anything else would pick a winner between two jobs
 * the person authored as ending on the same date.
 */
function isLatestJobOf(job: Job, owner: Person): boolean {
  let latest = -Infinity;
  for (const j of owner.jobs) latest = Math.max(latest, j.endYear);
  return job.endYear >= latest;
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
  scope: JobResolutionScope,
): ResolvedHouseholdJob {
  const { job, owner, membership } = ctx;
  const endYearExclusive = employmentEndYearExclusive(job, owner, scope);
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
  scope: JobResolutionScope,
): ResolvedHouseholdJob[] {
  return contexts.map((ctx) => resolveHouseholdJob(ctx, nowYear, scope));
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
