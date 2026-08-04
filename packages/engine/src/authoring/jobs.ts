/**
 * Job authoring, and the whole of what the engine knows about **where a job lives**.
 *
 * A household member's jobs sit on one of two planes, and which one is a fact about the member,
 * not about the edit: the primary person's are standing plan data, a partner's ride the
 * `RelationshipEvent` that brought them into the household. Nothing outside this module needs
 * that distinction — the facade delegates here and the plane is worked out from the id.
 *
 * Two shapes of write, for two different reasons:
 *
 *  - **Plane-explicit creation.** `addProjectionJob` / `addProjectionPartnerJob` need the person
 *    a job belongs to, and a person is on one plane or the other, so the caller says which.
 *  - **Plane-agnostic adjustment.** One counter issues job ids across both planes, so an id
 *    names one job in the household or nothing at all — "give job-3 a raise" has one answer, and
 *    the caller does not have to know which plane job-3 is authored on to ask for it.
 *
 * A job cannot change owner. Re-reading its dates against a different birthday would shift the
 * employment in time or shift it to a different age, both rewriting something the person stated,
 * so moving a job between household members is delete-and-re-add and not a field edit.
 *
 * The partner plane is written through the same replay-validated path a revision uses, so a
 * partner-job edit that would strand a later event is refused exactly as any other would be.
 */

import type {
  Job,
  JobIncomeOverrideInput,
  JobPatch,
  JobPayChangeInput,
  PersonId,
} from "../job";
import type { RetirementStrategy } from "../job";
import {
  DEFAULT_RETIREMENT_STRATEGY,
  deferralFractionOf,
  mapJob,
  monthlyIncomeCentsOf,
  startingMonthlyIncomeCentsOf,
  withCurrentMonthlyIncome,
  withDeferralFraction,
  withIncomeOverride,
  withJobPatch,
  withMonthlyIncome,
  withStartingMonthlyIncome,
  withoutIncomeOverride,
  withoutPayChange,
  withPayChange,
} from "../job";
import { MAX_LIVED_AGE } from "../plan";
import type { Jurisdiction } from "../jurisdiction";
import type { Cents } from "../money";
import type { NewLifeEvent, RelationshipEvent } from "../ledger/eventTypes";
import type { ProjectionState, Written } from "./state";
import { planSite, withStatePlan } from "./state";
import { mint } from "./mint";
import { replaceEvent } from "./eventWrite";

/**
 * A job as a caller authors it — no `id` and no `ownerId`. The engine issues the id and the
 * plane it lands on stamps the owner.
 *
 * {@link Job.retirementStrategy} is the one field that may be left out, and the only field with
 * a default anywhere in the model. It is a policy about a hypothetical, not a fact about the
 * employment, so a caller stating what a job IS should not have to answer it — every other
 * authored field describes the job itself and has no defensible default. {@link
 * DEFAULT_RETIREMENT_STRATEGY} is applied here, at the boundary, so the resolved {@link Job} is
 * total and nothing downstream ever has to decide what an absent policy meant.
 */
export type JobInput = Omit<Job, "id" | "ownerId" | "retirementStrategy"> & {
  readonly retirementStrategy?: RetirementStrategy;
};

/**
 * A {@link JobInput} resolved into the {@link Job} that gets stored — identity stamped, policy
 * defaulted. The single place both happen, so the two write paths (create and replace, on both
 * planes) cannot disagree about either.
 *
 * Exported for `relationships.ts`, which mints a partner's jobs inline with the person they
 * belong to and so cannot route through the writes below.
 */
export function resolveJobInput(job: JobInput, id: string, ownerId: PersonId): Job {
  return {
    ...job,
    id,
    ownerId,
    retirementStrategy: job.retirementStrategy ?? DEFAULT_RETIREMENT_STRATEGY,
  };
}

// Finding a job: the plane lookups every write and read below is built on.

/** The `RelationshipEvent` a partner joined on, or a refusal naming the person. */
export function relationshipFor(
  state: ProjectionState,
  personId: PersonId,
): RelationshipEvent {
  for (const event of state.scenario.ledger.events) {
    if (event.type === "RelationshipEvent" && event.person.id === personId) return event;
  }
  throw new Error(
    `Projection: cannot author a partner job — no partner "${personId}" in this timeline`,
  );
}

/**
 * The event and job for a partner-owned job id, or a refusal naming the id — see `planSite` for
 * why an id that is not there is refused rather than skipped.
 */
function partnerJobSite(
  state: ProjectionState,
  jobId: string,
): { event: RelationshipEvent; job: Job } {
  for (const event of state.scenario.ledger.events) {
    if (event.type !== "RelationshipEvent") continue;
    const job = event.person.jobs.find((j) => j.id === jobId);
    if (job !== undefined) return { event, job };
  }
  throw new Error(`Projection: cannot edit a partner job — no partner holds a job "${jobId}"`);
}

/** Whether the plan plane holds this job — the cheap half of the plane question. */
function onPlan(state: ProjectionState, jobId: string): boolean {
  return state.scenario.plan.jobs.some((j) => j.id === jobId);
}

/**
 * Rebuild a partner's job list onto the event that carries it — the one place `person.jobs` is
 * ever reassembled. Routed through the whole-ledger replay a revision uses, so a rewrite that
 * would strand a later event is refused with the state untouched, and the ledger and the counter
 * land as ONE new state (a refused write consumes no id).
 */
function withPartnerJobs(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  event: RelationshipEvent,
  jobs: readonly Job[],
  nextSeq?: number,
): ProjectionState {
  const next: NewLifeEvent = { ...event, person: { ...event.person, jobs } };
  return replaceEvent(state, jurisdiction, event.id, next, nextSeq);
}

/**
 * Apply one of `job`'s authoring transforms to a plan-plane job. Every plan-plane setter routes
 * through here, so each is the transform's name and nothing else.
 */
function editPlanJob(
  state: ProjectionState,
  id: string,
  f: (job: Job) => Job,
  nextSeq?: number,
): ProjectionState {
  const plan = planSite(state, "jobs", id);
  return withStatePlan(state, { ...plan, jobs: mapJob(plan.jobs, id, f) }, nextSeq);
}

/** The partner-plane counterpart of {@link editPlanJob}. */
function editPartnerJob(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  jobId: string,
  f: (job: Job) => Job,
  nextSeq?: number,
): ProjectionState {
  const { event } = partnerJobSite(state, jobId);
  return withPartnerJobs(
    state,
    jurisdiction,
    event,
    event.person.jobs.map((j) => (j.id === jobId ? f(j) : j)),
    nextSeq,
  );
}

/** Whichever plane holds `jobId`, or a refusal naming it. */
function editJobAnywhere(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  jobId: string,
  f: (job: Job) => Job,
  nextSeq?: number,
): ProjectionState {
  if (onPlan(state, jobId)) return editPlanJob(state, jobId, f, nextSeq);
  for (const event of state.scenario.ledger.events) {
    if (event.type !== "RelationshipEvent") continue;
    if (event.person.jobs.some((j) => j.id === jobId)) {
      return editPartnerJob(state, jurisdiction, jobId, f, nextSeq);
    }
  }
  throw new Error(`Projection: cannot edit a job — no job "${jobId}" in this household`);
}

/**
 * Refuse a job whose start or end age falls past what a person can live to.
 *
 * A job is authored in calendar YEARS, so its ages are only meaningful against whose job it is:
 * the owner's birth year turns `startYear`/`endYear` into "at what age". The primary's birth
 * year is the plan's own `startYear − currentAge`; a partner carries theirs on the event they
 * joined on.
 *
 * Both ends are bounded, because both are authored: every job states when it ends.
 * {@link Job.retirementStrategy} is deliberately not consulted — an extendable job may be
 * carried past this bound by a solver candidate, but only inside a hypothesis that is never
 * stored, and capping the authored end is about what the user may write down.
 */
function assertJobAgesWithin(state: ProjectionState, ownerId: PersonId, job: JobInput): void {
  const birthYear = birthYearOf(state, ownerId);
  const ages: readonly (readonly [string, number])[] = [
    ["start age", job.startYear - birthYear],
    ["end age", job.endYear - birthYear],
  ];
  for (const [label, age] of ages) {
    if (age > MAX_LIVED_AGE) {
      throw new Error(
        `Projection: cannot author a job with ${label} ${age} — it may not exceed ${MAX_LIVED_AGE}`,
      );
    }
  }
}

/**
 * Whose birth year to read a job's calendar years against. The primary person holds no `Person`
 * record on the plan — their age IS the plan's `currentAge` at the frozen `startYear` — so the
 * two planes answer this differently and this is where that difference is settled.
 */
function birthYearOf(state: ProjectionState, personId: PersonId): number {
  for (const event of state.scenario.ledger.events) {
    if (event.type === "RelationshipEvent" && event.person.id === personId) {
      return event.person.birthYear;
    }
  }
  return state.startYear - state.scenario.plan.currentAge;
}

// Standing (plan-plane) jobs.

/**
 * Add a job to the plan plane, answering with the minted `"job-N"` id.
 *
 * Every {@link JobInput} field carries through — one-month overrides, permanent pay changes and
 * the display name — so re-adding a job deleted from another member preserves its whole history.
 */
export function addProjectionJob(
  state: ProjectionState,
  personId: PersonId,
  job: JobInput,
): Written<string> {
  assertJobAgesWithin(state, personId, job);
  const { id, nextSeq } = mint(state, "job");
  const newJob = resolveJobInput(job, id, personId);
  const plan = state.scenario.plan;
  return {
    state: withStatePlan(state, { ...plan, jobs: [...(plan.jobs ?? []), newJob] }, nextSeq),
    result: id,
  };
}

/**
 * Rewrite one job wholesale, keeping its `id` and its list position — the counterpart to
 * {@link updateProjectionJob}'s field-wise patch, for a caller holding a whole new definition
 * rather than a diff.
 *
 * The difference is what an *absent* field means. A patch carries only what it names, so it can
 * never clear a field; this replaces, so a job arriving with no `deferral` and no `name` comes
 * out with neither. That is what a form re-submitted with the 401(k) rate zeroed and the name
 * blanked has to mean.
 *
 * `ownerId` stays as it was — a job cannot change owner, so nothing an edit carries can restate
 * it.
 */
export function replaceProjectionJob(
  state: ProjectionState,
  id: string,
  job: JobInput,
): ProjectionState {
  return editPlanJob(state, id, (prior) => {
    assertJobAgesWithin(state, prior.ownerId, job);
    return resolveJobInput(job, prior.id, prior.ownerId);
  });
}

/**
 * Rewrite one job's fields in place, keeping its `id` — see {@link withJobPatch} for what
 * carries through.
 *
 * Editing a job changes the income the projection base compiles, but never re-validates the
 * ledger: the affordability gate is an append-time check, so a transaction already accepted
 * stays accepted. That matches the app, whose gate also fires only on append.
 */
export function updateProjectionJob(
  state: ProjectionState,
  id: string,
  patch: JobPatch,
): ProjectionState {
  return editPlanJob(state, id, (j) => withJobPatch(j, patch));
}

/**
 * Drop a plan-plane job. Unlike a goal there is nothing to guard: a job derives no account an
 * event can reference, so no ledger reference can dangle.
 */
export function removeProjectionJob(state: ProjectionState, id: string): ProjectionState {
  const plan = planSite(state, "jobs", id);
  return withStatePlan(state, { ...plan, jobs: plan.jobs.filter((j) => j.id !== id) });
}

// Partner (ledger-plane) jobs. These exist so no caller ever has to rebuild `event.person.jobs`
// itself: that array is the whole authoring surface of a partner's income, and rebuilding it
// outside this module means minting ids off a counter it does not control.

/**
 * Add a job to a partner — the ledger-plane counterpart of {@link addProjectionJob}, answering
 * with the minted `"job-N"` id.
 *
 * The id comes off the SAME counter every other minted id does, in the same `job-N` shape: one
 * namespace across both planes, which is what lets the counter floor recognize a partner's job
 * on the way back in and step past it.
 *
 * The id is always minted; a caller cannot name a job.
 */
export function addProjectionPartnerJob(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  personId: PersonId,
  job: JobInput,
): Written<string> {
  const event = relationshipFor(state, personId);
  assertJobAgesWithin(state, personId, job);
  const { id, nextSeq } = mint(state, "job");
  const newJob = resolveJobInput(job, id, personId);
  return {
    state: withPartnerJobs(state, jurisdiction, event, [...event.person.jobs, newJob], nextSeq),
    result: id,
  };
}

/**
 * Rewrite one partner-owned job wholesale, keeping its id, owner and list position — see
 * {@link replaceProjectionJob}, of which this is the ledger-plane counterpart, for why an absent
 * field clears rather than carries through.
 */
export function replaceProjectionPartnerJob(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  jobId: string,
  job: JobInput,
): ProjectionState {
  const { event, job: prior } = partnerJobSite(state, jobId);
  assertJobAgesWithin(state, prior.ownerId, job);
  return withPartnerJobs(
    state,
    jurisdiction,
    event,
    event.person.jobs.map((j) => (j.id === jobId ? resolveJobInput(job, j.id, j.ownerId) : j)),
  );
}

/** See {@link updateProjectionJob} — the field-wise patch, on a partner's plane. */
export function updateProjectionPartnerJob(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  jobId: string,
  patch: JobPatch,
): ProjectionState {
  return editPartnerJob(state, jurisdiction, jobId, (j) => withJobPatch(j, patch));
}

/** Drop a partner-owned job. See {@link removeProjectionJob}: there is nothing to guard. */
export function removeProjectionPartnerJob(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  jobId: string,
): ProjectionState {
  const { event } = partnerJobSite(state, jobId);
  return withPartnerJobs(
    state,
    jurisdiction,
    event,
    event.person.jobs.filter((j) => j.id !== jobId),
  );
}

// Adjustments to ONE job, addressed by its id alone — see the plane-agnostic note at the top.

/** See {@link withMonthlyIncome} — monthly cents in, annualized salary stored. */
export function setProjectionJobMonthlyIncome(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  id: string,
  monthlyCents: number,
): ProjectionState {
  return editJobAnywhere(state, jurisdiction, id, (j) => withMonthlyIncome(j, monthlyCents));
}

/** See {@link withStartingMonthlyIncome} — the start anchor alone, current pay untouched. */
export function setProjectionJobStartingMonthlyIncome(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  id: string,
  monthlyCents: number,
): ProjectionState {
  return editJobAnywhere(state, jurisdiction, id, (j) => withStartingMonthlyIncome(j, monthlyCents));
}

/** See {@link withCurrentMonthlyIncome} — the month-0 anchor alone, start pay untouched. */
export function setProjectionJobCurrentMonthlyIncome(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  id: string,
  monthlyCents: number,
): ProjectionState {
  return editJobAnywhere(state, jurisdiction, id, (j) => withCurrentMonthlyIncome(j, monthlyCents));
}

/**
 * See {@link withDeferralFraction}. It exists beside {@link updateProjectionJob} because 0
 * *removes* the deferral and a positive fraction preserves the funded account and employer match
 * — an asymmetry a `deferral` patch, which replaces the whole object, cannot express.
 */
export function setProjectionJobDeferralFraction(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  id: string,
  fraction: number,
): ProjectionState {
  return editJobAnywhere(state, jurisdiction, id, (j) => withDeferralFraction(j, fraction));
}

/**
 * See {@link withPayChange} — a permanent raise or cut, at most one per (job, month).
 *
 * The id is minted here rather than accepted, like every other identity in the model: an
 * authoring input carries no id, so a caller cannot name one into existence or hand two
 * adjustments the same one. Answers with it, since a caller that just authored an adjustment is
 * usually the one that needs to address it next.
 */
export function addProjectionJobPayChange(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  jobId: string,
  payChange: JobPayChangeInput,
): Written<string> {
  const { id, nextSeq } = mint(state, "adjustment");
  return {
    state: editJobAnywhere(
      state,
      jurisdiction,
      jobId,
      (j) => withPayChange(j, { ...payChange, id }),
      nextSeq,
    ),
    result: id,
  };
}

/** See {@link withoutPayChange} — addressed by the adjustment's own id. */
export function removeProjectionJobPayChange(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  jobId: string,
  payChangeId: string,
): ProjectionState {
  return editJobAnywhere(state, jurisdiction, jobId, (j) => withoutPayChange(j, payChangeId));
}

/**
 * See {@link withIncomeOverride} — a one-month perturbation, not a new salary segment, and one
 * of any number that may share a month. The minted id is what keeps stacked siblings apart, so
 * it is answered back for a caller that wants to remove or re-address this one.
 */
export function addProjectionJobIncomeOverride(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  jobId: string,
  override: JobIncomeOverrideInput,
): Written<string> {
  const { id, nextSeq } = mint(state, "adjustment");
  return {
    state: editJobAnywhere(
      state,
      jurisdiction,
      jobId,
      (j) => withIncomeOverride(j, { ...override, id }),
      nextSeq,
    ),
    result: id,
  };
}

/** See {@link withoutIncomeOverride} — addressed by id, since a month may hold several. */
export function removeProjectionJobIncomeOverride(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  jobId: string,
  overrideId: string,
): ProjectionState {
  return editJobAnywhere(state, jurisdiction, jobId, (j) => withoutIncomeOverride(j, overrideId));
}

// Reads. Ownership is on the job, so a caller reading pay or deferral never has to know which
// plane it came off.

/**
 * Every job in the household, both planes at once: the primary person's stand on the plan, a
 * partner's ride the `RelationshipEvent` that brought them in.
 */
export function householdJobs(state: ProjectionState): readonly Job[] {
  const s = state.scenario;
  const jobs: Job[] = [...s.plan.jobs];
  for (const event of s.ledger.events) {
    if (event.type === "RelationshipEvent") jobs.push(...event.person.jobs);
  }
  return jobs;
}

/** A job id names one job across both planes, or it names nothing — never a silent 0. */
function jobOrThrow(state: ProjectionState, jobId: string): Job {
  const job = householdJobs(state).find((j) => j.id === jobId);
  if (job === undefined) {
    throw new Error(`Projection: cannot read a job — no job "${jobId}" in this household`);
  }
  return job;
}

/**
 * What a job pays a month **as authored** — its starting salary, not what any given month
 * resolves to once growth, spans and overrides are applied. That is deliberately the figure a
 * job's headline shows: a dated change is listed beside it rather than folded into it.
 */
export function jobMonthlyIncomeCentsOf(state: ProjectionState, jobId: string): Cents {
  return monthlyIncomeCentsOf(jobOrThrow(state, jobId));
}

/**
 * What a job paid a month in its own `startYear` — the other authored anchor, and the one an
 * editor showing a job's pay history opens its first field on. Read separately from
 * {@link jobMonthlyIncomeCentsOf} because neither derives from the other.
 */
export function jobStartingMonthlyIncomeCentsOf(state: ProjectionState, jobId: string): Cents {
  return startingMonthlyIncomeCentsOf(jobOrThrow(state, jobId));
}

/**
 * One job's elected pre-tax 401(k) fraction of gross. Absent election reads as 0, so a caller
 * never has to distinguish "no deferral" from "deferring nothing" — the read counterpart of
 * {@link setProjectionJobDeferralFraction}, which erases a 0 rather than recording it.
 */
export function jobDeferralFractionOf(state: ProjectionState, jobId: string): number {
  return deferralFractionOf(jobOrThrow(state, jobId));
}

/** The same as {@link jobMonthlyIncomeCentsOf}, summed over one person's jobs. */
export function personMonthlyIncomeCentsOf(state: ProjectionState, personId: PersonId): Cents {
  return householdJobs(state)
    .filter((j) => j.ownerId === personId)
    .reduce((sum, j) => sum + monthlyIncomeCentsOf(j), 0);
}

/** Standing pay across every earner. Sizing a household's budget off one earner's is wrong. */
export function householdMonthlyIncomeCentsOf(state: ProjectionState): Cents {
  return householdJobs(state).reduce((sum, j) => sum + monthlyIncomeCentsOf(j), 0);
}

/**
 * One person's pre-tax 401(k) deferral as a fraction of their gross, blended across their jobs —
 * each job elects its own, so the household-level figure is a weighted average and not any one
 * election. 0 when they earn nothing.
 */
export function personDeferralFractionOf(state: ProjectionState, personId: PersonId): number {
  const jobs = householdJobs(state).filter((j) => j.ownerId === personId);
  // Weighted by CURRENT pay — the blend is what they defer now, so a decades-stale starting
  // salary would weight the jobs against each other wrongly.
  const grossCents = jobs.reduce((sum, j) => sum + j.salary.currentSalaryCents, 0);
  if (grossCents <= 0) return 0;
  const deferredCents = jobs.reduce(
    (sum, j) => sum + j.salary.currentSalaryCents * deferralFractionOf(j),
    0,
  );
  return deferredCents / grossCents;
}
