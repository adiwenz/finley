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
 * another excludes. The hypothesis is the one thing that can also EXTEND, and only ever the one
 * job its owner marked as continuable — because "could we retire at 70?" is a question about
 * working longer, and there is no way to ask it out of facts alone. That is the whole reason
 * this lives in one function — these used
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
   * at X" and is why this is not simply a cap. Which direction applies is decided once, per
   * person, by where the boundary falls against their authored work plan — see
   * {@link employmentEndYearExclusive}:
   *
   *  - **At or before** the last year they were authored to work: a pure cap. Every job keeps
   *    its own end and is truncated here. Nothing is extended, because nothing needs to be —
   *    the question is only how much of the authored plan survives.
   *  - **After** it: the plan runs out of authored work before the boundary, so something has
   *    to carry the extra years or the answer is "you cannot". Exactly one job is carried:
   *    their latest {@link import("./job").Job.retirementStrategy} `"extendable"` one, extended
   *    to end here. Every other job keeps its own authored end.
   *
   * Extending one job rather than all of them is what makes the answer mean something. "Could
   * you retire at 70?" has to be allowed to run employment five years longer than was written
   * down — that is the question — but it must not resurrect a job left at 30 to do it, or
   * restart a term contract that ended on its own terms.
   *
   * **Which** job is the user's to say, and it is not simply the last one. A job's dates carry
   * no information about whether the work could continue past them, so picking the
   * chronologically latest job silently assumed the most recently-ending employment was the
   * continuable one — and a two-year fixed contract taken at 65, after a thirty-year career, is
   * the one job that is certainly NOT. The policy is authored per job; this reads it.
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
  // Retiring no later than the plan already had them working is a pure truncation: there is
  // nothing to make up, so no job is carried past what it says. Checked before the extension so
  // an extendable job that ends EARLY is never pulled forward to cover a fixed job's later
  // years — "could you stop at 68?" must not answer by assuming you take your old job back for
  // three years you had already planned to spend in a different one.
  if (boundary <= authoredWorkPlanEndYearExclusive(owner)) return Math.min(authored, boundary);
  return extendsToBoundary(job, owner, boundary) ? boundary : authored;
}

/**
 * The exclusive year this person's authored working life ends — the last year any job of theirs
 * pays, and the pivot between capping and extending.
 *
 * `-Infinity` for someone with no jobs, which puts every boundary in the "after" branch, where
 * they have no extendable job either and so are simply never given income they did not author.
 */
function authoredWorkPlanEndYearExclusive(owner: Person): number {
  let latest = -Infinity;
  for (const j of owner.jobs) latest = Math.max(latest, authoredJobEndYearExclusive(j));
  return latest;
}

/**
 * Is this the job carried past the authored plan to reach `boundary`?
 *
 * Two conditions, both authored. It must be **extendable** — the user's own statement that this
 * work could continue — and it must be their **latest** such job: continuing a job means still
 * holding it, and of two extendable jobs the one that ran later is the one they would still be
 * in. A `"fixed"` job is skipped no matter how late it ends, so a term contract taken last does
 * not displace the career that preceded it; the extension then reads as carrying that career on
 * *after* the contract runs out, which is what "keep working" means for that household.
 *
 * The start check refuses to extend a job that has not begun by the boundary — it cannot be
 * work you continue if you were never in it. (Vacuous while every job ends after it starts and
 * the boundary is past every authored end, but the rule is stated where the rule lives, not
 * left as an invariant a later change could quietly break.)
 *
 * Ties are all extended, and deliberately: compared by end YEAR rather than by identity, so
 * concurrent extendable jobs finishing together are carried as one. Picking a winner between
 * two jobs the person authored as ending on the same date would mean inventing a preference
 * they never stated — and dropping one of two concurrent incomes at the very moment the model
 * claims they "keep working" would understate the household exactly where it matters. This
 * preserves the behaviour concurrent jobs already had.
 */
function extendsToBoundary(job: Job, owner: Person, boundary: number): boolean {
  if (job.retirementStrategy !== "extendable") return false;
  if (job.startYear > boundary) return false;
  const eligible = owner.jobs.filter(
    (j) => j.retirementStrategy === "extendable" && j.startYear <= boundary,
  );
  // Total: `job` is itself eligible, so the list is non-empty and holds its own end year.
  const latestEligible = Math.max(...eligible.map(authoredJobEndYearExclusive));
  return authoredJobEndYearExclusive(job) >= latestEligible;
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
