/**
 * **The `Projection` root's two counterfactual reads: the retirement answer, and the preview of
 * it.**
 *
 * `retirement()` is the whole question in one search; `runAtStopWorkingAge()` shows what a
 * candidate age actually means for the charts, and carries the resolved job spans
 * ({@link resolvedJobEndMonth}, {@link resolvedJobPaySpan}) a surface must read instead of
 * re-deriving an end of its own.
 *
 * What the solver DECIDES under those spans is the engine's, pinned in
 * `packages/engine/src/retirement/`. What these own is the facade's shape: that the read exists,
 * delegates, and hands back a resolution rather than an invitation to recompute one.
 */
import { describe, it, expect } from "vitest";
import { Projection, resolvedJobPaySpan } from "../index";
import { resolvedJobEndMonth } from "../ledger/household";
import { samplePlan, stateOf, SAMPLE_START_YEAR } from "../testing/samplePlan";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { dollarsToCents } from "../money/cashFlowSeries";
import { type Job } from "../job/job";
import { JOB_END_YEAR } from "../testing/projectionFacadeFixtures";

// The facade answers questions about a household as well as authoring one. Two homes, split
// by what each needs: a question about the plan as authored is a `Projection` method, while
// one that needs the simulated future rides the `ProjectionResult` a `run` produced — asked
// off the pass already in hand rather than provoking another.

describe("Projection.retirement — the whole question, one search", () => {
  const outlookOf = (plan: typeof samplePlan, jurisdiction = nullJurisdiction) =>
    Projection.fromState(stateOf(plan), nullJurisdiction).retirement(jurisdiction);

  it("reports the solved age and the authored stop, and pins no target between them", () => {
    // `target` went with `Plan.retirementAge`. What is left is the pair that cannot disagree
    // with the jobs: the earliest age the search reached, and the age the plan already stops.
    const outlook = outlookOf(samplePlan) as unknown as Record<string, unknown>;
    expect(outlook.target).toBeUndefined();
    expect(outlookOf(samplePlan).solution.fullRetirementAge).toBe(60);
    expect(outlookOf(samplePlan).solution.plannedWorkStopAge).toBe(60);
  });

  // The month/age conversions (`fullRetirementMonth`, `blockedAtAge`) and the early-retiree
  // health flag are `buildRetirementOutlook`'s own arithmetic, pinned directly against it in
  // `retirement/retirementOutlook.test.ts`. What stays here is that `Projection.retirement`
  // actually calls through to it and that a run stays a separate question from a search.

  it("leaves run() alone — a simulation is not a search", () => {
    const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
    const result = p.run(nullJurisdiction);
    // Nothing on a run answers the retirement question, so a caller that only wants the graph
    // never pays for the search.
    expect("retirement" in result).toBe(false);
    expect(result.series.months.length).toBeGreaterThan(0);
  });
});

describe("Projection root — previewing a stop-working age", () => {
  /** Wages the household draws in `month`, the signal the income chart bands. */
  const wagesAt = (result: ReturnType<Projection["run"]>, month: number): number =>
    result.series.months[month]?.flows?.incomeByCategoryCents.wages ?? 0;

  const CURRENT_AGE = SAMPLE_START_YEAR - samplePlan.primary.birthYear;

  // The sample primary works an open-ended job to age 60 (`retirementAge`), from age 40.
  const AGE_50_MONTH = (50 - CURRENT_AGE) * 12;

  it("ceases every job at the candidate age without touching the authored plan", () => {
    const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
    const before = p.state;

    // Stop at 45: fifteen years short of the authored age-60 stop, so age 50 has no wages.
    const preview = p.runAtStopWorkingAge(nullJurisdiction, 45);
    expect(wagesAt(preview, AGE_50_MONTH)).toBe(0);

    // The authored run is untouched — the primary still earns to 60 — and no write happened.
    expect(wagesAt(p.run(nullJurisdiction), AGE_50_MONTH)).toBeGreaterThan(0);
    expect(p.state).toBe(before);
  });

  it("EXTENDS the last job when the candidate is later — that is the 'work longer' question", () => {
    // The authored job ends at 60, so the authored run pays nothing at 63. Asking "what if we
    // retired at 65?" has to be allowed to run that same employment five years longer, or the
    // question cannot be asked at all — and the solver could never find an age past the one
    // already written down.
    const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
    const AGE_63_MONTH = (63 - CURRENT_AGE) * 12;
    expect(wagesAt(p.run(nullJurisdiction), AGE_63_MONTH)).toBe(0);
    expect(wagesAt(p.runAtStopWorkingAge(nullJurisdiction, 65), AGE_63_MONTH)).toBeGreaterThan(0);
    // The authored plan is untouched — the extension lives only in the hypothesis.
    expect(p.plan.primary.jobs[0]!.endYear).toBe(SAMPLE_START_YEAR - CURRENT_AGE + 60);
  });

  it("previews the SOLVED age self-consistently — the toggle shows what the headline means", () => {
    // The QA path a user actually walks: read the headline age off the panel, turn the preview
    // on, and see the charts. Those are two separate engine calls (`retirement`, then
    // `runAtStopWorkingAge`), and nothing but this pins that they agree — a preview built on a
    // different hypothesis from the search would draw a working life the headline never meant.
    const tight = { ...samplePlan, openingBalanceCents: 0 };
    const p = Projection.fromState(stateOf(tight), nullJurisdiction);
    const headline = p.retirement(nullJurisdiction).solution.fullRetirementAge;
    expect(headline).not.toBeNull();
    const age = headline as number;

    const preview = p.runAtStopWorkingAge(nullJurisdiction, age);
    // Work runs right up to the headline age — including past the job's authored end at 60,
    // which is the whole reason that age is reachable...
    expect(wagesAt(preview, (age - 1 - CURRENT_AGE) * 12)).toBeGreaterThan(0);
    // ...and stops there.
    expect(wagesAt(preview, (age - CURRENT_AGE) * 12)).toBe(0);
    // And the plan the headline promised survives really does survive in the previewed run.
    expect(preview.series.months.every((m) => m.netWorthRealCents !== null)).toBe(true);
  });

  it("leaves the authored plan alone when the preview EXTENDED work, not just when it capped", () => {
    // The no-mutation guarantee is easy to hold while a hypothesis only ever subtracts. It now
    // adds employment the plan does not contain, so this walks the toggle both ways: preview a
    // later age, then read the authored run back and find it unchanged, byte for byte.
    const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
    const before = p.state;
    const authoredBefore = JSON.stringify(p.run(nullJurisdiction).series.months);

    const AGE_63_MONTH = (63 - CURRENT_AGE) * 12;
    expect(wagesAt(p.runAtStopWorkingAge(nullJurisdiction, 70), AGE_63_MONTH)).toBeGreaterThan(0);

    // Toggling back off: the authored projection is identical, and no write ever happened.
    expect(JSON.stringify(p.run(nullJurisdiction).series.months)).toBe(authoredBefore);
    expect(wagesAt(p.run(nullJurisdiction), AGE_63_MONTH)).toBe(0);
    expect(p.state).toBe(before);
    expect(p.plan.primary.jobs[0]!.endYear).toBe(SAMPLE_START_YEAR - CURRENT_AGE + 60);
  });

  it("hands back a whole read-only result, answered under the run jurisdiction", () => {
    const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
    const preview = p.runAtStopWorkingAge(nullJurisdiction, 55);
    // The full ProjectionResult — roster and report beside the series — so the income and
    // net-worth charts read one preview pass, exactly as they read one authored pass.
    expect(preview.jurisdictionId).toBe(nullJurisdiction.id);
    expect(preview.household.memberships).toHaveLength(1);
    expect(preview.report).toBeDefined();
    expect(Object.isFrozen(preview)).toBe(true);
  });

  describe("resolvedJobEndMonth — the resolved end every chart should read instead of re-deriving it", () => {
    // The sample primary's open-ended job (`job-main`) naturally ends at the authored
    // retirement age, 60, from a current age of 40.
    it("reads the authored retirement age off the authored run", () => {
      const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
      expect(resolvedJobEndMonth(p.run(nullJurisdiction).household, "job-main")).toBe(
        (60 - CURRENT_AGE) * 12 - 1,
      );
    });

    it("moves the last job's resolved end to a later preview candidate", () => {
      // The chart reads this, so previewing "retire at 65" draws the job running to 65 — the
      // same thing the headline age means.
      const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
      const preview = p.runAtStopWorkingAge(nullJurisdiction, 65);
      expect(resolvedJobEndMonth(preview.household, "job-main")).toBe(
        (65 - CURRENT_AGE) * 12 - 1,
      );
    });

    it("caps an open-ended job short of the authored age when the preview candidate is earlier", () => {
      const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
      const preview = p.runAtStopWorkingAge(nullJurisdiction, 45);
      expect(resolvedJobEndMonth(preview.household, "job-main")).toBe(
        (45 - CURRENT_AGE) * 12 - 1,
      );
    });

    it("returns null for an id with no matching job series", () => {
      const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
      expect(resolvedJobEndMonth(p.run(nullJurisdiction).household, "no-such-job")).toBeNull();
    });
  });

  describe("resolvedJobPaySpan — the same resolution as a span, empty when the run pays nothing", () => {
    // A job the primary only picks up at 55, on top of the one they already hold. Open-ended,
    // so the authored plan pays it from 55 to the authored stop at 60.
    const laterJob: Job = {
      id: "job-later",
      ownerId: "p1",
      startYear: SAMPLE_START_YEAR - CURRENT_AGE + 55,
      endYear: JOB_END_YEAR,
      salary: {
        startingSalaryCents: dollarsToCents(36000),
        currentSalaryCents: dollarsToCents(36000),
        realGrowthPct: 0,
      },
    };
    const withLaterJob = {
      ...samplePlan,
      primary: { ...samplePlan.primary, jobs: [...samplePlan.primary.jobs, laterJob] },
    };
    /** The job's authored start, in months from "now" — the caller's half of the span. */
    const AUTHORED_START = (55 - CURRENT_AGE) * 12;
    const authoredSpan = { startMonth: AUTHORED_START, endMonthExclusive: (60 - CURRENT_AGE) * 12 };

    it("carries the caller's start and takes the end from the run", () => {
      const p = Projection.fromState(stateOf(withLaterJob), nullJurisdiction);
      expect(resolvedJobPaySpan(p.run(nullJurisdiction).household, "job-later", authoredSpan)).toEqual({
        startMonth: AUTHORED_START,
        // The authored stop at 60 — one past the last month paid.
        endMonthExclusive: (60 - CURRENT_AGE) * 12,
      });
    });

    it("caps the span when the preview candidate lands inside the job", () => {
      const p = Projection.fromState(stateOf(withLaterJob), nullJurisdiction);
      const preview = p.runAtStopWorkingAge(nullJurisdiction, 57);
      expect(resolvedJobPaySpan(preview.household, "job-later", authoredSpan)).toEqual({
        startMonth: AUTHORED_START,
        endMonthExclusive: (57 - CURRENT_AGE) * 12,
      });
    });

    it("empties the span for a job the run never reaches — absence of a series is zero, not a fallback", () => {
      // Stopping at 45 retires the household ten years before this job would have started, so
      // the run compiles no series for it. The span must collapse rather than fall back to the
      // authored one: a caller that falls back charts income the preview explicitly removed.
      const p = Projection.fromState(stateOf(withLaterJob), nullJurisdiction);
      const preview = p.runAtStopWorkingAge(nullJurisdiction, 45);
      expect(resolvedJobEndMonth(preview.household, "job-later")).toBeNull();
      expect(resolvedJobPaySpan(preview.household, "job-later", authoredSpan)).toEqual({
        startMonth: AUTHORED_START,
        endMonthExclusive: AUTHORED_START, // pays no month at all
      });
      // The authored plan still holds the job, untouched — this resolves what a household PAYS.
      expect(p.state.scenario.plan.primary.jobs.map((j) => j.id)).toContain("job-later");
    });
  });
});
