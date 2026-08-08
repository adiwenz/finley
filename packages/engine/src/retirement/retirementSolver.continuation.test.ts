/**
 * **Which job — if any — a what-if carries past the authored plan when it asks about a LATER
 * stop-working age.**
 *
 * One selection per person ({@link Person.continuationJobId}), and these pin what selecting
 * something does, what selecting `null` does, and what happens before anybody has selected at
 * all. The rule they replaced read the answer off the dates — the chronologically last job was
 * extended, whatever it was — which is wrong in the one shape it most needs to be right for, a
 * term contract taken at the end of a career, and the dates cannot tell the two apart because
 * every job has an end date and none of them says whether the work could continue.
 *
 * Asserted on the primary's plan jobs, so each case is a plan and a candidate age with nothing
 * else moving. The mock jurisdiction pays no benefit, so every cent of income in these series is
 * a wage and `job:<id>` names which job paid it.
 */
import { describe, it, expect } from "vitest";
import {
  projectFullRetirement,
  earliestFullRetirementAge,
  solveRetirement,
  continuedJobsAt,
  stopWorkingBoundaryAt,
} from "./retirementSolver";
import { compilePersonPriorEarnings } from "../compile/compilePerson";
import { scenarioOf } from "../plan/scenario";
import { dollarsToCents } from "../money/cashFlowSeries";
import { mockJurisdiction } from "../testing/mockJurisdiction";
import { samplePlan, baristaPlan, stateOf } from "../testing/samplePlan";
import { Projection } from "../facade/projectionFacade";
import type { Plan } from "../plan/plan";
import type { Person } from "../plan/person";
import type { Job } from "../job/job";
import {
  CTX,
  START_YEAR,
  BIRTH_YEAR,
  CURRENT_AGE,
  BARISTA_CURRENT_AGE,
  at,
  monthAt,
  job,
  planWithJobs,
  wageAt,
  incomeAt,
} from "./retirementSolver.testUtils";

describe("retirementSolver — which job a later candidate age continues", () => {
  /**
   * A career and the token job that follows it, read against `baristaPlan`'s OWN clock — the
   * two cases below that turn on a solved age use that fixture's tighter budget, and its
   * `currentAge` differs from `samplePlan`'s.
   */
  const baristaJobs: readonly Job[] = (() => {
    const birthYear = START_YEAR - BARISTA_CURRENT_AGE;
    const atBarista = (age: number) => birthYear + age;
    const shift = (j: Job, startAge: number, endAge: number): Job => ({
      ...j,
      startYear: atBarista(startAge),
      endYear: atBarista(endAge),
    });
    return [
      shift(job("career", 35, 65, 90_000), 35, 65),
      shift(job("token", 65, 70, 12_000), 65, 70),
    ];
  })();

  it("continues the SELECTED job, not the one that happens to end last", () => {
    // The spec case, and the whole reason the selection is authored: a career (35–65) followed
    // by a two-year contract (65–70). Asked whether they could stop at 71 with the CAREER named,
    // the plan carries the career on — it does not run the contract past a term that was never
    // theirs to extend, and does not conclude they keep working because something ends last.
    const jobs = [job("career", 35, 65), job("contract", 65, 70)];
    const series = projectFullRetirement(scenarioOf(planWithJobs(jobs, "career")), 71, CTX);

    // The contract stops dead on its own term, though it is the later-ending job.
    expect(wageAt(series, "contract", monthAt(69))).toBeGreaterThan(0);
    expect(wageAt(series, "contract", monthAt(70))).toBe(0);
    // The career runs on through the years it never authored, up to the candidate age.
    expect(wageAt(series, "career", monthAt(66))).toBeGreaterThan(0);
    expect(wageAt(series, "career", monthAt(70))).toBeGreaterThan(0);
    expect(wageAt(series, "career", monthAt(71))).toBe(0);
  });

  it("continues the later job instead when THAT is what was selected", () => {
    // The same two jobs and the same candidate age, one field different — so the assertion is
    // that the selection decides, and not that some other property of these jobs does.
    const jobs = [job("career", 35, 65), job("contract", 65, 70)];
    const series = projectFullRetirement(scenarioOf(planWithJobs(jobs, "contract")), 71, CTX);

    expect(wageAt(series, "career", monthAt(65))).toBe(0);
    expect(wageAt(series, "contract", monthAt(70))).toBeGreaterThan(0);
    expect(wageAt(series, "contract", monthAt(71))).toBe(0);
  });

  it("answers a different retirement AGE depending on which job was selected", () => {
    // The two previous cases in the terms the user actually meets. An earlier well-paid career
    // and a later token job, on `baristaPlan`'s budget — tight enough that the difference
    // between continuing $90k of work and continuing $12k of it decides the whole answer.
    //
    // Nothing but the selection differs between these three runs, and they are the same three
    // jobs the date-based rule would have chosen the LAST of every time.
    const onChoice = (chosen: string | null) =>
      earliestFullRetirementAge(
        scenarioOf({
        ...baristaPlan,
        primary: { ...baristaPlan.primary, jobs: baristaJobs, continuationJobId: chosen },
      }),
        CTX,
      );

    expect(onChoice("career")).toBe(74);
    // The token job cannot fund the gap however long it runs, so there is no age at all — the
    // honest answer, and the one the household gets by naming it.
    expect(onChoice("token")).toBeNull();
    expect(onChoice(null)).toBeNull();
  });

  it("invents NO income when the household selected None", () => {
    // `null` is an answer, not an absence: there is no honest way to fund working to 75, so the
    // plan pays nothing past the work it was actually given rather than conjuring a wage. The
    // candidate then fails on its own merits, which is the right answer and not a bug.
    const series = projectFullRetirement(
      scenarioOf(planWithJobs([job("only", 35, 65)], null)),
      75,
      CTX,
    );
    expect(wageAt(series, "only", monthAt(64))).toBeGreaterThan(0);
    expect(wageAt(series, "only", monthAt(65))).toBe(0);
    // Nothing else picks up the slack — no job, no phantom source, no benefit.
    expect(incomeAt(series, monthAt(70))).toBe(0);
  });

  it("never continues an unselected job, even as the household's only one", () => {
    // The narrowest statement of the rule, held apart from the case above: it is not that a
    // household answering None gets no answer, it is that a job nobody named is never run on.
    const series = projectFullRetirement(
      scenarioOf(planWithJobs([job("term", 35, 60)], null)),
      80,
      CTX,
    );
    for (const age of [60, 65, 70, 79]) expect(wageAt(series, "term", monthAt(age))).toBe(0);
  });

  it("extends the selected job as soon as the candidate passes ITS OWN end, not the plan's last", () => {
    // The rule, at the age that used to get it wrong. Career 35–65, contract 65–70, career
    // selected, candidate 68. The pivot was the person's WHOLE authored plan, so nothing was
    // extended until the candidate cleared 70 and the career stopped dead at 65 here — the
    // selection silently meant nothing at this age. It is past the career's own end, so the
    // career runs on; the contract keeps its authored dates and is capped at the candidate.
    const jobs = [job("career", 35, 65), job("contract", 65, 70)];
    const series = projectFullRetirement(scenarioOf(planWithJobs(jobs, "career")), 68, CTX);

    expect(wageAt(series, "career", monthAt(64))).toBeGreaterThan(0);
    expect(wageAt(series, "career", monthAt(67))).toBeGreaterThan(0);
    expect(wageAt(series, "career", monthAt(68))).toBe(0); // stopped by the candidate, not by 65
    expect(wageAt(series, "contract", monthAt(67))).toBeGreaterThan(0);
    expect(wageAt(series, "contract", monthAt(68))).toBe(0); // its own 70, cut at the candidate
  });

  it("caps the selected job like any other at a candidate INSIDE its own span", () => {
    // The other half of the same gate: extension is not "the selected job ignores the boundary".
    // At 60 the career is still running anyway, so there is nothing to carry — it is truncated
    // exactly as an unselected job would be, and the contract never starts.
    const jobs = [job("career", 35, 65), job("contract", 65, 70)];
    const series = projectFullRetirement(scenarioOf(planWithJobs(jobs, "career")), 60, CTX);

    expect(wageAt(series, "career", monthAt(59))).toBeGreaterThan(0);
    expect(wageAt(series, "career", monthAt(60))).toBe(0);
    for (const age of [65, 67, 69]) expect(wageAt(series, "contract", monthAt(age))).toBe(0);
  });

  it("is continuous across the household's last authored work end", () => {
    // The discontinuity this rule exists to remove, asserted as the property rather than at one
    // age. Under the per-person pivot the career was denied at 70 and granted at 71, so one
    // extra year of retirement age bought SIX extra years of salary and two adjacent candidates
    // modelled incompatible lives. Total income at a given month may only ever rise with the
    // candidate — and never by a step the extra year cannot account for.
    const jobs = [job("career", 35, 65), job("contract", 65, 70)];
    const scenario = scenarioOf(planWithJobs(jobs, "career"));
    // Income in the household's 66th year — one month past the career's own end, and inside
    // every candidate below, so the only thing that varies is whether the career is running.
    const atAge = (age: number) => incomeAt(projectFullRetirement(scenario, age, CTX), monthAt(65));

    // 66 through 72 — straddling the plan's own last year, 70. The career is running in every
    // one of them, because 66 is already past its own end. Under the old pivot this month was
    // career-less at 70 and career-paying at 71: the step this asserts away.
    const income = [66, 67, 68, 69, 70, 71, 72].map(atAge);
    for (const cents of income) expect(cents).toBe(income[0]);
    expect(income[0]).toBeGreaterThan(0);
  });

  it("answers inside the years the plan's last job used to swallow, and keeps paying for savings", () => {
    // The continuity above, in the only terms a household reads: the SOLVED AGE. The test
    // before it fixes the candidate and varies the money's arrival; this fixes the jobs and
    // varies the money, because a discontinuity in the projection shows up here as a solver
    // that stops responding — the ages it cannot reach are ages no amount of saving buys.
    //
    // Career 35–65, token job 65–70, career selected, on the barista budget. Under the
    // per-person pivot nothing was extended until the candidate cleared 70, so every one of
    // these balances answered 71: $200k of extra savings bought nothing at all, and 66–70 were
    // unreachable answers however the plan was funded. They are the years the household is
    // most likely to be asking about.
    const solveAt = (openingDollars: number) =>
      earliestFullRetirementAge(
        scenarioOf({
          ...baristaPlan,
          primary: { ...baristaPlan.primary, jobs: baristaJobs, continuationJobId: "career" },
          openingBalanceCents: dollarsToCents(openingDollars),
        }),
        CTX,
      );

    // Was [71, 71, 71].
    const ages = [400_000, 450_000, 600_000].map(solveAt);
    expect(ages).toEqual([70, 69, 67]);
    // Each lands strictly inside the dead band — past the career's own end, at or before the
    // token job's — which is what makes them answers the old rule could not produce at all.
    for (const age of ages) {
      expect(age).toBeGreaterThan(65);
      expect(age).toBeLessThanOrEqual(70);
    }
    // And the response is monotone: more savings never costs a household a later stop age.
    for (let i = 1; i < ages.length; i++) expect(ages[i]!).toBeLessThan(ages[i - 1]!);
  });

  it("never starts a job the candidate boundary falls before", () => {
    // A job authored to begin after the household stopped working does not happen — including
    // one that was selected, which is the case the extension rule could most easily get wrong by
    // reading "continue this job" as "run this job regardless".
    const jobs = [job("career", 35, 65), job("later", 72, 80)];
    for (const chosen of ["career", "later"]) {
      const series = projectFullRetirement(scenarioOf(planWithJobs(jobs, chosen)), 68, CTX);
      for (const age of [72, 75, 79]) expect(wageAt(series, "later", monthAt(age))).toBe(0);
    }
  });

  it("models a COMPLETED selected job as one that never ended", () => {
    // Selecting a finished job is a counterfactual, not a plan to take it up again: the ONE span
    // it was authored with simply runs on to the boundary, keeping its original start. So it
    // pays every month of the projection — there is no gap where it stopped and no second
    // segment beginning later, because in this scenario it never stopped.
    const jobs = [job("past", 25, 30, 20_000), job("current", 35, 65)];
    const series = projectFullRetirement(scenarioOf(planWithJobs(jobs, "past")), 70, CTX);

    // Continuous from "now" (age 40, well past its authored end at 30) to the boundary. A job
    // restarted at some later date would leave zeros in between; this has none.
    for (const age of [40, 50, 64, 69]) {
      expect(wageAt(series, "past", monthAt(age))).toBeGreaterThan(0);
    }
    expect(wageAt(series, "past", monthAt(70))).toBe(0);
    // And the unselected job still stops exactly where it was authored to.
    expect(wageAt(series, "current", monthAt(65))).toBe(0);
  });

  it("pays BOTH jobs through the overlap the extension creates — intended, not a leak", () => {
    // The spec's own example: continuing the career means it never ended, so it runs through the
    // contract authored to follow it and both pay from 65 to 70. Asserted as a sum, so this
    // fails if either the extension or the untouched later job were silently dropped.
    const jobs = [job("career", 35, 65, 90_000), job("contract", 65, 70, 30_000)];
    const series = projectFullRetirement(scenarioOf(planWithJobs(jobs, "career")), 71, CTX);

    const career = wageAt(series, "career", monthAt(67));
    const contract = wageAt(series, "contract", monthAt(67));
    expect(career).toBeGreaterThan(0);
    expect(contract).toBeGreaterThan(0);
    expect(incomeAt(series, monthAt(67))).toBe(career + contract);
    // Past the contract's own end only the continued job is left.
    expect(wageAt(series, "contract", monthAt(70))).toBe(0);
    expect(wageAt(series, "career", monthAt(70))).toBeGreaterThan(0);
  });

  it("applies the same selection to the stop-working PREVIEW, not just the search", () => {
    // The preview exists to show what the solved age means, so it must resolve jobs the same way
    // the solve did. Run through `Projection.runAtStopWorkingAge` — the app's own entry point —
    // rather than the solver's internals, so the two cannot drift apart unnoticed.
    const jobs = [job("career", 35, 65), job("contract", 65, 70)];
    const p = Projection.fromState(stateOf(planWithJobs(jobs, "career")), mockJurisdiction());
    const previewed = p.runAtStopWorkingAge(mockJurisdiction(), 71).series;

    expect(wageAt(previewed, "career", monthAt(70))).toBeGreaterThan(0);
    expect(wageAt(previewed, "contract", monthAt(70))).toBe(0);

    // And at a preview age INSIDE the plan's last authored year, where the two used to diverge:
    // the search extended the career from 66 while the preview's own rule did not, so the chart
    // showed a different life from the one the headline age was solved under. Both read the same
    // resolution now, so both have the career running at 67 and the contract capped at 68.
    const inside = p.runAtStopWorkingAge(mockJurisdiction(), 68).series;
    expect(wageAt(inside, "career", monthAt(67))).toBeGreaterThan(0);
    expect(wageAt(inside, "career", monthAt(68))).toBe(0);
    expect(wageAt(inside, "contract", monthAt(67))).toBeGreaterThan(0);
    expect(wageAt(inside, "contract", monthAt(68))).toBe(0);
  });

  it("treats a FUTURE selected job by where the candidate falls against its own span", () => {
    // One selection, three candidates, three different meanings — and the middle one is the case
    // a "the selected job always runs to the boundary" reading gets wrong.
    const jobs = [job("bridge", 35, 45), job("future", 50, 60)];
    const scenario = scenarioOf(planWithJobs(jobs, "future"));

    // Before it starts: it never happens at all, selected or not.
    const before = projectFullRetirement(scenario, 48, CTX);
    for (const age of [48, 50, 55, 59]) expect(wageAt(before, "future", monthAt(age))).toBe(0);
    expect(continuedJobsAt(scenario, 48, CTX)).toEqual([]);

    // Inside its authored span: capped like any other job, and nothing to disclose.
    const inside = projectFullRetirement(scenario, 55, CTX);
    expect(wageAt(inside, "future", monthAt(54))).toBeGreaterThan(0);
    expect(wageAt(inside, "future", monthAt(55))).toBe(0);
    expect(continuedJobsAt(scenario, 55, CTX)).toEqual([]);

    // Past its authored end: extended, and said so.
    const after = projectFullRetirement(scenario, 65, CTX);
    expect(wageAt(after, "future", monthAt(64))).toBeGreaterThan(0);
    expect(wageAt(after, "future", monthAt(65))).toBe(0);
    const [continued] = continuedJobsAt(scenario, 65, CTX);
    expect(continued?.jobId).toBe("future");
    expect(continued?.throughAge).toBe(65);
  });

  it("pays a continued COMPLETED job from the salary it was authored with, and grows it as authored", () => {
    // "It never ended" has to be priced, and the price is the job's own authored terms — month 0
    // is the current salary verbatim, and everything after it follows that job's own growth.
    // Anything else would make a continuation a raise nobody entered.
    const completed = (realGrowthPct: number): Job => ({
      id: "past",
      ownerId: "p1",
      startYear: at(20),
      endYear: at(30),
      salary: {
        startingSalaryCents: dollarsToCents(20_000),
        currentSalaryCents: dollarsToCents(36_000),
        realGrowthPct,
      },
    });
    const seriesFor = (realGrowthPct: number) =>
      projectFullRetirement(
        scenarioOf(planWithJobs([completed(realGrowthPct), job("current", 35, 65)], "past")),
        70,
        CTX,
      );

    const flat = seriesFor(0);
    // Month 0 is the authored CURRENT salary, not the starting one it was hired at.
    expect(wageAt(flat, "past", 0)).toBe(dollarsToCents(36_000) / 12);
    // And it really is continuous from there — no gap where the job stopped.
    for (const age of [45, 55, 69]) expect(wageAt(flat, "past", monthAt(age))).toBeGreaterThan(0);
    expect(wageAt(flat, "past", monthAt(70))).toBe(0);

    // Real growth is the job's own field, and it still applies to the continued years: same
    // month 0, strictly more later. Compared against the flat job rather than against an
    // absolute figure, so this holds on whichever basis the series reports.
    const growing = seriesFor(0.02);
    expect(wageAt(growing, "past", 0)).toBe(wageAt(flat, "past", 0));
    expect(wageAt(growing, "past", monthAt(60))).toBeGreaterThan(wageAt(flat, "past", monthAt(60)));
  });

  it("keeps an explicit None through adding, removing and reordering jobs", () => {
    // `null` is a stated answer, and the initialization rule must never get a second chance at
    // it. Editing the job list is exactly when it would: the rule fires on read, so every read
    // after every edit is an opportunity to quietly replace the household's "no" with a default.
    const jobs = [job("career", 35, 65), job("side", 40, 50)];
    const p = Projection.fromState(stateOf(planWithJobs(jobs, null)), mockJurisdiction());
    expect(p.continuationJobOf("p1")).toBeNull();

    p.addJob("p1", { startYear: at(66), endYear: at(72), salary: job("x", 66, 72).salary });
    expect(p.continuationJobOf("p1")).toBeNull();
    p.removeJob("side");
    expect(p.continuationJobOf("p1")).toBeNull();

    // Order is not information: the same jobs listed the other way round still answer None.
    const reversed = Projection.fromState(
      stateOf(planWithJobs([...jobs].reverse(), null)),
      mockJurisdiction(),
    );
    expect(reversed.continuationJobOf("p1")).toBeNull();

    // And the answer is invented nowhere downstream: neither solver nor preview pays a month the
    // plan does not contain. Every job left is authored to end by 72, so past that a preview at
    // 75 must show no income at all — not the career run on, not the job just added run on.
    const scenario = { plan: p.plan, ledger: p.ledger };
    expect(solveRetirement(scenario, CTX).continuedJobs).toEqual([]);
    const previewed = p.runAtStopWorkingAge(mockJurisdiction(), 75).series;
    expect(incomeAt(previewed, monthAt(71))).toBeGreaterThan(0); // the added job, as authored
    for (const age of [72, 73, 74]) expect(incomeAt(previewed, monthAt(age))).toBe(0);
  });

  it("resolves to None when the selected job is DELETED, with no stale id left anywhere", () => {
    // A dangling selection must not become an unbounded extension. The authoring path clears it,
    // and every reader agrees on the cleared state — solver, preview and picker alike, which is
    // the point: a stale id that only one of them still honoured would show a household a
    // retirement age funded by a job they had removed.
    const jobs = [job("career", 35, 65), job("contract", 65, 70)];
    const p = Projection.fromState(stateOf(planWithJobs(jobs, "contract")), mockJurisdiction());
    p.removeJob("contract");

    expect(p.plan.primary.continuationJobId).toBeNull();
    expect(p.continuationJobOf("p1")).toBeNull();
    expect(JSON.stringify(p.toState())).not.toContain("contract");

    expect(solveRetirement({ plan: p.plan, ledger: p.ledger }, CTX).continuedJobs).toEqual([]);
    const previewed = p.runAtStopWorkingAge(mockJurisdiction(), 75).series;
    expect(wageAt(previewed, "career", monthAt(64))).toBeGreaterThan(0);
    expect(wageAt(previewed, "career", monthAt(65))).toBe(0);
  });

  it("answers a household with NO jobs at all, in both directions", () => {
    // Nothing to continue and nothing to overlap. A household living off its assets can stop
    // today — the earliest age there is — and one that cannot fund itself has no age at all,
    // which is a different answer from stopping today and must not be reported as one.
    const jobless = (openingDollars: number): Plan => ({
      ...samplePlan,
      primary: { ...samplePlan.primary, jobs: [], continuationJobId: null },
      openingBalanceCents: dollarsToCents(openingDollars),
    });

    const funded = solveRetirement(scenarioOf(jobless(3_000_000)), CTX);
    expect(funded.fullRetirementAge).toBe(CURRENT_AGE);
    expect(funded.continuedJobs).toEqual([]);
    // No jobs is no planned stop either — a household with no wages never stops receiving them.
    expect(funded.plannedWorkStopAge).toBeNull();

    const broke = solveRetirement(scenarioOf(jobless(0)), CTX);
    expect(broke.fullRetirementAge).toBeNull();
    expect(broke.continuedJobs).toEqual([]);
  });

  it("compiles no income for jobs the preview's own boundary falls before", () => {
    // The preview is the solved age made visible, so a candidate before every job the household
    // holds has to LOOK like it: not a job paid a token amount, not a flat line at zero drawn
    // from a compiled series — no pay path at all.
    const jobs = [job("first", 50, 60), job("second", 62, 70)];
    const p = Projection.fromState(stateOf(planWithJobs(jobs, "first")), mockJurisdiction());
    const previewed = p.runAtStopWorkingAge(mockJurisdiction(), 45).series;

    for (const age of [45, 50, 55, 62, 69]) {
      const sources = previewed.months[monthAt(age)]?.flows?.incomeSources ?? [];
      expect(sources.filter((s) => s.sourceId.startsWith("job:"))).toEqual([]);
    }
    expect(continuedJobsAt(scenarioOf(planWithJobs(jobs, "first")), 45, CTX)).toEqual([]);
  });

  it("carries the counterfactual into the covered-earnings record, backwards as well as forwards", () => {
    // Continuing a completed job says it never ended, and a person's earnings HISTORY is part of
    // what never ending means: a bar job left at 30, continued for someone who is 40, means they
    // worked those ten years, and a benefit priced off the record has to see them.
    //
    // The pay in the filled years is what the history does everywhere else — the last authored
    // figure held flat, never a projection — so nothing is invented beyond the continuation the
    // household actually asked for.
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
    const hypothetical = {
      kind: "hypothetical" as const,
      stopWorking: stopWorkingBoundaryAt(samplePlan, 70, START_YEAR),
    };

    const continued = compilePersonPriorEarnings(person("bar"), START_YEAR, hypothetical);
    // The gap between the authored end at 30 and "now" is filled — and filled at exactly what
    // the job was already paying, which is the claim: the history is held flat, not projected.
    const authoredYear = continued[at(29)];
    expect(authoredYear).toBeGreaterThan(0);
    // 30–34: the bar job alone, still paying what it was authored to pay.
    for (const age of [30, 32, 34]) expect(continued[at(age)]).toBe(authoredYear);
    // 35 onward the career has begun, and overlapping jobs sum — the continued job did not
    // displace it, exactly as the forward series does not.
    expect(continued[at(35)]).toBeGreaterThan(authoredYear);

    // Selecting None leaves the record exactly as authored: the gap is real again, because
    // nothing is being modelled as having continued.
    // 30–34 is the window only the bar job could have covered, so it is the window that shows
    // the difference: filled under the continuation, empty without it.
    const none = compilePersonPriorEarnings(person(null), START_YEAR, hypothetical);
    expect(none[at(29)]).toBe(authoredYear);
    for (const age of [30, 32, 34]) expect(none[at(age)]).toBeUndefined();
    // The career's own years are untouched either way — only the continued job reaches back.
    expect(none[at(35)]).toBe(continued[at(35)]! - authoredYear);
  });
});

/**
 * **What a household that has never opened the picker gets carried for them.**
 *
 * A person with no stated {@link Person.continuationJobId} still has a continuation job — worked
 * out from the jobs they hold, on READ, so it follows the plan as it is edited rather than
 * freezing an answer at the moment the plan was created (for the primary, before a single job
 * existed). A stated answer, including a stated `null`, is never displaced by it.
 *
 * Observed the way it matters: which job the solve actually carries past its authored end, and
 * what the answer discloses. The rule itself is internal, and a test that called it directly
 * would pin the implementation rather than the promise.
 */
describe("retirementSolver — the job a household that never chose has continued for it", () => {
  /** Which job a candidate at `age` carries past its own end, or `null` for none at all. */
  const continuedAt = (jobs: readonly Job[], age: number, selection?: string | null) => {
    const continued = continuedJobsAt(scenarioOf(planWithJobs(jobs, selection)), age, CTX);
    return continued[0]?.jobId ?? null;
  };

  it("carries the job they are working NOW, and caps everything else at its own end", () => {
    // Age 40 today: "current" is the one running, so it is what a what-if runs on. The job
    // authored to start at 60 is not chosen for them and is capped exactly where it was written.
    const jobs = [job("past", 20, 30), job("current", 35, 60), job("later", 60, 70)];
    expect(continuedAt(jobs, 75)).toBe("current");

    const series = projectFullRetirement(scenarioOf(planWithJobs(jobs)), 75, CTX);
    expect(wageAt(series, "current", monthAt(65))).toBeGreaterThan(0); // past its authored 60
    expect(wageAt(series, "current", monthAt(75))).toBe(0);
    expect(wageAt(series, "later", monthAt(70))).toBe(0); // capped, never carried
  });

  it("carries the earliest job still to START when none is running yet", () => {
    // A plan whose work is all ahead of it continues the first thing it comes to.
    const jobs = [job("soon", 45, 70), job("later", 50, 75)];
    expect(continuedAt(jobs, 78)).toBe("soon");

    const series = projectFullRetirement(scenarioOf(planWithJobs(jobs)), 78, CTX);
    expect(wageAt(series, "soon", monthAt(72))).toBeGreaterThan(0); // past its authored 70
    expect(wageAt(series, "later", monthAt(75))).toBe(0);
  });

  it("carries NOTHING when every job is behind them", () => {
    // Re-entering finished employment is not something to assume on a person's behalf. Those
    // jobs stay selectable — the user may know one of them could have carried on — they are
    // simply never chosen for them, so no candidate age pays a wage the plan does not contain.
    const jobs = [job("past", 20, 30)];
    expect(continuedAt(jobs, 75)).toBeNull();
    expect(continuedAt([], 75)).toBeNull();

    const series = projectFullRetirement(scenarioOf(planWithJobs(jobs)), 75, CTX);
    for (const age of [41, 55, 70]) expect(wageAt(series, "past", monthAt(age))).toBe(0);
  });

  it("carries the latest-ENDING of several concurrent jobs, whatever order they are authored in", () => {
    // Arbitrary between equals, which is exactly why it is pinned: the job they would still be in
    // once the others finish. An exact tie falls to the first authored, and list order is not
    // information — the same jobs the other way round answer the same thing.
    const jobs = [job("short", 35, 50), job("long", 38, 65)];
    expect(continuedAt(jobs, 70)).toBe("long");
    expect(continuedAt([...jobs].reverse(), 70)).toBe("long");
    expect(continuedAt([job("first", 35, 60), job("second", 38, 60)], 70)).toBe("first");
  });

  it("never displaces a choice already made, including a stated None", () => {
    // The stability guarantee the picker depends on. Adding a job that WOULD have won the rule
    // changes nothing, because the rule does not run once someone has answered.
    const current = job("current", 35, 60);
    const newer = job("newer", 38, 70);
    expect(continuedAt([current, newer], 75)).toBe("newer"); // unstated: the rule's own answer
    expect(continuedAt([current, newer], 75, "current")).toBe("current");
    expect(continuedAt([current, newer], 75, null)).toBeNull();
  });

  it("reads a selection whose job is gone as None, never as an unbounded extension", () => {
    // The authoring path clears the selection with the job it named, so this only catches a state
    // restored from outside — where a dangling id must not become licence to work forever.
    const jobs = [job("current", 35, 60)];
    expect(continuedAt(jobs, 75, "deleted")).toBeNull();

    const series = projectFullRetirement(scenarioOf(planWithJobs(jobs, "deleted")), 75, CTX);
    expect(wageAt(series, "current", monthAt(59))).toBeGreaterThan(0);
    expect(wageAt(series, "current", monthAt(60))).toBe(0);
  });
});
