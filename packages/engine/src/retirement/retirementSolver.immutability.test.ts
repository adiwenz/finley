/**
 * **A hypothesis never touches the plan it is a hypothesis about.**
 *
 * The whole reason a candidate stop-working age is a boundary applied at resolution time rather
 * than a rewrite of `Job.endYear`: the search runs a dozen candidates over one scenario, the
 * preview runs another, and the plan the user is looking at has to come out the far side
 * byte-for-byte identical — jobs, salaries, ledger events and the covered-earnings record alike.
 *
 * Also the determinism these depend on: the same scenario solved twice answers the same thing,
 * and a plan reloaded from disk solves the way it solved before it was saved.
 */
import { describe, it, expect } from "vitest";
import {
  projectScenario,
  projectFullRetirement,
  earliestFullRetirementAge,
  evaluateFullRetirementAtAge,
  solveRetirement,
} from "./retirementSolver";
import { compilePersonPriorEarnings } from "../compile/compilePerson";
import { scenarioOf } from "../plan/scenario";
import { mockJurisdiction } from "../testing/mockJurisdiction";
import { samplePlan, stateOf } from "../testing/samplePlan";
import { Projection } from "../facade/projectionFacade";
import type { Plan } from "../plan/plan";
import type { Person } from "../plan/person";
import type { Scenario } from "../plan/scenario";
import {
  CTX,
  START_YEAR,
  BIRTH_YEAR,
  at,
  monthAt,
  job,
  planWithJobs,
  wageAt,
  twoEarnerScenario,
} from "./retirementSolver.testUtils";

describe("retirementSolver — the authored plan survives every hypothesis unchanged", () => {
  it("a full solve never mutates a job — serialized state is identical before and after", () => {
    // The whole point of a boundary over a rewrite: the search runs a dozen candidate ages and
    // touches nothing. Snapshot the scenario, solve every entry point over it, and it must
    // round-trip unchanged — job dates, salaries and the ledger's partner jobs included.
    const scenario = twoEarnerScenario();
    const before = JSON.stringify(scenario);
    earliestFullRetirementAge(scenario, CTX);
    evaluateFullRetirementAtAge(scenario, 55, CTX);
    projectFullRetirement(scenario, 55, CTX);
    solveRetirement(scenario, CTX);
    expect(JSON.stringify(scenario)).toBe(before);
  });

  it("leaves the AUTHORED earnings record alone — the backfill is the hypothesis's, not the plan's", () => {
    // The same guarantee every other part of the selection carries. A plan the user is looking
    // at reports the years they actually worked, whatever they picked in the continuation
    // control, and only a solve or a preview sees the counterfactual history.
    const jobs = [job("bar", 20, 30, 20_000), job("current", 35, 65)];
    const person = (continuationJobId: string | null): Person => ({
      id: "p1",
      name: samplePlan.primary.name,
      birthYear: BIRTH_YEAR,
      lifeExpectancy: samplePlan.primary.lifeExpectancy,
      benefitClaimingAge: 67,
      jobs,
      continuationJobId,
    });

    const authored = compilePersonPriorEarnings(person("bar"), START_YEAR);
    expect(authored).toEqual(compilePersonPriorEarnings(person(null), START_YEAR));
    for (const age of [30, 32, 34]) expect(authored[at(age)]).toBeUndefined();
  });

  it("changes NOTHING about the authored projection — the selection is about hypotheticals only", () => {
    // The load-bearing guarantee: the selection is read by the solver and the preview, and by
    // nothing that draws the user's own plan. Moving it, or clearing it, must leave the ordinary
    // projection byte-for-byte identical.
    const jobs = [job("career", 35, 65), job("contract", 65, 70)];
    const monthsOf = (s: Scenario) =>
      JSON.stringify(projectScenario(s, CTX).months.map((m) => m.flows?.totalIncomeCents ?? 0));
    const onCareer = monthsOf(scenarioOf(planWithJobs(jobs, "career")));

    expect(monthsOf(scenarioOf(planWithJobs(jobs, "contract")))).toBe(onCareer);
    expect(monthsOf(scenarioOf(planWithJobs(jobs, null)))).toBe(onCareer);
    expect(monthsOf(scenarioOf(planWithJobs(jobs)))).toBe(onCareer);
    // And the authored plan really does end where each job was authored to end.
    const series = projectScenario(scenarioOf(planWithJobs(jobs, "career")), CTX);
    expect(wageAt(series, "career", monthAt(64))).toBeGreaterThan(0);
    expect(wageAt(series, "career", monthAt(65))).toBe(0);
  });

  it("does not reproduce the authored staggering as a solver candidate", () => {
    // Why the authored run has to exist separately. At a candidate of 70 — the plan's own last
    // year — the career is modelled as having run to 70 too, because the selection means the
    // same thing at every candidate. So the scenario the user actually wrote (career to 65, then
    // contract 65–70) appears nowhere in the candidate space, and nothing in the search speaks
    // for it.
    const jobs = [job("career", 35, 65), job("contract", 65, 70)];
    const scenario = scenarioOf(planWithJobs(jobs, "career"));

    const candidate = projectFullRetirement(scenario, 70, CTX);
    expect(wageAt(candidate, "career", monthAt(67))).toBeGreaterThan(0);

    // The authored run — the one `authoredPlanSurvives` judges — is the one that has it stopped.
    const authored = projectScenario(scenario, CTX);
    expect(wageAt(authored, "career", monthAt(67))).toBe(0);
    expect(wageAt(authored, "contract", monthAt(67))).toBeGreaterThan(0);
  });

  it("survives a state round-trip, for a named job and for None alike", () => {
    // The selection is authored, so it is persisted — a plan reloaded from disk must solve the
    // way it solved before it was saved. Asserted on the restored field AND on the answer, since
    // a field that round-trips into a shape nothing reads would pass the first check alone.
    const jobs = [job("career", 35, 65), job("contract", 65, 70)];
    const reload = (plan: Plan) =>
      Projection.fromState(
        JSON.parse(JSON.stringify(Projection.fromState(stateOf(plan), mockJurisdiction()).toState())),
        mockJurisdiction(),
      );

    const onContract = reload(planWithJobs(jobs, "contract"));
    expect(onContract.plan.primary.continuationJobId).toBe("contract");
    const previewed = onContract.runAtStopWorkingAge(mockJurisdiction(), 71).series;
    expect(wageAt(previewed, "contract", monthAt(70))).toBeGreaterThan(0);
    expect(wageAt(previewed, "career", monthAt(70))).toBe(0);

    // `null` and "never chosen" are different states, and neither may decay into the other.
    expect(reload(planWithJobs(jobs, null)).plan.primary.continuationJobId).toBeNull();
    expect(reload(planWithJobs(jobs)).plan.primary.continuationJobId).toBeUndefined();
  });
});
