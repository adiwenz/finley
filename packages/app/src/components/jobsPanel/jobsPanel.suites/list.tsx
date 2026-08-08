/**
 * **What the panel SHOWS, given a plan and an engine run** — no gestures, no writes.
 *
 * A job's row, its authored span, the stretch of it a stop-working preview would pay, the months
 * that are not this household's income at all, and the 401(k) elective-limit disclosure. Every
 * interval drawn here is resolved by the engine (`ProjectionResult.jobPayDisplay`); what these own
 * is that the panel renders that resolution rather than a rule of its own.
 */
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import {
  type NewLifeEvent,
} from "@finley/engine";
import { PLAN_DEFAULTS } from "../../../planDefaults";
import { START_YEAR } from "../../../config";
import { setJobDeferralFraction } from "../../../testing/planFixtures";
import {
  DEFAULT_JOB_ID,
  Harness,
  headline,
  partnerJob,
  partnerJoining,
  spin,
} from "../jobsPanel.testUtils";


describe("JobsPanel — listing", () => {
  it("lists the default job with its salary and its authored span", () => {
    render(<Harness />);
    expect(headline("Job 1")).toBe("$5,000/mo");
    expect(within(screen.getByLabelText("Job 1")).getByText(/age 18–65/i)).toBeTruthy();
  });

  it("charts a job to its own authored end when not previewing", () => {
    render(<Harness />);
    expect(
      screen.getByRole("img", { name: /Monthly pay across Job 1, from age 18 to 65,/i }),
    ).toBeTruthy();
  });

  it("caps a job's chart at the previewed stop-working age instead — display only", () => {
    // The preview only ever SHORTENS: a candidate below the job's authored end (65) moves the
    // chart; one above it would leave the job alone, since a hypothesis cannot invent work.
    render(<Harness previewStopAge={55} />);
    expect(
      screen.getByRole("img", { name: /Monthly pay across Job 1, from age 18 to 55,/i }),
    ).toBeTruthy();
    // The span label and the edit form still read the authored plan — the preview never
    // touches what Edit/Delete/Change pay act on.
    expect(within(screen.getByLabelText("Job 1")).getByText(/age 18–65/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    expect(Number(spin(/End age/i).value)).toBe(65); // the authored end, untouched by the preview
  });

  // Which job a preview EXTENDS, and where the extension is bounded, are the retirement
  // solver's own contract — pinned end to end in `retirementSolver.test.ts` ("which job a later
  // candidate age continues") and, for the membership/paid-window geometry a chart draws,
  // directly on `resolveJobPayDisplay` in `householdJob.test.ts`. What belongs here is only that
  // this panel draws whatever the engine resolved, which the single-job cap above and the
  // never-pays case below already establish.

  it("empties the chart of a job the preview never pays — one starting after the previewed stop-working age", () => {
    // Authored: work to 75, with a second open-ended job picked up at 70. Previewed: stop at
    // 65, which retires the household before that job ever starts — so the preview run pays it
    // nothing and resolves no series for it at all.
    const laterJob = {
      ...PLAN_DEFAULTS.primary.jobs[0]!,
      // A second id beside the engine-minted one; the panel only ever addresses a job by it.
      id: `${PLAN_DEFAULTS.primary.jobs[0]!.id}-later`,
      startYear: START_YEAR + 35, // age 70
      endYear: START_YEAR + 45, // to age 80
    };
    const initial = {
      ...PLAN_DEFAULTS,
      primary: { ...PLAN_DEFAULTS.primary, jobs: [PLAN_DEFAULTS.primary.jobs[0]!, laterJob] },
    };

    const { rerender } = render(<Harness initial={initial} />);
    // Not previewing: the job charts its authored span, 70 to the authored stop-working age.
    expect(
      screen.getByRole("img", { name: /Monthly pay across Job 2, from age 70 to 80,/i }),
    ).toBeTruthy();

    rerender(<Harness initial={initial} previewStopAge={65} />);
    // Previewing: no pay path at all — an empty span, topping out at nothing. Charting the
    // authored 70–75 here would put back on screen the very job the hypothesis retired.
    expect(
      screen.getByRole("img", {
        name: /Monthly pay across Job 2, from age 70 to 70,.*topping out at \$0 a month/i,
      }),
    ).toBeTruthy();
    // The row is still the authoring surface: it exists, says what it is, and edits the plan.
    expect(within(screen.getByLabelText("Job 2")).getByText(/age 70–80/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Edit Job 2/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Change pay on Job 2/i })).toBeTruthy();
    // The other job still charts — the preview caps it at 65 rather than emptying it.
    expect(
      screen.getByRole("img", { name: /Monthly pay across Job 1, from age 18 to 65,/i }),
    ).toBeTruthy();

    // Toggling the preview off restores the authored path, untouched.
    rerender(<Harness initial={initial} />);
    expect(
      screen.getByRole("img", { name: /Monthly pay across Job 2, from age 70 to 80,/i }),
    ).toBeTruthy();
  });
});


describe("JobsPanel — 401(k) elective-limit nudge", () => {
  /** A partner joining with one job that defers `pct` of `monthlyDollars`. */
  const partnerDeferring = (monthlyDollars: number, pct: number): NewLifeEvent =>
    partnerJoining([
      {
        ...partnerJob(monthlyDollars),
        deferral: { deferralFraction: pct / 100, fundAccountId: "retirement" },
      },
    ]);

  it("discloses that a deferral over the annual limit is paid as taxable income", () => {
    // $5,000/mo = $60k/yr; a 50% deferral is $30k, above the 2026 $24,500 elective limit.
    render(<Harness initial={setJobDeferralFraction(PLAN_DEFAULTS, DEFAULT_JOB_ID, 0.5)} />);
    expect(screen.getByText(/paid as taxable income/i)).toBeTruthy();
    // Phrased as the user's own on a single-earner plan — no name.
    expect(screen.getByText(/Across your jobs/i)).toBeTruthy();
    expect(within(screen.getByLabelText("Job 1")).getByText(/50% to 401\(k\)/i)).toBeTruthy();
  });

  it("shows no such disclosure when nothing is deferred", () => {
    render(<Harness />); // default 0% deferral
    expect(screen.queryByText(/paid as taxable income/i)).toBeNull();
  });

  it("names the PARTNER when the crossing is theirs", () => {
    // Individual limit: the primary defers nothing, Sam $30k of a $60k job. Scanning only
    // `Plan.jobs` misses it.
    render(<Harness events={[partnerDeferring(5000, 50)]} />);
    expect(screen.getByText(/Across Sam’s jobs/i)).toBeTruthy();
    expect(screen.getByText(/paid as taxable income/i)).toBeTruthy();
  });

  // That the limit is INDIVIDUAL — one person's jobs summed against their own limit, two earners
  // never pooled — is the scan's own rule, pinned on `firstDeferralLimitCrossing` in
  // `retirement/deferralLimit.test.ts`. The panel renders whichever crossing it is handed, which
  // is what the three cases above establish.
});


/**
 * **A membership has two edges, and a job can cross both of them.**
 *
 * Sam holds a job from 40 to 65 whatever this household does. Which of those months are its
 * income is a separate fact with its own two boundaries — the join and the separation — so a job
 * can be uncounted at the front, at the back, at both ends, or not at all. The card draws the
 * whole employment (shortening it would say Sam stopped working, which a separation is not) and
 * hatches each gap, wording it from where the gap sits beside the paid months.
 *
 * The intervals are the ENGINE's: `ProjectionResult.jobPayDisplay`, resolved against whichever
 * run the charts are showing. Nothing below is computed on this side, which is why previewing
 * needs no rule of its own. The geometry itself — which stretches come out hatched for every
 * join/separation shape — is pinned directly on `resolveJobPayDisplay` in `householdJob.test.ts`;
 * what these tests own is that the panel renders that resolution (both sentences, both preview
 * and authored) rather than a rule of its own.
 */
describe("JobsPanel — the months of a job that are not household income", () => {
  const separatingAt = (month: number): NewLifeEvent => ({
    id: "s1",
    type: "SeparationEvent",
    month,
    partnerPersonId: "p-1",
    alimonyMonthlyCents: 0,
    alimonyDurationMonths: 0,
    childSupportMonthlyCents: 0,
  });

  /**
   * Every card's uncounted intervals, in row order — `[startMonth, endMonthExclusive]`. What
   * each one MEANS is a sentence, asserted as the text a reader would actually meet.
   * Alex's job comes first and is always fully counted, so Sam's is the second entry.
   */
  const uncountedByCard = (): unknown[][][] =>
    screen
      .getAllByTestId("pay-chart-uncounted")
      .map((el) => JSON.parse(el.textContent || "[]") as unknown[][]);
  const samsUncounted = () => uncountedByCard()[1]!;
  /** Sam's job, running the partner's 40 to 65 — months 0 to 300 from "now". */
  const samsJob = () => partnerJob(5000);

  it("hatches BOTH ends for a job that outlasts a join and a separation", () => {
    // The case a single trailing suffix could not express: joined at 60, gone at 180, holding
    // the job from 0 to 300. Ten of those twenty-five years are this household's; the panel
    // used to keep the first five on the books silently.
    render(<Harness events={[partnerJoining([samsJob()], 60), separatingAt(180)]} />);

    // TWO hatches, and two sentences — one per end, neither standing for the other. Where each
    // interval falls is `householdJob.test.ts` (`resolveJobPayDisplay`); that there are two of
    // them rather than one trailing suffix is what this panel got wrong.
    expect(samsUncounted()).toHaveLength(2);
    expect(screen.getByText(/was not yet part of the household/)).toBeTruthy();
    expect(screen.getByText(/was no longer part of the household/)).toBeTruthy();
  });

  it("words the hatch differently when no month was ever paid — neither 'yet' nor 'no longer'", () => {
    // The one sentence with no paid window to sit beside: a job the household never collected a
    // cent of. The geometry that produces this case (`paidSpan === null`) is pinned directly on
    // `resolveJobPayDisplay`; what is the panel's own is choosing this wording over the other two.
    render(
      <Harness
        events={[
          partnerJoining([partnerJob(5000, undefined, { startYear: START_YEAR + 5 })]),
          separatingAt(12),
        ]}
      />,
    );
    expect(screen.getByText(/not household income during this period/)).toBeTruthy();
    expect(screen.queryByText(/part of the household/)).toBeNull();
  });

  it("hatches nothing while the household is whole", () => {
    render(<Harness events={[partnerJoining([samsJob()])]} />);

    expect(uncountedByCard().every((spans) => spans.length === 0)).toBe(true);
    expect(screen.queryByText(/part of this household/)).toBeNull();
  });

  it("previews through the engine's resolution rather than a rule of its own", () => {
    // Previewing "everyone stops at Alex's 50" caps Sam's employment at month 180 — and Sam
    // separated at 120, so the uncounted stretch runs 120 to 180 and stops there. Both facts
    // come from one resolution, so the hatch cannot outlast the span it marks, and it never
    // simply runs to the edge of the chart.
    render(
      <Harness
        events={[partnerJoining([samsJob()]), separatingAt(120)]}
        previewStopAge={50}
      />,
    );

    expect(samsUncounted()).toEqual([[120, 180]]);
  });
});
