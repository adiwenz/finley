/**
 * `householdJob.ts` owns one derived concept — when a job pays the household — and the surfaces
 * that read it (the Jobs panel's chart, the retirement solver) must never re-derive it.
 *
 * {@link resolveHouseholdJob} and {@link resolveJobPayDisplay} ARE that concept, so they are the
 * only two functions pinned here. The boundary/death caps that decide the EMPLOYMENT span, the
 * membership intersection that decides what of it is PAID, and the span arithmetic behind a
 * continuation disclosure are all reachable through the two resolved results — so the helpers
 * that implement them (`authoredJobEndYearExclusive`, `employmentEndYearExclusive`,
 * `householdPaidMonths` and friends) are deliberately NOT tested one by one. They are free to be
 * renamed, inlined or deleted; only the resolved shape is a promise.
 *
 * The retirement solver's own boundary-extension and membership-clipping behavior — whether a
 * candidate stop-working age extends or caps a job's WAGES, and which months it discloses as
 * added or overlapping — is pinned end to end in `retirementSolver.test.ts`, off a real
 * projection. What is pinned here instead is the shape `resolveJobPayDisplay` hands to a caller:
 * which stretches of an employment are `paidSpan` and which are `uncountedSpans`, for every
 * join/separation geometry a chart has to draw. Before this file existed, that geometry was
 * proven only through `JobsPanel`'s rendering, which meant a React test was the sole guardian of
 * an engine invariant.
 */
import { describe, it, expect } from "vitest";
import type { Job } from "./job";
import type { Person } from "../plan/person";
import type { HouseholdMembership } from "../ledger/household";
import {
  resolveHouseholdJob,
  resolveJobPayDisplay,
  type HouseholdJobContext,
  type JobResolutionScope,
} from "./householdJob";
import { dollarsToCents } from "../money/cashFlowSeries";

const START_YEAR = 2026;
const AUTHORED: JobResolutionScope = { kind: "authored" };
const hypothetical = (boundaryYearExclusive: number): JobResolutionScope => ({
  kind: "hypothetical",
  stopWorking: { boundaryYearExclusive },
});

function person(over: Partial<Person> = {}): Person {
  return {
    id: "p1",
    name: "Alex",
    birthYear: START_YEAR - 40, // 40 now
    lifeExpectancy: 90,
    benefitClaimingAge: 67,
    jobs: [],
    ...over,
  };
}

function job(over: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    ownerId: "p1",
    startYear: START_YEAR - 10, // started 10 years ago
    endYear: START_YEAR + 25, // authored to run 25 more years (to age 65)
    salary: {
      startingSalaryCents: dollarsToCents(60_000),
      currentSalaryCents: dollarsToCents(90_000),
      realGrowthPct: 0,
    },
    ...over,
  };
}

function ctxOf(j: Job, owner: Person, membership: Partial<HouseholdMembership> = {}): HouseholdJobContext {
  return {
    job: j,
    owner,
    membership: { person: owner, startMonth: -Infinity, endMonth: null, ...membership },
  };
}

describe("resolveHouseholdJob — employment, membership and death, composed", () => {
  it("ends an authored job at its own endYear, and nothing else", () => {
    const resolved = resolveHouseholdJob(ctxOf(job({ endYear: START_YEAR + 12 }), person()), START_YEAR, AUTHORED);
    expect(resolved.endYearExclusive).toBe(START_YEAR + 12);
  });

  it("caps the selected job at a boundary INSIDE its own span — never extends", () => {
    const owner = person({ continuationJobId: "job-1", jobs: [job()] });
    const resolved = resolveHouseholdJob(ctxOf(job(), owner), START_YEAR, hypothetical(START_YEAR + 10));
    expect(resolved.endYearExclusive).toBe(START_YEAR + 10);
  });

  it("caps an UNSELECTED job at its own end even when the boundary is later", () => {
    const owner = person({ continuationJobId: null, jobs: [job()] });
    const resolved = resolveHouseholdJob(ctxOf(job(), owner), START_YEAR, hypothetical(START_YEAR + 40));
    expect(resolved.endYearExclusive).toBe(job().endYear); // never extended — nobody named it
  });

  it("clamps the growth anchor to 0 for a job already under way", () => {
    const resolved = resolveHouseholdJob(ctxOf(job(), person()), START_YEAR, AUTHORED);
    expect(resolved.employmentStartMonth).toBe(0);
  });

  it("leaves a future job's start month positive", () => {
    const future = job({ startYear: START_YEAR + 5, endYear: START_YEAR + 15 });
    const resolved = resolveHouseholdJob(ctxOf(future, person()), START_YEAR, AUTHORED);
    expect(resolved.employmentStartMonth).toBe(60);
  });

  it("caps employment at the owner's death, ahead of any authored end", () => {
    const longJob = job({ endYear: START_YEAR + 60 }); // would run to 100
    const dies70 = person({ lifeExpectancy: 70 }); // dies in 30 years
    const resolved = resolveHouseholdJob(ctxOf(longJob, dies70), START_YEAR, AUTHORED);
    expect(resolved.endYearExclusive).toBe(START_YEAR + 30);
  });

  it("a hypothetical boundary past death still stops at the death", () => {
    const dies70 = person({ lifeExpectancy: 70, continuationJobId: "job-1", jobs: [job()] });
    const resolved = resolveHouseholdJob(ctxOf(job(), dies70), START_YEAR, hypothetical(START_YEAR + 50));
    expect(resolved.endYearExclusive).toBe(START_YEAR + 30); // the death, not the boundary
  });

  it("paysHousehold is false for a job wholly behind 'now'", () => {
    const past = job({ startYear: START_YEAR - 20, endYear: START_YEAR - 5 });
    const resolved = resolveHouseholdJob(ctxOf(past, person()), START_YEAR, AUTHORED);
    expect(resolved.paysHousehold).toBe(false);
    expect(resolved.paidEndMonthExclusive).toBeLessThanOrEqual(resolved.paidStartMonth);
  });

  describe("membership clips the PAID window, never the employment", () => {
    it("an unbounded membership clips nothing", () => {
      const resolved = resolveHouseholdJob(ctxOf(job(), person()), START_YEAR, AUTHORED);
      expect(resolved.paidStartMonth).toBe(resolved.employmentStartMonth);
      expect(resolved.paidEndMonthExclusive).toBe(resolved.employmentEndMonthExclusive);
    });

    it("a late join narrows the paid start but not the employment start", () => {
      const resolved = resolveHouseholdJob(
        ctxOf(job(), person(), { startMonth: 24, endMonth: null }),
        START_YEAR,
        AUTHORED,
      );
      expect(resolved.employmentStartMonth).toBe(0); // unmoved
      expect(resolved.paidStartMonth).toBe(24);
    });

    it("an early separation narrows the paid end but not the employment end", () => {
      const resolved = resolveHouseholdJob(
        ctxOf(job(), person(), { startMonth: -Infinity, endMonth: 36 }),
        START_YEAR,
        AUTHORED,
      );
      expect(resolved.employmentEndMonthExclusive).toBe(25 * 12); // unmoved — the job's own end
      expect(resolved.paidEndMonthExclusive).toBe(36);
    });

    it("pays nothing when membership and employment never overlap", () => {
      // Joins after this job already ended.
      const endedEarly = job({ startYear: START_YEAR - 10, endYear: START_YEAR - 2 });
      const resolved = resolveHouseholdJob(
        ctxOf(endedEarly, person(), { startMonth: 12, endMonth: null }),
        START_YEAR,
        AUTHORED,
      );
      expect(resolved.paysHousehold).toBe(false);
    });
  });
});

describe("resolveJobPayDisplay — the whole-employment chart, and where it is uncounted", () => {
  it("has no uncounted stretch for a member present throughout", () => {
    const display = resolveJobPayDisplay(ctxOf(job(), person()), START_YEAR, AUTHORED);
    expect(display.uncountedSpans).toEqual([]);
    expect(display.paidSpan).toEqual(display.employmentSpan);
  });

  it("draws the AUTHORED start even when it is before 'now' — unlike the paid window", () => {
    // employmentSpan is for drawing the whole history; resolveHouseholdJob clamps its own start
    // to 0 because that is the growth anchor, and the two must not be confused for one another.
    const display = resolveJobPayDisplay(ctxOf(job(), person()), START_YEAR, AUTHORED);
    expect(display.employmentSpan.startMonth).toBe(-120); // 10 years before "now"
  });

  it("hatches only the months before a late-joining owner", () => {
    const display = resolveJobPayDisplay(
      ctxOf(job(), person(), { startMonth: 60, endMonth: null }),
      START_YEAR,
      AUTHORED,
    );
    expect(display.uncountedSpans).toEqual([{ startMonth: -120, endMonthExclusive: 60 }]);
    expect(display.paidSpan).toEqual({ startMonth: 60, endMonthExclusive: 25 * 12 });
  });

  it("hatches only the months after an early-separating owner", () => {
    const display = resolveJobPayDisplay(
      ctxOf(job(), person(), { startMonth: -Infinity, endMonth: 180 }),
      START_YEAR,
      AUTHORED,
    );
    expect(display.uncountedSpans).toEqual([{ startMonth: 180, endMonthExclusive: 25 * 12 }]);
    expect(display.paidSpan).toEqual({ startMonth: -120, endMonthExclusive: 180 });
  });

  it("hatches BOTH ends for a job that outlasts a join and a separation", () => {
    const display = resolveJobPayDisplay(
      ctxOf(job(), person(), { startMonth: 60, endMonth: 180 }),
      START_YEAR,
      AUTHORED,
    );
    expect(display.uncountedSpans).toEqual([
      { startMonth: -120, endMonthExclusive: 60 },
      { startMonth: 180, endMonthExclusive: 25 * 12 },
    ]);
    expect(display.paidSpan).toEqual({ startMonth: 60, endMonthExclusive: 180 });
  });

  it("hatches the WHOLE employment, as one span, when membership and job never overlap", () => {
    const laterJob = job({ startYear: START_YEAR + 5, endYear: START_YEAR + 15 });
    const display = resolveJobPayDisplay(
      ctxOf(laterJob, person(), { startMonth: -Infinity, endMonth: 12 }), // left long before this job starts
      START_YEAR,
      AUTHORED,
    );
    expect(display.paidSpan).toBeNull();
    expect(display.uncountedSpans).toEqual([display.employmentSpan]);
  });

  it("collapses to the job's own start, drawing nothing, when a boundary falls before it entirely", () => {
    const laterJob = job({ startYear: START_YEAR + 10, endYear: START_YEAR + 20 });
    const display = resolveJobPayDisplay(ctxOf(laterJob, person()), START_YEAR, hypothetical(START_YEAR + 2));
    expect(display.employmentSpan).toEqual({ startMonth: 120, endMonthExclusive: 120 });
    expect(display.paidSpan).toBeNull();
    expect(display.uncountedSpans).toEqual([]); // nothing to hatch — there is no span to draw at all
  });

  it("extends the employment span under a hypothetical that carries the selected job on", () => {
    const owner = person({ continuationJobId: "job-1", jobs: [job()] });
    const display = resolveJobPayDisplay(ctxOf(job(), owner), START_YEAR, hypothetical(START_YEAR + 40));
    expect(display.employmentSpan.endMonthExclusive).toBe(40 * 12);
  });
});
