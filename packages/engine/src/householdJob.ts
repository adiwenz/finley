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
 * job its owner named as the one they would continue — because "could we retire at 70?" is a
 * question about working longer, and there is no way to ask it out of facts alone. That is the whole reason
 * this lives in one function — these used
 * to be applied by whichever caller happened to need them, so a household-wide read
 * (`plannedWorkStopYear`) and the projection itself could quietly disagree.
 *
 * **Authored vs. derived stays split.** {@link Job} remains pure authoring: it never grows an
 * "effective end". The intersection exists only as {@link ResolvedHouseholdJob}, rebuilt from
 * authored data on every pass, which is what lets a solver candidate vary the boundary without
 * touching a byte of the scenario.
 */

import type { Job, JobId } from "./job";
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
   *    to carry the extra years or the answer is "you cannot". Exactly one job is carried —
   *    the person's {@link import("./person").Person.continuationJobId} — extended to end here.
   *    Every other job keeps its own authored end, and a person who has none is simply given no
   *    income they did not author.
   *
   * Extending one job rather than all of them is what makes the answer mean something. "Could
   * you retire at 70?" has to be allowed to run employment five years longer than was written
   * down — that is the question — but only for the one job the person named, and the others are
   * left exactly as authored rather than swept along with it.
   *
   * The extension is a single continuous span: the named job keeps its original start and has
   * its end moved out, which is the same job never having finished rather than a second stint
   * bolted on. A job authored to end before the plan does therefore runs THROUGH whatever was
   * authored to follow it, and both pay. That overlap is the model, not a leak — it is what "if
   * this had carried on" means — and it is reported alongside the answer (see
   * {@link import("./retirementTypes").ContinuedJob.overlaps}) because it is also the part of
   * the scenario a reader would not predict.
   *
   * **Which** job is the user's to say, and it is not derivable from the plan. Dates carry no
   * information about whether work could continue past them, so no rule over them can pick the
   * right job: choosing the chronologically latest assumed the most recently-ENDING employment
   * was the continuable one, and a two-year contract taken at 65 after a thirty-year career is
   * exactly the job that is not. Asking per job — "may this one be extended?" — moved the
   * question to the right place but still left the engine choosing between the jobs that said
   * yes. One person, one named job: the selection is the answer, and this only reads it.
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
 *
 * Exported because the pre-"now" covered-earnings record has to read the SAME end this does.
 * The counterfactual is that the continued job never finished, and a person's earnings history
 * is part of what never finishing means — so a job continued from an end date already behind us
 * fills the years between that end and today. Deriving that separately would let the history and
 * the forward income series disagree about when one job stopped, which is exactly the drift this
 * module exists to prevent.
 */
export function employmentEndYearExclusive(
  job: Job,
  owner: Person,
  nowYear: number,
  scope: JobResolutionScope,
): number {
  const authored = authoredJobEndYearExclusive(job);
  if (scope.kind === "authored") return authored;
  const boundary = scope.stopWorking.boundaryYearExclusive;
  // Retiring no later than the plan already had them working is a pure truncation: there is
  // nothing to make up, so no job is carried past what it says. Checked before the extension so
  // the continuation job — which may well end EARLY — is never pulled forward to cover a later
  // job's years: "could you stop at 68?" must not answer by assuming you take your old job back
  // for three years you had already planned to spend in a different one.
  if (boundary <= authoredWorkPlanEndYearExclusive(owner)) return Math.min(authored, boundary);
  return job.id === continuationJobIdOf(owner, nowYear) ? boundary : authored;
}

/**
 * The exclusive year this person's authored working life ends — the last year any job of theirs
 * pays, and the pivot between capping and extending.
 *
 * `-Infinity` for someone with no jobs, which puts every boundary in the "after" branch, where
 * they have no continuation job either and so are simply never given income they did not author.
 */
function authoredWorkPlanEndYearExclusive(owner: Person): number {
  let latest = -Infinity;
  for (const j of owner.jobs) latest = Math.max(latest, authoredJobEndYearExclusive(j));
  return latest;
}

/**
 * **Which of this person's jobs a what-if may run past its authored end — the whole selection
 * rule, and the only reader of {@link Person.continuationJobId}.**
 *
 * `null` means no job is carried, and a candidate age past their authored plan therefore has no
 * income behind it. That is an answer, not a gap: the alternative is paying a household for
 * employment nobody said they could keep.
 *
 * A stated selection wins outright, including a stated `null`. It is checked against the jobs
 * they actually hold, so an id left dangling by a job removed elsewhere resolves to `null`
 * rather than to nothing at all — a dangling reference must not become an unbounded extension.
 * The authoring path clears the selection when it drops the job it named, so this only catches
 * a state restored from outside.
 *
 * **The initialization rule** runs only where nothing has been stated, and it is the one place
 * dates are consulted:
 *
 *  1. a job they are working **now** — that is what "continue working" means, and it is the
 *     answer for almost every household that never opens the picker;
 *  2. failing that, their earliest job still to **start** — a plan whose work is all ahead of it
 *     continues the first thing it comes to;
 *  3. failing that, `null`. Every job is behind them, and assuming any of that work would have
 *     carried on is not something to decide on a person's behalf. Those jobs remain selectable —
 *     the user may know one of them could have — they are simply never chosen for them.
 *
 * Deterministic at every step: several jobs running now resolve to the latest-ENDING one (the
 * one they would still be in after the others finish), and an exact tie to the first authored.
 * Both are arbitrary between equals, which is why they are stated here and pinned by a test
 * rather than left to `filter` order.
 *
 * This rule fires on **read**, never on write, and that is what makes the selection stable under
 * editing. Adding, removing or reordering jobs cannot revise a choice already made, because a
 * choice already made never reaches this code — and a household that has not chosen gets an
 * answer that follows their jobs rather than a stale one frozen at the moment the plan happened
 * to be created (for the primary, before a single job existed).
 */
export function continuationJobIdOf(person: Person, nowYear: number): JobId | null {
  const { jobs, continuationJobId: stated } = person;
  if (stated !== undefined) return jobs.some((j) => j.id === stated) ? stated : null;
  const active = jobs.filter((j) => j.startYear <= nowYear && authoredJobEndYearExclusive(j) > nowYear);
  if (active.length > 0) {
    return active.reduce((held, j) =>
      authoredJobEndYearExclusive(j) > authoredJobEndYearExclusive(held) ? j : held,
    ).id;
  }
  const future = jobs.filter((j) => j.startYear > nowYear);
  if (future.length > 0) {
    return future.reduce((held, j) => (j.startYear < held.startYear ? j : held)).id;
  }
  return null;
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
  const endYearExclusive = employmentEndYearExclusive(job, owner, nowYear, scope);
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
