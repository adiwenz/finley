/**
 * **What a solved answer SAYS about the continuation it assumed** — {@link ContinuedJob}, the
 * disclosure that travels with a retirement age.
 *
 * A solved age is only meaningful next to the assumption it rests on: that one named job never
 * finished. These pin the reported shape — which job, through what age and calendar year, and the
 * overlaps the extension creates with work the plan authored to follow it — separately from
 * whether the projection pays the right wages, which is `retirementSolver.continuation.test.ts`.
 *
 * The overlaps matter because they are the part of the scenario a reader would not predict: the
 * continued job runs THROUGH whatever came after it, and both pay.
 */
import { describe, it, expect } from "vitest";
import { solveRetirement, continuedJobsAt } from "./retirementSolver";
import { scenarioOf, withLedger } from "../plan/scenario";
import { addEvent } from "../ledger/addEvent";
import { emptyLedger } from "../ledger/ledger";
import { dollarsToCents } from "../money/cashFlowSeries";
import { createProjectionBase } from "../compile/projectionBase";
import { samplePlan, baristaPlan, SAMPLE_START_YEAR } from "../testing/samplePlan";
import type { Person } from "../plan/person";
import type { Job } from "../job/job";
import {
  CTX,
  CURRENT_AGE,
  BARISTA_CURRENT_AGE,
  PRIMARY_BIRTH_YEAR,
  at,
  job,
  baristaJobs,
  planWithJobs,
} from "./retirementSolver.testUtils";

describe("retirementSolver — what a solved age discloses about the job it continued", () => {
  it("reports the overlap window a continued job creates, in its OWNER's ages", () => {
    // The one consequence a reader would not predict, so it is disclosed with its years rather
    // than left to be discovered in the income chart.
    const jobs = [job("career", 35, 65, 90_000), job("contract", 65, 70, 30_000)];
    const [continued] = continuedJobsAt(scenarioOf(planWithJobs(jobs, "career")), 71, CTX);

    expect(continued.jobId).toBe("career");
    expect(continued.overlaps).toEqual([
      {
        jobId: "contract",
        jobLabel: `${samplePlan.primary.name}'s job 2`,
        jobName: null,
        fromAge: 65,
        toAge: 70,
        fromYear: SAMPLE_START_YEAR - CURRENT_AGE + 65,
        toYear: SAMPLE_START_YEAR - CURRENT_AGE + 70,
      },
    ]);
    // The continuation's own terminus, likewise the owner's — here the primary, so it matches
    // the boundary age the search was asked about.
    expect(continued.throughAge).toBe(71);
    expect(continued.throughYear).toBe(SAMPLE_START_YEAR - CURRENT_AGE + 71);
  });

  it("reports an overlap only from NOW, never from a year the projection does not pay", () => {
    // Continuing a job that ended before "now" overlaps on paper from its authored end, but no
    // month before 0 is ever paid — so naming that earlier year would claim years of doubled
    // income that do not happen. The fixture's primary is 40, and the bar job ended at 30.
    const jobs = [job("bar", 20, 30, 20_000), job("current", 35, 65)];
    const [continued] = continuedJobsAt(scenarioOf(planWithJobs(jobs, "bar")), 70, CTX);

    expect(continued.jobId).toBe("bar");
    expect(continued.overlaps).toEqual([
      {
        jobId: "current",
        jobLabel: `${samplePlan.primary.name}'s job 2`,
        jobName: null,
        fromAge: CURRENT_AGE,
        toAge: 65,
        fromYear: SAMPLE_START_YEAR,
        toYear: SAMPLE_START_YEAR - CURRENT_AGE + 65,
      },
    ]);
  });

  it("counts a PARTNER's continuation in the partner's OWN years, not the primary's", () => {
    // The bug this pins: every age here was converted through the primary's birth year, so a
    // partner born in a different year had their job's terminus and overlap windows reported in
    // the primary's ages — numbers from one person's life stated as facts about another's. The
    // partner is five years OLDER, which is what makes the two clocks visibly disagree; the
    // calendar years are identical either way, and are what let a reader reconcile them.
    const partnerBirthYear = PRIMARY_BIRTH_YEAR - 5;
    const partnerJobAt = (id: string, startAge: number, endAge: number, annual: number): Job => ({
      id,
      ownerId: "p2",
      startYear: partnerBirthYear + startAge,
      endYear: partnerBirthYear + endAge,
      salary: {
        startingSalaryCents: dollarsToCents(annual),
        currentSalaryCents: dollarsToCents(annual),
        realGrowthPct: 0,
      },
    });
    const partner: Person = {
      id: "p2",
      name: "Partner",
      birthYear: partnerBirthYear,
      lifeExpectancy: samplePlan.primary.lifeExpectancy,
      benefitClaimingAge: 67,
      continuationJobId: "nursing",
      jobs: [
        partnerJobAt("nursing", 22, 50, 48_000),
        partnerJobAt("consulting", 52, 58, 12_000),
      ],
    };
    const added = addEvent(emptyLedger, createProjectionBase(samplePlan, CTX), {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: partner,
    });
    if (!added.ok) throw new Error(`fixture rejected: ${added.conflict}`);
    // The primary names no continuation, so only the partner's job is extended and the answer
    // is unambiguously about them.
    const scenario = withLedger(scenarioOf(planWithJobs(samplePlan.primary.jobs, null)), added.ledger);

    // A boundary at the primary's 71 is the calendar year the PARTNER turns 76.
    const [continued] = continuedJobsAt(scenario, 71, CTX);
    expect(continued.ownerName).toBe("Partner");
    expect(continued.jobId).toBe("nursing");
    expect(continued.throughAge).toBe(76);
    expect(continued.throughYear).toBe(PRIMARY_BIRTH_YEAR + 71);

    // And the overlap with their own later job, in their years: 52–58, never the primary's 47–53.
    expect(continued.overlaps).toEqual([
      {
        jobId: "consulting",
        jobLabel: "Partner's job 2",
        jobName: null,
        fromAge: 52,
        toAge: 58,
        fromYear: partnerBirthYear + 52,
        toYear: partnerBirthYear + 58,
      },
    ]);
  });

  it("reports no overlap where the continued job was already the last one running", () => {
    // The ordinary case. Nothing follows the career, so continuing it crosses nothing and there
    // is no surprise to disclose.
    const jobs = [job("career", 35, 65), job("early", 25, 30)];
    const [continued] = continuedJobsAt(scenarioOf(planWithJobs(jobs, "career")), 71, CTX);

    expect(continued.jobId).toBe("career");
    expect(continued.overlaps).toEqual([]);
  });

  it("discloses the job a solved age assumed would continue", () => {
    // The age alone hides its premise: 74 means something different if it quietly took nine
    // years of work past the plan. `continuedJobs` is read back off the resolution the run
    // performed, so it names a job exactly when the projection really did pay it for years the
    // plan does not contain.
    const solved = solveRetirement(
      scenarioOf({
        ...baristaPlan,
        primary: { ...baristaPlan.primary, jobs: baristaJobs, continuationJobId: "career" },
      }),
      CTX,
    );
    expect(solved.fullRetirementAge).toBe(74);
    // Named the way the income legend names it — its own title if it has one, else its
    // OWNER's, never the minted id, which would mean nothing beside a retirement age.
    expect(solved.continuedJobs).toEqual([
      {
        jobId: "career",
        jobLabel: `${baristaPlan.primary.name}'s job 1`,
        jobName: null,
        ownerId: "p1",
        ownerName: baristaPlan.primary.name,
        // The owner here IS the primary, so their age and the solved age coincide — the case
        // that hid the partner bug for as long as it did.
        throughAge: 74,
        throughYear: SAMPLE_START_YEAR - BARISTA_CURRENT_AGE + 74,
        // The token job starts exactly where the career was authored to end, so continuing the
        // career runs straight through it.
        overlaps: [
          {
            jobId: "token",
            jobLabel: `${baristaPlan.primary.name}'s job 2`,
            jobName: null,
            fromAge: 65,
            toAge: 70,
            fromYear: SAMPLE_START_YEAR - BARISTA_CURRENT_AGE + 65,
            toYear: SAMPLE_START_YEAR - BARISTA_CURRENT_AGE + 70,
          },
        ],
      },
    ]);

    // Nothing to disclose where nothing was assumed: this household can stop inside its own
    // authored plan, so its age rests on no extra work at all.
    const unaided = solveRetirement(scenarioOf(planWithJobs([job("career", 35, 65)])), CTX);
    expect(unaided.fullRetirementAge).not.toBeNull();
    expect(unaided.continuedJobs).toEqual([]);
  });

  it("reports the AUTHORED plan's survival as a result of its own", () => {
    // The second first-class answer. It is a run of the plan exactly as written — no boundary,
    // no continuation — so it is untouched by the selection, and it answers a question the
    // search structurally cannot: "does what I actually wrote down work?"
    const comfortable = solveRetirement(scenarioOf(planWithJobs([job("career", 35, 65)])), CTX);
    expect(comfortable.authoredPlanSurvives).toBe(true);

    // Same plan, three selections, one authored answer: the choice is about hypotheticals.
    for (const chosen of ["career", null, undefined] as const) {
      const jobs = [job("career", 35, 65), job("contract", 65, 70)];
      const solved = solveRetirement(scenarioOf(planWithJobs(jobs, chosen)), CTX);
      expect(solved.authoredPlanSurvives).toBe(true);
    }

    // And it really does read the plan rather than always agreeing: the tight fixture's authored
    // jobs do not carry it to life expectancy.
    const tight = solveRetirement(
      scenarioOf({
        ...baristaPlan,
        primary: { ...baristaPlan.primary, jobs: baristaJobs, continuationJobId: "career" },
      }),
      CTX,
    );
    expect(tight.authoredPlanSurvives).toBe(false);
    // Two results, not one: this household HAS a feasible stop-all-work age even though the plan
    // it wrote down fails — the age assumes the career ran on, which the authored plan does not.
    expect(tight.fullRetirementAge).toBe(74);
  });

  it("records no continuation at a candidate that is exactly the selected job's own end", () => {
    // The boundary of the extension rule, from the side that must NOT fire. At 65 the career was
    // ending anyway, so nothing was assumed and the answer is unconditional — the headline may be
    // stated flat. One year later the same plan has something to disclose, which is what makes
    // this an assertion about the boundary rather than about a fixture that never continues.
    const scenario = scenarioOf(planWithJobs([job("career", 35, 65)], "career"));

    expect(continuedJobsAt(scenario, 65, CTX)).toEqual([]);
    expect(continuedJobsAt(scenario, 64, CTX)).toEqual([]);
    const [continued] = continuedJobsAt(scenario, 66, CTX);
    expect(continued?.jobId).toBe("career");
    expect(continued?.throughAge).toBe(66);
  });

  it("discloses several overlaps deterministically, with no duplicate or empty window", () => {
    // A continuation can cross more than one later job, and each crossing is its own sentence.
    // The failure this guards is the shape a reader would notice first: the same job named
    // twice, or a window from 70 to 70 that says nothing at all.
    const jobs = [
      job("career", 35, 65),
      job("first", 65, 70),
      job("second", 68, 72),
      job("longAgo", 30, 34),
    ];
    const scenario = scenarioOf(planWithJobs(jobs, "career"));
    const [continued] = continuedJobsAt(scenario, 75, CTX);

    expect(continued?.overlaps).toEqual([
      {
        jobId: "first",
        jobLabel: `${samplePlan.primary.name}'s job 2`,
        jobName: null,
        fromAge: 65,
        toAge: 70,
        fromYear: at(65),
        toYear: at(70),
      },
      {
        jobId: "second",
        jobLabel: `${samplePlan.primary.name}'s job 3`,
        jobName: null,
        fromAge: 68,
        toAge: 72,
        fromYear: at(68),
        toYear: at(72),
      },
    ]);
    // The job that ended before "now" is not among them, and nothing is named twice or empty.
    const ids = continued!.overlaps.map((o) => o.jobId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const o of continued!.overlaps) expect(o.toAge).toBeGreaterThan(o.fromAge);
    // And the read is a pure function of the scenario: asking twice says the same thing.
    expect(continuedJobsAt(scenario, 75, CTX)).toEqual(continuedJobsAt(scenario, 75, CTX));
  });
});
