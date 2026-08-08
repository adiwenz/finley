/**
 * **`plannedWorkStopAge` — the age the household's own jobs stop paying it, as authored.**
 *
 * A plain read of the plan with no boundary involved, which is why it lives apart from the search:
 * it is the figure a solved age is compared AGAINST, and it has to be the household's maximum
 * across every earner, converted through the primary's clock, and clipped by whatever ends a
 * partner's wages — their job, their death, or their leaving.
 */
import { describe, it, expect } from "vitest";
import { solveRetirement } from "./retirementSolver";
import { scenarioOf, withLedger } from "../plan/scenario";
import { addEvent } from "../ledger/addEvent";
import { emptyLedger } from "../ledger/ledger";
import { createProjectionBase } from "../compile/projectionBase";
import { samplePlan, SAMPLE_JOB_END_AGE } from "../testing/samplePlan";
import type { Person } from "../plan/person";
import type { Scenario } from "../plan/scenario";
import {
  CTX,
  PRIMARY_BIRTH_YEAR,
  partnerJob,
  partnerWith,
  twoEarnerScenario,
} from "./retirementSolver.testUtils";

describe("solveRetirement — plannedWorkStopAge is household-wide", () => {
  // Same fixture shapes as the boundary describe block above, kept local: `plannedWorkStopAge`
  // is a plain read (no boundary involved), so these tests exercise it in isolation.
  it("a partner job resolves via its OWN authored end, later than every primary job", () => {
    // Primary's only job is open-ended, natural end birthYear + 60 (SAMPLE_JOB_END_AGE)
    // → age 60. Partner's job is authored to end at 80 (same birth year) → the
    // household-wide max is the partner's, age 80 — later than any primary job alone.
    const scenario = twoEarnerScenario(partnerWith({ jobs: [partnerJob()] }));
    expect(solveRetirement(scenario, CTX).plannedWorkStopAge).toBe(80);
  });

  it("a partner's later calendar-year stop converts through the PRIMARY's birth year, not their own", () => {
    // Partner is 10 years older (birthYear 10 years earlier) but authored to work to age 90 —
    // their natural-end CALENDAR YEAR is (PRIMARY_BIRTH_YEAR − 10) + 90 = PRIMARY_BIRTH_YEAR + 80,
    // i.e. 80 years past the PRIMARY's own birth year, not 90 (which would be the partner's own
    // age at that year, and reporting that would misattribute the partner's stop as if it were
    // the primary's age).
    //
    // Expectancy 95 so they LIVE to work those years: a job ends at `min(authored end, death)`,
    // and this test is about the birth-year conversion rather than the death cap — pinned on its
    // own below.
    const scenario = twoEarnerScenario(
      partnerWith({ birthYear: PRIMARY_BIRTH_YEAR - 10, lifeExpectancy: 95, jobs: [partnerJob()] }),
    );
    expect(solveRetirement(scenario, CTX).plannedWorkStopAge).toBe(80);
  });

  it("a partner job is read via its authored endYear, and nothing else", () => {
    const explicitEndYear = PRIMARY_BIRTH_YEAR + 95; // later than every other job here
    const scenario = twoEarnerScenario(
      // Again long-lived enough for the authored end to be the binding one.
      partnerWith({ lifeExpectancy: 100, jobs: [partnerJob({ endYear: explicitEndYear })] }),
    );
    expect(solveRetirement(scenario, CTX).plannedWorkStopAge).toBe(95);
  });

  it("a partner job authored past their own death stops at the death instead", () => {
    // The same job as above, now held by someone who does not live to finish it: authored to
    // PRIMARY_BIRTH_YEAR + 95, expectancy 85, same birth year — so the employment ends at
    // PRIMARY_BIRTH_YEAR + 85 and the household-wide stop is age 85, not 95.
    //
    // This used to report 95. `plannedWorkStopAge` reads resolved employment ends, and the
    // resolution had no opinion about death — so the panel told a household it would be working
    // ten years after the earner it belonged to had died.
    const scenario = twoEarnerScenario(
      partnerWith({
        lifeExpectancy: 85,
        jobs: [partnerJob({ endYear: PRIMARY_BIRTH_YEAR + 95 })],
      }),
    );
    expect(solveRetirement(scenario, CTX).plannedWorkStopAge).toBe(85);
  });

  /** Marry `partner` at month 0, then separate at `separationMonth`. */
  function separatedScenario(partner: Person, separationMonth: number): Scenario {
    const base = createProjectionBase(samplePlan, CTX);
    const married = addEvent(emptyLedger, base, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: partner,
    });
    if (!married.ok) throw new Error(`fixture rejected: ${married.conflict}`);
    const separated = addEvent(married.ledger, base, {
      id: "s1",
      type: "SeparationEvent",
      month: separationMonth,
      partnerPersonId: partner.id,
      alimonyMonthlyCents: 0,
      alimonyDurationMonths: 0,
      childSupportMonthlyCents: 0,
    });
    if (!separated.ok) throw new Error(`fixture rejected: ${separated.conflict}`);
    return withLedger(scenarioOf(samplePlan), separated.ledger);
  }

  it("a separated partner's job stops counting at the separation, not at their own retirement target", () => {
    // The partner is authored to work to 80, but leaves the household at month 300 — the
    // primary's age 65. Their wages after that are no longer this household's, so the household
    // stops being paid for that job then, and the read reports 65 rather than the 80 the job
    // would reach in a household the partner is no longer in.
    const scenario = separatedScenario(
      partnerWith({ jobs: [partnerJob()] }),
      300,
    );
    expect(solveRetirement(scenario, CTX).plannedWorkStopAge).toBe(65);
  });

  it("falls back to the primary's own job once an early separation ends the partner's wages", () => {
    // Same partner, separating at month 12 (age 41) — before even the primary's own open-ended
    // job ends at `SAMPLE_JOB_END_AGE`. The household's final wage is the primary's.
    const scenario = separatedScenario(
      partnerWith({ jobs: [partnerJob()] }),
      12,
    );
    expect(solveRetirement(scenario, CTX).plannedWorkStopAge).toBe(SAMPLE_JOB_END_AGE);
  });

  it("an ACTIVE partner is capped by their JOB's end, never by a membership that has no end", () => {
    // The mirror of the two above: an unseparated membership runs forever, so it clips nothing
    // and the partner's own authored job end is what ends the household's wages.
    const scenario = twoEarnerScenario(
      partnerWith({ jobs: [partnerJob({ endYear: PRIMARY_BIRTH_YEAR + 72 })] }),
    );
    expect(solveRetirement(scenario, CTX).plannedWorkStopAge).toBe(72);
  });

  it("multiple relationship events: the household-wide max wins across every partner ever added", () => {
    const base = createProjectionBase(samplePlan, CTX);
    const first = addEvent(emptyLedger, base, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: partnerWith({
        id: "p2",
        jobs: [partnerJob({ id: "pj1", ownerId: "p2", endYear: PRIMARY_BIRTH_YEAR + 55 })],
      }),
    });
    if (!first.ok) throw new Error(`fixture rejected: ${first.conflict}`);
    const separated = addEvent(first.ledger, base, {
      id: "s1",
      type: "SeparationEvent",
      month: 12,
      partnerPersonId: "p2",
      alimonyMonthlyCents: 0,
      alimonyDurationMonths: 0,
      childSupportMonthlyCents: 0,
    });
    if (!separated.ok) throw new Error(`fixture rejected: ${separated.conflict}`);
    const second = addEvent(separated.ledger, base, {
      id: "r2",
      type: "RelationshipEvent",
      month: 24,
      person: partnerWith({
        id: "p3",
        jobs: [partnerJob({ id: "pj2", ownerId: "p3", endYear: PRIMARY_BIRTH_YEAR + 85 })],
      }),
    });
    if (!second.ok) throw new Error(`fixture rejected: ${second.conflict}`);
    const scenario = withLedger(scenarioOf(samplePlan), second.ledger);
    // The household's final wage across: primary (60), first partner (separated at month 12, so
    // 41 rather than the 55 they were authored to work to), second partner (85) → 85.
    expect(solveRetirement(scenario, CTX).plannedWorkStopAge).toBe(85);
  });
});
