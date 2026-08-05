/**
 * **Which months of a job are this household's income, and which are not** —
 * {@link resolveJobPayDisplay}, the one answer every surface that draws a job reads.
 *
 * A membership has two edges and a job can cross either, both, or neither, so there are zero,
 * one or two gaps. The app used to look only for a trailing one, which silently kept a partner's
 * pre-join years on the books; these pin all four shapes and the two degenerate ones beside them.
 *
 * Months from "now" throughout, and the employment span reaches BACK before 0 where the job
 * does — a chart draws that history and the projection pays none of it. The gaps here are the
 * membership's alone, which is why a household's own long-held job reports none.
 */
import { describe, it, expect } from "vitest";
import { resolveJobPayDisplay, type HouseholdJobContext } from "./householdJob";
import { dollarsToCents } from "./cashFlowSeries";
import { SAMPLE_START_YEAR } from "./testing/samplePlan";
import type { Job } from "./job";
import type { Person } from "./person";
import type { HouseholdMembership } from "./ledger/household";

const NOW_YEAR = SAMPLE_START_YEAR;
const BIRTH_YEAR = NOW_YEAR - 40;
const AUTHORED = { kind: "authored" } as const;
/** Months from "now" to the owner's `age` — every fixture below is on one person's clock. */
const at = (age: number) => (BIRTH_YEAR + age - NOW_YEAR) * 12;

function job(startAge: number, endAge: number): Job {
  return {
    id: "j1",
    ownerId: "p2",
    startYear: BIRTH_YEAR + startAge,
    endYear: BIRTH_YEAR + endAge,
    salary: {
      startingSalaryCents: dollarsToCents(60_000),
      currentSalaryCents: dollarsToCents(60_000),
      realGrowthPct: 0,
    },
  };
}

const owner: Person = {
  id: "p2",
  name: "Partner",
  birthYear: BIRTH_YEAR,
  benefitClaimingAge: 67,
  jobs: [],
  continuationJobId: null,
};

/**
 * One job held by a member who joined at `startMonth` and left at `endMonth` (`null` = still
 * here). `-Infinity` is the household's own — the primary, or anyone here for all of it — which
 * is how a fixture says "the join is not what this case is about".
 */
function context(j: Job, startMonth: number, endMonth: number | null): HouseholdJobContext {
  const membership: HouseholdMembership = { person: { ...owner, jobs: [j] }, startMonth, endMonth };
  return { job: j, owner: membership.person, membership };
}

const displayOf = (ctx: HouseholdJobContext) => resolveJobPayDisplay(ctx, NOW_YEAR, AUTHORED);

describe("resolveJobPayDisplay", () => {
  it("reports no gap for a job held entirely inside the membership", () => {
    // The ordinary case, and the one that must stay silent: a member throughout, so every month
    // of the employment is this household's and there is nothing to disclaim.
    const display = displayOf(context(job(35, 65), -Infinity, null));

    expect(display.employmentSpan).toEqual({ startMonth: at(35), endMonthExclusive: at(65) });
    expect(display.paidSpan).toEqual({ startMonth: at(35), endMonthExclusive: at(65) });
    expect(display.uncountedSpans).toEqual([]);
  });

  it("reports a PREFIX for a job that was already running when its owner joined", () => {
    const display = displayOf(context(job(35, 65), at(45), null));

    expect(display.paidSpan).toEqual({ startMonth: at(45), endMonthExclusive: at(65) });
    expect(display.uncountedSpans).toEqual([
      { startMonth: at(35), endMonthExclusive: at(45), reason: "before-household-membership" },
    ]);
  });

  it("reports a SUFFIX for a job that outlasts its owner's membership", () => {
    const display = displayOf(context(job(35, 65), -Infinity, at(55)));

    expect(display.paidSpan).toEqual({ startMonth: at(35), endMonthExclusive: at(55) });
    expect(display.uncountedSpans).toEqual([
      { startMonth: at(55), endMonthExclusive: at(65), reason: "after-household-membership" },
    ]);
  });

  it("reports BOTH for a job that spans the join and the separation", () => {
    // The spec's own example, and the shape a single trailing suffix cannot express: 35–45
    // uncounted, 45–55 the household's, 55–65 uncounted. Ordered in time, so a caller can draw
    // them in the order it is given them.
    const display = displayOf(context(job(35, 65), at(45), at(55)));

    expect(display.paidSpan).toEqual({ startMonth: at(45), endMonthExclusive: at(55) });
    expect(display.uncountedSpans).toEqual([
      { startMonth: at(35), endMonthExclusive: at(45), reason: "before-household-membership" },
      { startMonth: at(55), endMonthExclusive: at(65), reason: "after-household-membership" },
    ]);
  });

  it("reports the whole span for a job finished before its owner joined", () => {
    // No paid window at all — an answer, not a gap. The reason names the edge that missed it:
    // they were not here yet, which is a different sentence from having left.
    const display = displayOf(context(job(20, 30), at(45), null));

    expect(display.paidSpan).toBeNull();
    expect(display.uncountedSpans).toEqual([
      { startMonth: at(20), endMonthExclusive: at(30), reason: "before-household-membership" },
    ]);
  });

  it("reports the whole span for a job begun after its owner left", () => {
    const display = displayOf(context(job(50, 60), 0, at(45)));

    expect(display.paidSpan).toBeNull();
    expect(display.uncountedSpans).toEqual([
      { startMonth: at(50), endMonthExclusive: at(60), reason: "after-household-membership" },
    ]);
  });

  it("emits nothing where an edge lands exactly on the employment's own", () => {
    // Joining the month the job starts, and leaving the month it ends, are the two ways to
    // produce a zero-length interval — the shape a reader would meet as a hatch marking no time
    // at all, or a sentence about a window that does not exist.
    const joinedOnDay1 = displayOf(context(job(35, 65), at(35), null));
    expect(joinedOnDay1.uncountedSpans).toEqual([]);
    expect(joinedOnDay1.paidSpan).toEqual({ startMonth: at(35), endMonthExclusive: at(65) });

    const leftOnTheLastDay = displayOf(context(job(35, 65), -Infinity, at(65)));
    expect(leftOnTheLastDay.uncountedSpans).toEqual([]);

    // And both at once.
    const exactlyTheJob = displayOf(context(job(35, 65), at(35), at(65)));
    expect(exactlyTheJob.uncountedSpans).toEqual([]);
    expect(exactlyTheJob.paidSpan).toEqual({ startMonth: at(35), endMonthExclusive: at(65) });
  });

  it("resolves against the hypothesis's employment end, membership and all", () => {
    // A candidate boundary moves the EMPLOYMENT; the membership is unmoved by it. So the paid
    // window is the intersection of the two under the hypothesis, and the gaps are measured
    // against the hypothetical span rather than the authored one — a suffix that ran to 65
    // authored runs only to the boundary here, and never past the span it marks.
    const hypothetical = (boundaryAge: number) =>
      resolveJobPayDisplay(context(job(35, 65), -Infinity, at(55)), NOW_YEAR, {
        kind: "hypothetical",
        stopWorking: { boundaryYearExclusive: BIRTH_YEAR + boundaryAge },
      });

    // Capped at 60: employment 35–60, paid 35–55, uncounted 55–60 — not 55–65.
    const capped = hypothetical(60);
    expect(capped.employmentSpan).toEqual({ startMonth: at(35), endMonthExclusive: at(60) });
    expect(capped.uncountedSpans).toEqual([
      { startMonth: at(55), endMonthExclusive: at(60), reason: "after-household-membership" },
    ]);

    // Capped INSIDE the membership: nothing is uncounted at all, because the employment now
    // ends before the separation does.
    const early = hypothetical(50);
    expect(early.employmentSpan).toEqual({ startMonth: at(35), endMonthExclusive: at(50) });
    expect(early.paidSpan).toEqual({ startMonth: at(35), endMonthExclusive: at(50) });
    expect(early.uncountedSpans).toEqual([]);
  });

  it("collapses a job the boundary falls before, and disclaims nothing about it", () => {
    // A job authored to start after the household stopped working does not happen. Its span
    // collapses onto its own start rather than running backwards, and saying the household was
    // not paid for it would put a job on screen the hypothesis removed.
    const display = resolveJobPayDisplay(context(job(50, 60), -Infinity, null), NOW_YEAR, {
      kind: "hypothetical",
      stopWorking: { boundaryYearExclusive: BIRTH_YEAR + 45 },
    });

    expect(display.employmentSpan).toEqual({ startMonth: at(50), endMonthExclusive: at(50) });
    expect(display.paidSpan).toBeNull();
    expect(display.uncountedSpans).toEqual([]);
  });
});
