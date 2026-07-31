/**
 * The job module tested as what it is: plain functions of {@link ProjectionState}, with no
 * handle in sight.
 *
 * `projectionRoot.test.ts` already covers job authoring through `Projection`, and that stays the
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
import { PRIMARY_PERSON_ID } from "../projectionBase";
import {
  addProjectionJob,
  addProjectionPartnerJob,
  householdJobs,
  jobMonthlyIncomeCentsOf,
  reassignProjectionJob,
  relationshipFor,
  setProjectionJobMonthlyIncome,
} from "./jobs";

const openEndedJob = {
  startYear: SAMPLE_START_YEAR,
  endYear: null,
  salary: { startingSalaryCents: dollarsToCents(100000), realGrowthPct: 0 },
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
    const { state: after } = addProjectionJob(before, PRIMARY_PERSON_ID as PersonId, openEndedJob);

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
      openEndedJob,
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
      openEndedJob,
    );
    const { state: final } = addProjectionJob(
      withBoth,
      PRIMARY_PERSON_ID as PersonId,
      openEndedJob,
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
      openEndedJob,
    );
    const { state: both, result: planJobId } = addProjectionJob(
      withPartnerJob,
      PRIMARY_PERSON_ID as PersonId,
      openEndedJob,
    );

    // One call shape, two storage planes — the caller never names either.
    const raised = setProjectionJobMonthlyIncome(
      setProjectionJobMonthlyIncome(both, nullJurisdiction, planJobId, dollarsToCents(9000)),
      nullJurisdiction,
      partnerJobId,
      dollarsToCents(7000),
    );

    expect(jobMonthlyIncomeCentsOf(raised, planJobId)).toBe(dollarsToCents(9000));
    expect(jobMonthlyIncomeCentsOf(raised, partnerJobId)).toBe(dollarsToCents(7000));
  });

  it("refuses an id neither plane holds, naming it", () => {
    const state = emptyState();
    expect(() =>
      setProjectionJobMonthlyIncome(state, nullJurisdiction, "job-99", 1),
    ).toThrow(/no job "job-99" in this household/);
  });
});

describe("job authoring — reassignment crosses the planes atomically", () => {
  it("moves a job from the plan onto a partner's event, keeping its id", () => {
    const { state, partnerId } = withPartner();
    const { state: withJob, result: jobId } = addProjectionJob(
      state,
      PRIMARY_PERSON_ID as PersonId,
      openEndedJob,
    );

    const moved = reassignProjectionJob(
      withJob,
      nullJurisdiction,
      jobId,
      partnerId,
      openEndedJob,
    );

    expect(moved.scenario.plan.jobs).toEqual([]);
    expect(partnerJobs(moved, partnerId).map((j) => j.id)).toEqual([jobId]);
  });

  it("moves one back the other way", () => {
    const { state, partnerId } = withPartner();
    const { state: withJob, result: jobId } = addProjectionPartnerJob(
      state,
      nullJurisdiction,
      partnerId,
      openEndedJob,
    );

    const moved = reassignProjectionJob(
      withJob,
      nullJurisdiction,
      jobId,
      PRIMARY_PERSON_ID as PersonId,
      openEndedJob,
    );

    expect(partnerJobs(moved, partnerId)).toEqual([]);
    expect(moved.scenario.plan.jobs.map((j) => j.id)).toEqual([jobId]);
  });

  it("derives nothing when the target owner is in neither plane", () => {
    // The refusal is what makes the two-step move safe: the source must not give the job up
    // before the target is proved. As a pure derivation the caller's state cannot be half-written
    // even in principle — there is one value, and it is never handed back.
    const { state: withJob, result: jobId } = addProjectionJob(
      emptyState(),
      PRIMARY_PERSON_ID as PersonId,
      openEndedJob,
    );

    expect(() =>
      reassignProjectionJob(
        withJob,
        nullJurisdiction,
        jobId,
        "nobody" as PersonId,
        openEndedJob,
      ),
    ).toThrow(/no household member "nobody" to own it/);

    // The job is still exactly where it was.
    expect(withJob.scenario.plan.jobs.map((j) => j.id)).toEqual([jobId]);
  });
});
