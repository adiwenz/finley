/**
 * The job module tested as what it is: plain functions of {@link ProjectionState}, with no
 * handle in sight.
 *
 * `projectionFacade.test.ts` already covers job authoring through `Projection`, and that stays the
 * behavioural contract. What is asserted HERE is what only the extracted shape can state — that
 * the two-plane knowledge lives in this module, that each write is a pure derivation leaving its
 * input untouched, and that a refusal therefore derives nothing rather than half-writing.
 */

import { describe, expect, it } from "vitest";
import { Projection } from "../projectionFacade";
import type { ProjectionState } from "./state";
import { nullJurisdiction } from "../jurisdiction";
import { dollarsToCents } from "../cashFlowSeries";
import { samplePlan, stateOf, SAMPLE_START_YEAR } from "../testing/samplePlan";
import type { PersonId } from "../job";
import { PRIMARY_PERSON_ID } from "../compile/projectionBase";
import {
  addProjectionJob,
  addProjectionJobPayChange,
  addProjectionPartnerJob,
  householdJobs,
  relationshipFor,
  removeProjectionJob,
  removeProjectionPartnerJob,
  setProjectionContinuationJob,
} from "./jobs";

const longRunningJob = {
  startYear: SAMPLE_START_YEAR,
  endYear: 2090,
  salary: { startingSalaryCents: dollarsToCents(100000), currentSalaryCents: dollarsToCents(100000), realGrowthPct: 0 },
} as const;

/** Empty collections so minted ids and roster counts reflect only what a test adds. */
function emptyState(): ProjectionState {
  return stateOf({ ...samplePlan, jobs: [], budgetLines: [] });
}

/** A state holding one partner, and their person id — the ledger plane, authored properly. */
function withPartner(): { state: ProjectionState; partnerId: PersonId } {
  const p = Projection.fromState(emptyState(), nullJurisdiction);
  const partnerId = p.marry({ month: 24, name: "Sam", birthYear: 1988 }) as PersonId;
  return { state: p.toState(), partnerId };
}

/** A partner's jobs, read off the event that carries them. */
function partnerJobs(state: ProjectionState, partnerId: PersonId) {
  return relationshipFor(state, partnerId).person.jobs;
}

describe("job authoring — a write derives, it does not mutate", () => {
  it("leaves the state it was handed untouched", () => {
    const before = emptyState();
    const { state: after } = addProjectionJob(before, PRIMARY_PERSON_ID as PersonId, longRunningJob);

    expect(before.scenario.plan.jobs).toEqual([]);
    expect(after.scenario.plan.jobs).toHaveLength(1);
    // The counter advanced on the derived state alone.
    expect(before.nextSeq).toBe(1);
    expect(after.nextSeq).toBe(2);
  });

  it("answers with the minted id beside the next state", () => {
    const { state, result } = addProjectionJob(
      emptyState(),
      PRIMARY_PERSON_ID as PersonId,
      longRunningJob,
    );
    expect(result).toBe("job-1");
    expect(state.scenario.plan.jobs[0]?.id).toBe("job-1");
  });
});

describe("job authoring — the module owns which plane a job lives on", () => {
  it("puts a primary person's job on the plan and a partner's on their event", () => {
    const { state, partnerId } = withPartner();
    const { state: withBoth } = addProjectionPartnerJob(
      state,
      nullJurisdiction,
      partnerId,
      longRunningJob,
    );
    const { state: final } = addProjectionJob(
      withBoth,
      PRIMARY_PERSON_ID as PersonId,
      longRunningJob,
    );

    // Neither plane holds the other's job…
    expect(final.scenario.plan.jobs.map((j) => j.ownerId)).toEqual([PRIMARY_PERSON_ID]);
    expect(partnerJobs(final, partnerId).map((j) => j.ownerId)).toEqual([partnerId]);
    // …and a read spans both without being told which is which.
    expect(householdJobs(final)).toHaveLength(2);
  });

  it("finds a job by id alone, whichever plane authored it", () => {
    const { state, partnerId } = withPartner();
    const { state: withPartnerJob, result: partnerJobId } = addProjectionPartnerJob(
      state,
      nullJurisdiction,
      partnerId,
      longRunningJob,
    );
    const { state: both, result: planJobId } = addProjectionJob(
      withPartnerJob,
      PRIMARY_PERSON_ID as PersonId,
      longRunningJob,
    );

    // One call shape, two storage planes — the caller never names either. A pay change is one of
    // several writes routed through the plane-agnostic finder, so it stands in for that path here.
    const withPlanChange = addProjectionJobPayChange(both, nullJurisdiction, planJobId, {
      month: 12,
      kind: "setTo",
      cents: dollarsToCents(9000),
    }).state;
    const raised = addProjectionJobPayChange(withPlanChange, nullJurisdiction, partnerJobId, {
      month: 12,
      kind: "setTo",
      cents: dollarsToCents(7000),
    }).state;

    const jobById = (id: string) => householdJobs(raised).find((j) => j.id === id);
    expect(jobById(planJobId)?.payChanges).toHaveLength(1);
    expect(jobById(partnerJobId)?.payChanges).toHaveLength(1);
  });

  it("refuses an id neither plane holds, naming it", () => {
    const state = emptyState();
    expect(() =>
      addProjectionJobPayChange(state, nullJurisdiction, "job-99", {
        month: 12,
        kind: "setTo",
        cents: 1,
      }),
    ).toThrow(/no job "job-99" in this household/);
  });
});

/**
 * The continuation selection is a field on a PERSON that names a job, which makes it the one
 * place the two planes have to be crossed rather than kept apart: the write settles the plane
 * from the person's id, and validates the job against the whole household.
 */
describe("job authoring — the continuation selection", () => {
  it("writes the primary's to the plan and a partner's to their event", () => {
    const { state, partnerId } = withPartner();
    const { state: withPartnerJob, result: partnerJobId } = addProjectionPartnerJob(
      state,
      nullJurisdiction,
      partnerId,
      longRunningJob,
    );
    const { state: both, result: planJobId } = addProjectionJob(
      withPartnerJob,
      PRIMARY_PERSON_ID as PersonId,
      longRunningJob,
    );

    const chosen = setProjectionContinuationJob(
      setProjectionContinuationJob(both, nullJurisdiction, PRIMARY_PERSON_ID as PersonId, planJobId),
      nullJurisdiction,
      partnerId,
      partnerJobId,
    );

    expect(chosen.scenario.plan.continuationJobId).toBe(planJobId);
    expect(relationshipFor(chosen, partnerId).person.continuationJobId).toBe(partnerJobId);
  });

  it("refuses a job belonging to somebody else, naming both", () => {
    // Left unchecked this would either lose the choice silently on read, or extend one member's
    // employment when a different member worked longer. Neither is a thing to guess at.
    const { state, partnerId } = withPartner();
    const { state: withJob, result: planJobId } = addProjectionJob(
      state,
      PRIMARY_PERSON_ID as PersonId,
      longRunningJob,
    );

    expect(() =>
      setProjectionContinuationJob(withJob, nullJurisdiction, partnerId, planJobId),
    ).toThrow(new RegExp(`${planJobId}.*${partnerId}.*${PRIMARY_PERSON_ID}`));
    expect(() =>
      setProjectionContinuationJob(withJob, nullJurisdiction, PRIMARY_PERSON_ID as PersonId, "job-99"),
    ).toThrow(/no job "job-99" in this household/);
  });

  it("clears a selection when the job it named is removed, on either plane", () => {
    // The one moment the selection changes without the user choosing. It falls to an explicit
    // None rather than back to "never chosen", so removing a job cannot quietly nominate a
    // different one in its place.
    const { state, partnerId } = withPartner();
    const { state: withPartnerJob, result: partnerJobId } = addProjectionPartnerJob(
      state,
      nullJurisdiction,
      partnerId,
      longRunningJob,
    );
    const { state: both, result: planJobId } = addProjectionJob(
      withPartnerJob,
      PRIMARY_PERSON_ID as PersonId,
      longRunningJob,
    );
    let chosen = setProjectionContinuationJob(
      both,
      nullJurisdiction,
      PRIMARY_PERSON_ID as PersonId,
      planJobId,
    );
    chosen = setProjectionContinuationJob(chosen, nullJurisdiction, partnerId, partnerJobId);

    const primaryDropped = removeProjectionJob(chosen, planJobId);
    expect(primaryDropped.scenario.plan.continuationJobId).toBeNull();

    const partnerDropped = removeProjectionPartnerJob(chosen, nullJurisdiction, partnerJobId);
    expect(relationshipFor(partnerDropped, partnerId).person.continuationJobId).toBeNull();
    // Removing one member's job leaves the other member's answer exactly as it was.
    expect(partnerDropped.scenario.plan.continuationJobId).toBe(planJobId);
  });

  it("leaves a selection alone when some OTHER job is removed", () => {
    const { state: withFirst, result: keptId } = addProjectionJob(
      emptyState(),
      PRIMARY_PERSON_ID as PersonId,
      longRunningJob,
    );
    const { state: both, result: doomedId } = addProjectionJob(
      withFirst,
      PRIMARY_PERSON_ID as PersonId,
      longRunningJob,
    );
    const chosen = setProjectionContinuationJob(
      both,
      nullJurisdiction,
      PRIMARY_PERSON_ID as PersonId,
      keptId,
    );

    expect(removeProjectionJob(chosen, doomedId).scenario.plan.continuationJobId).toBe(keptId);
  });
});
