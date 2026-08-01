/**
 * Job authoring, and the whole of what the engine knows about **where a job lives**.
 *
 * A household member's jobs sit on one of two planes, and which one is a fact about the member,
 * not about the edit: the primary person's are standing plan data, a partner's ride the
 * `RelationshipEvent` that brought them into the household. Nothing outside this module needs
 * that distinction — the facade delegates here and the plane is worked out from the id.
 *
 * Three shapes of write, for three different reasons:
 *
 *  - **Plane-explicit creation.** `addProjectionJob` / `addProjectionPartnerJob` need the person
 *    a job belongs to, and a person is on one plane or the other, so the caller says which.
 *  - **Plane-agnostic adjustment.** One counter issues job ids across both planes, so an id
 *    names one job in the household or nothing at all — "give job-3 a raise" has one answer, and
 *    the caller does not have to know which plane job-3 is authored on to ask for it.
 *  - **Crossing.** {@link reassignProjectionJob} is a removal from one plane and a landing on
 *    the other, keeping the id.
 *
 * The partner plane is written through the same replay-validated path a revision uses, so a
 * partner-job edit that would strand a later event is refused exactly as any other would be.
 */

import type { Job, JobIncomeOverride, JobPatch, JobPayChange, PersonId } from "../job";
import {
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
import type { Jurisdiction } from "../jurisdiction";
import type { Cents } from "../money";
import type { NewLifeEvent, RelationshipEvent } from "../ledger/eventTypes";
import { PRIMARY_PERSON_ID } from "../projectionBase";
import type { ProjectionState, Written } from "./state";
import { planSite, withStatePlan } from "./state";
import { mint } from "./mint";
import { replaceEvent } from "./eventWrite";

/**
 * A job as a caller authors it — no `id` and no `ownerId`. The engine issues the id and the
 * plane it lands on stamps the owner. Relocating a job between members without re-minting is
 * {@link reassignProjectionJob}, which takes the existing id as an argument rather than letting
 * one ride in here.
 */
export type JobInput = Omit<Job, "id" | "ownerId">;

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

/** Whether this member's jobs live on the ledger plane — i.e. they joined as a partner. */
function isPartner(state: ProjectionState, personId: PersonId): boolean {
  return state.scenario.ledger.events.some(
    (e) => e.type === "RelationshipEvent" && e.person.id === personId,
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
): ProjectionState {
  const plan = planSite(state, "jobs", id);
  return withStatePlan(state, { ...plan, jobs: mapJob(plan.jobs, id, f) });
}

/** The partner-plane counterpart of {@link editPlanJob}. */
function editPartnerJob(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  jobId: string,
  f: (job: Job) => Job,
): ProjectionState {
  const { event } = partnerJobSite(state, jobId);
  return withPartnerJobs(
    state,
    jurisdiction,
    event,
    event.person.jobs.map((j) => (j.id === jobId ? f(j) : j)),
  );
}

/** Whichever plane holds `jobId`, or a refusal naming it. */
function editJobAnywhere(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  jobId: string,
  f: (job: Job) => Job,
): ProjectionState {
  if (onPlan(state, jobId)) return editPlanJob(state, jobId, f);
  for (const event of state.scenario.ledger.events) {
    if (event.type !== "RelationshipEvent") continue;
    if (event.person.jobs.some((j) => j.id === jobId)) {
      return editPartnerJob(state, jurisdiction, jobId, f);
    }
  }
  throw new Error(`Projection: cannot edit a job — no job "${jobId}" in this household`);
}

// Standing (plan-plane) jobs.

/**
 * Add a job to the plan plane, answering with the minted `"job-N"` id.
 *
 * Every {@link JobInput} field carries through: a job arriving here may be an *existing* one
 * moving between household members, and it keeps its one-month overrides, permanent pay changes
 * and display name across the move.
 */
export function addProjectionJob(
  state: ProjectionState,
  personId: PersonId,
  job: JobInput,
): Written<string> {
  const { id, nextSeq } = mint(state, "job");
  const newJob: Job = { ...job, id, ownerId: personId };
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
 * `ownerId` stays as it was — reassignment is a two-plane move, not a field edit.
 */
export function replaceProjectionJob(
  state: ProjectionState,
  id: string,
  job: JobInput,
): ProjectionState {
  return editPlanJob(state, id, (prior) => ({ ...job, id: prior.id, ownerId: prior.ownerId }));
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
 * The id is always minted; a caller cannot name a job. Moving an EXISTING job onto this plane
 * keeps its id, and is {@link reassignProjectionJob}.
 */
export function addProjectionPartnerJob(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  personId: PersonId,
  job: JobInput,
): Written<string> {
  const event = relationshipFor(state, personId);
  const { id, nextSeq } = mint(state, "job");
  const newJob: Job = { ...job, id, ownerId: personId };
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
  const { event } = partnerJobSite(state, jobId);
  return withPartnerJobs(
    state,
    jurisdiction,
    event,
    event.person.jobs.map((j) =>
      j.id === jobId ? ({ ...job, id: j.id, ownerId: j.ownerId } as Job) : j,
    ),
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

/**
 * Hand a job to another household member, keeping its `id` — and with it every adjustment
 * addressed by that id: one-month income overrides, permanent pay changes, the employer match.
 *
 * This is the ONE operation that needs an already-issued job id, and it takes it as an argument
 * rather than letting one ride in on a {@link JobInput}, so authoring a job and relocating one
 * stay different verbs and no caller can name a job into existence.
 *
 * A move crosses the two planes, so it is a removal from one and a landing on the other. Both
 * are derived here in that order (the id is never live in both places), and the target member is
 * proved to exist BEFORE the source gives the job up, so a bad owner cannot strip a job from
 * whoever holds it. A refusal from either plane throws having derived nothing, so a job can
 * never end up in neither list.
 *
 * `job` carries the fields the move lands with, so a form that re-owns a job and edits it is one
 * write. An `ownerId` is not among them: the target names the owner.
 */
export function reassignProjectionJob(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  jobId: string,
  toOwnerId: PersonId,
  job: JobInput,
): ProjectionState {
  // Proved BEFORE the source gives the job up: a member is either the primary person, whose jobs
  // are standing plan data, or a partner, whose ride their `RelationshipEvent`. Anyone else is
  // not in the household, and a job handed to them would vanish from both planes.
  const toPartner = isPartner(state, toOwnerId);
  if (!toPartner && toOwnerId !== PRIMARY_PERSON_ID) {
    throw new Error(
      `Projection: cannot reassign a job — no household member "${toOwnerId}" to own it`,
    );
  }

  const plan = state.scenario.plan;
  const lifted = onPlan(state, jobId)
    ? withStatePlan(state, { ...plan, jobs: plan.jobs.filter((j) => j.id !== jobId) })
    : // Refuses an id neither plane holds, naming it.
      removeProjectionPartnerJob(state, jurisdiction, jobId);

  const landed: Job = { ...job, id: jobId, ownerId: toOwnerId };
  if (toPartner) {
    // Re-read off the lifted state: the removal derived a new one, so an event captured before
    // it is stale.
    const event = relationshipFor(lifted, toOwnerId);
    return withPartnerJobs(lifted, jurisdiction, event, [...event.person.jobs, landed]);
  }
  const after = lifted.scenario.plan;
  return withStatePlan(lifted, { ...after, jobs: [...after.jobs, landed] });
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

/** See {@link withPayChange} — a permanent raise or cut, at most one per (job, month). */
export function addProjectionJobPayChange(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  jobId: string,
  payChange: JobPayChange,
): ProjectionState {
  return editJobAnywhere(state, jurisdiction, jobId, (j) => withPayChange(j, payChange));
}

/** See {@link withoutPayChange}. */
export function removeProjectionJobPayChange(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  jobId: string,
  month: number,
): ProjectionState {
  return editJobAnywhere(state, jurisdiction, jobId, (j) => withoutPayChange(j, month));
}

/** See {@link withIncomeOverride} — a one-month perturbation, not a new salary segment. */
export function addProjectionJobIncomeOverride(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  jobId: string,
  override: JobIncomeOverride,
): ProjectionState {
  return editJobAnywhere(state, jurisdiction, jobId, (j) => withIncomeOverride(j, override));
}

/** See {@link withoutIncomeOverride}. */
export function removeProjectionJobIncomeOverride(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  jobId: string,
  month: number,
): ProjectionState {
  return editJobAnywhere(state, jurisdiction, jobId, (j) => withoutIncomeOverride(j, month));
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
