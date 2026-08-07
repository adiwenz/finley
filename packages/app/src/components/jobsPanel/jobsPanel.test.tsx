/**
 * @vitest-environment jsdom
 *
 * Jobs panel. Pins that a person can hold any number of jobs (none privileged, several
 * each with its own authored end), that add/edit/delete are value-plane edits to `plan.jobs`, and that
 * the 401(k) elective-limit nudge fires here across all jobs.
 */
import { describe, it, expect, afterEach } from "vitest";
import { useMemo } from "react";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { enterNumber } from "../../testing/numberField";
import {
  PRIMARY_PERSON_ID,
  Projection,
  dollarsToCents,
  type Job,
  type Ledger,
  type NewLifeEvent,
  type Plan,
  type ProjectionSeries,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import type { Transact } from "../../hooks/useProjection";
import { useTestProjection, stateOf } from "../../testing/projectionHarness";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { START_YEAR } from "../../config";
import { primaryJobs } from "../../planPeople";
import { addJobPayChange, setJobDeferralFraction } from "../../testing/planFixtures";
import { JobsPanel } from "./jobsPanel";

afterEach(cleanup);

/** The default plan's single job, addressed by its engine-minted id rather than a hardcoded one. */
const DEFAULT_JOB_ID = PLAN_DEFAULTS.primary.jobs[0]!.id;

/** A refused transaction: the facade threw, so nothing on either plane changed. */
const refuseEveryWrite: Transact = () => undefined;

/**
 * Controlled harness standing in for `App`, with a probe for each plane a job can live on: the
 * primary person's on the plan, a partner's on their `RelationshipEvent`. Writes go through a
 * real `useProjection`, so an edit spanning both planes is committed the way the app commits
 * it — one transaction, all of it or none.
 */
function Harness({
  initial = PLAN_DEFAULTS,
  events = [],
  rejectRevisions = false,
  previewStopAge = null,
}: {
  initial?: Plan;
  events?: readonly NewLifeEvent[];
  /** Stands in for a conflict: the transaction is refused, as the facade would refuse it. */
  rejectRevisions?: boolean;
  /** Stands in for the Retirement panel's preview toggle, on at this age. */
  previewStopAge?: number | null;
}) {
  const { state, transact } = useTestProjection(initial, {
    events: events.map((e, i) => ({ ...e, sequenceNumber: i })),
    nextSequenceNumber: events.length,
  });
  const budget = state.scenario.plan;
  const ledger = state.scenario.ledger;
  const projection = useMemo(() => Projection.fromState(state, usJurisdiction), [state]);
  const household = useMemo(() => projection.run(usJurisdiction).household, [projection]);
  // A real preview run — the resolved household a stop-working candidate produces — rather
  // than a hand-built stand-in, so these tests exercise the same engine path the app does.
  // The run the charts read: the preview when the toggle is on, the authored pass otherwise —
  // the same swap `main.tsx` makes, so these exercise the engine path the app does.
  const chartRun = useMemo(
    () =>
      previewStopAge === null
        ? projection.run(usJurisdiction)
        : projection.runAtStopWorkingAge(usJurisdiction, previewStopAge),
    [projection, previewStopAge],
  );

  return (
    <>
      <JobsPanel
        budget={budget}
        transact={rejectRevisions ? refuseEveryWrite : transact}
        household={household}
        ledger={ledger}
        projection={projection}
        payDisplay={chartRun.jobPayDisplay}
      />
      <output data-testid="job-count">{primaryJobs(budget).length}</output>
      <output data-testid="partner-jobs">{JSON.stringify(partnerJobsOf(ledger))}</output>
      {/* Both planes as the panel left them, so a test can project the real pair rather
          than a hand-built stand-in. */}
      <output data-testid="plan">{JSON.stringify(budget)}</output>
      <output data-testid="ledger">{JSON.stringify(ledger)}</output>
    </>
  );
}

/** The ledger plane: jobs authored on the partner's RelationshipEvent. */
function partnerJobsOf(ledger: Ledger): readonly Job[] {
  for (const e of ledger.events) if (e.type === "RelationshipEvent") return e.person.jobs;
  return [];
}

const partnerJoining = (jobs: readonly Job[], month = 0): NewLifeEvent => ({
  id: "r1",
  type: "RelationshipEvent",
  month,
  person: {
    id: "p-1",
    name: "Sam",
    birthYear: START_YEAR - 40,
    lifeExpectancy: 85,
    benefitClaimingAge: 67,
    jobs,
  },
});

/** Open-ended, started at the partner's age 40 ("now"). */
const partnerJob = (monthlyDollars: number, name?: string, over: Partial<Job> = {}): Job => ({
  id: "p-1-job-1",
  ...(name ? { name } : {}),
  ownerId: "p-1",
  startYear: START_YEAR,
  endYear: START_YEAR - 40 + 65,
  salary: { startingSalaryCents: dollarsToCents(monthlyDollars * 12), currentSalaryCents: dollarsToCents(monthlyDollars * 12), realGrowthPct: 0 },
  ...over,
});

const spin = (name: RegExp | string) => screen.getByRole("spinbutton", { name }) as HTMLInputElement;
/**
 * A row's headline — CURRENT pay. Addressed by its title rather than its text: the row now also
 * charts and lists the same job's pay, so the figure legitimately appears more than once.
 */
const headline = (label: string): string =>
  within(screen.getByLabelText(label)).getByTitle(/Current pay/).textContent ?? "";
/** The pay-history list on a row, where every dated change reads back. */
const timeline = (label: string) => within(screen.getByLabelText(`Pay history for ${label}`));
const jobCount = () => Number(screen.getByTestId("job-count").textContent);
const partnerJobs = (): readonly Job[] =>
  JSON.parse(screen.getByTestId("partner-jobs").textContent || "[]") as Job[];
/** What a partner's job pays NOW — the month-0 anchor, which is what the panel's headline
 * quotes and what the salary field on a job with a past authors. */
const partnerMonthlyDollars = (i = 0): number =>
  Math.round((partnerJobs()[i]?.salary.currentSalaryCents ?? 0) / 12 / 100);
/** Both planes as the panel left them — what the app itself would project. */
const authored = (): { plan: Plan; ledger: Ledger } => ({
  plan: JSON.parse(screen.getByTestId("plan").textContent || "{}") as Plan,
  ledger: JSON.parse(screen.getByTestId("ledger").textContent || "{}") as Ledger,
});

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

  it("runs the CONTINUATION job on to a later preview age, and leaves the others alone", () => {
    // Job 1 is the one being worked today and Job 2 starts at 48, so with nobody having opened
    // the picker the initialization rule names Job 1 — "continue working" means the work they
    // are actually doing. Previewing "retire at 76" therefore carries Job 1 to 76 and leaves
    // Job 2 ending exactly where it was authored to.
    //
    // Which job that is comes from the selection and never from the dates. The rule this
    // replaced took the LAST-ending job, so this same plan used to extend Job 2 instead — an
    // answer that reads plausibly here and is wrong wherever the later job is a fixed term.
    render(
      <Harness
        initial={{
          ...PLAN_DEFAULTS,
          primary: {
            ...PLAN_DEFAULTS.primary,
            jobs: [
              { ...PLAN_DEFAULTS.primary.jobs[0]!, endYear: START_YEAR + 13 }, // ends at age 48
              {
                ...PLAN_DEFAULTS.primary.jobs[0]!,
                id: `${PLAN_DEFAULTS.primary.jobs[0]!.id}-second`,
                startYear: START_YEAR + 13,
                endYear: START_YEAR + 35, // to age 70
              },
            ],
          },
        }}
        previewStopAge={76}
      />,
    );
    expect(
      screen.getByRole("img", { name: /Monthly pay across Job 1, from age 18 to 76,/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", { name: /Monthly pay across Job 2, from age 48 to 70,/i }),
    ).toBeTruthy();
  });

  it("caps a fixed-term job's chart at the preview age too — never extends past it, but never lets one outlast the boundary either", () => {
    render(
      <Harness
        initial={{
          ...PLAN_DEFAULTS,
          primary: {
            ...PLAN_DEFAULTS.primary,
            jobs: [{ ...PLAN_DEFAULTS.primary.jobs[0]!, endYear: START_YEAR + 45 }], // authored to age 80
          },
        }}
        previewStopAge={76}
      />,
    );
    expect(
      screen.getByRole("img", { name: /Monthly pay across Job 1, from age 18 to 76,/i }),
    ).toBeTruthy();
    // The authored span — what Edit shows and would save — is untouched.
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    expect(Number(spin(/End age/i).value)).toBe(80);
  });

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

describe("JobsPanel — add / edit / delete", () => {
  it("adds a second job — a person may hold several, none privileged", () => {
    render(<Harness />);
    expect(jobCount()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /Add a job/i }));
    enterNumber(spin(/Monthly salary/i), "2000");
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));
    expect(jobCount()).toBe(2);
    expect(headline("Job 2")).toBe("$2,000/mo");
  });

  it("edits a job's salary in place", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    enterNumber(spin(/Monthly salary now/i), "8000");
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(headline("Job 1")).toBe("$8,000/mo");
  });

  it("caps the 401(k) contribution at 100% — you can't defer more than your salary", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    const deferral = spin(/401\(k\) contribution/i);
    fireEvent.change(deferral, { target: { value: "1000" } });
    fireEvent.blur(deferral); // NumInput clamps to its max on blur
    expect(Number(deferral.value)).toBe(100);
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    // Saved at the cap, not the typed 1000%.
    expect(within(screen.getByLabelText("Job 1")).getByText(/100% to 401\(k\)/i)).toBeTruthy();
  });

  it("sets an employer match on a deferring job — it lands on the plan and shows on the row", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    enterNumber(spin(/401\(k\) contribution/i), "6");
    enterNumber(spin(/Employer match/i), "50");
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    // Deposited on top of the deferral in the engine — here we pin only that the authored
    // fraction reaches the plan and reads out on the row beside the contribution.
    expect(authored().plan.primary.jobs[0]?.deferral?.employerMatchFraction).toBe(0.5);
    expect(within(screen.getByLabelText("Job 1")).getByText(/6% to 401\(k\) · 50% match/i)).toBeTruthy();
  });

  it("reads a match back into the edit form so it round-trips", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    enterNumber(spin(/401\(k\) contribution/i), "6");
    enterNumber(spin(/Employer match/i), "50");
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    expect(Number(spin(/Employer match/i).value)).toBe(50);
  });

  it("shows no match on the row when the deferral has none", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    enterNumber(spin(/401\(k\) contribution/i), "6");
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    const row = screen.getByLabelText("Job 1");
    expect(within(row).getByText(/6% to 401\(k\)/i)).toBeTruthy();
    expect(within(row).queryByText(/match/i)).toBeNull();
  });

  it("moves a job's end through the end-age control", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    enterNumber(spin(/End age/i), "50");
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(within(screen.getByLabelText("Job 1")).getByText(/age 18–50/)).toBeTruthy();
  });

  // A job must be WORKED while its owner is alive, so the engine refuses one ending past their
  // death. A field that let a higher age through would commit a value the very next write
  // rejected — the form would close on an edit that never landed, which reads to the user as
  // nothing having happened at all. So the field stops where the engine does.
  describe("the end age stops at the owner's own life expectancy", () => {
    it("bounds the control by the owner's expectancy, not the engine's age ceiling", () => {
      // Alex's expectancy is 90; MAX_LIVED_AGE (119) is not this field's bound.
      render(<Harness />);
      fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
      expect(Number(spin(/End age/i).max)).toBe(PLAN_DEFAULTS.primary.lifeExpectancy);
      // A job must still have a month to be worked in, so its START stops one below that.
      expect(Number(spin(/Start age/i).max)).toBe(PLAN_DEFAULTS.primary.lifeExpectancy - 1);
    });

    it("clamps a typed age past the expectancy, and the clamped edit LANDS", () => {
      // The whole point: the edit commits at 90 rather than being refused and silently
      // discarded. 91 is the age that used to close the form and change nothing.
      render(<Harness />);
      fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
      enterNumber(spin(/End age/i), "91");
      fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
      expect(within(screen.getByLabelText("Job 1")).getByText(/age 18–90/)).toBeTruthy();
    });

    it("allows an end AT the expectancy — working to the last month lived stays writable", () => {
      render(<Harness />);
      fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
      enterNumber(spin(/End age/i), "90");
      fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
      expect(authored().plan.primary.jobs[0].endYear).toBe(
        PLAN_DEFAULTS.primary.birthYear + PLAN_DEFAULTS.primary.lifeExpectancy,
      );
    });

    it("reads the bound off the PARTNER when the job is theirs", () => {
      // Sam's expectancy is 85 and the primary's is 90. A job takes only its owner, so a
      // partner's form must not be bounded by somebody else's life.
      render(<Harness events={[partnerJoining([partnerJob(2500)])]} />);
      fireEvent.click(screen.getByRole("button", { name: /Edit Sam · Job 1/i }));
      expect(Number(spin(/End age/i).max)).toBe(85);
    });
  });

  it("keeps the form open when a write is refused, rather than closing on an edit that never landed", () => {
    // The bounds above mean the form cannot reach the ordinary refusals, but a state they
    // cannot see (an expectancy lowered on another panel) still can. Losing the typed draft
    // AND the plan change at once leaves nothing to tell the user anything happened.
    render(<Harness rejectRevisions />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    enterNumber(spin(/End age/i), "50");
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeTruthy();
    expect(Number(spin(/End age/i).value)).toBe(50);
    expect(within(screen.getByLabelText("Job 1")).getByText(/age 18–65/)).toBeTruthy();
  });

  it("offers no way to author a job without an end — the field is always there", () => {
    // There used to be an "Open-ended (runs until retirement)" checkbox that hid this field,
    // and a job with it ticked silently ended at whatever retirement age was authored on
    // another panel. Every job says when it ends, so the control is unconditional.
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    expect(screen.queryByLabelText(/Open-ended/i)).toBeNull();
    expect(spin(/End age/i)).toBeTruthy();
    expect(Number(spin(/End age/i).value)).toBe(65);
  });

  it("deletes a job", () => {
    render(<Harness />);
    expect(jobCount()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /Delete Job 1/i }));
    expect(jobCount()).toBe(0);
    expect(screen.getByText(/No jobs yet/i)).toBeTruthy();
  });

  it("clears an in-progress edit when its job is deleted", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Delete Job 1/i }));
    expect(jobCount()).toBe(0);
    expect(screen.queryByRole("button", { name: /^Save$/ })).toBeNull();
  });

  it("clears an in-progress pay change when its job is deleted", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Change pay on Job 1/i }));
    expect(screen.getByRole("group", { name: /Pay change/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Delete Job 1/i }));
    expect(jobCount()).toBe(0);
    expect(screen.queryByRole("group", { name: /Pay change/i })).toBeNull();
  });

  it("names a job — the row is titled by the name, and it round-trips back into the edit form", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /Job name/i }), {
      target: { value: "Software Engineer" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    // Titled by the name now, not the positional "Job 1".
    expect(headline("Software Engineer")).toBe("$5,000/mo");
    fireEvent.click(screen.getByRole("button", { name: /Edit Software Engineer/i }));
    expect((screen.getByRole("textbox", { name: /Job name/i }) as HTMLInputElement).value).toBe(
      "Software Engineer",
    );
  });

  it("leaves a whitespace-named job titled positionally in the row", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /Job name/i }), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(screen.getByLabelText("Job 1")).toBeTruthy();
  });
});

describe("JobsPanel — every member's jobs", () => {
  const withPartner = (jobs: readonly Job[] = [partnerJob(2000)]) => [partnerJoining(jobs)];

  it("lists a partner's jobs next to the primary person's, each named by its owner", () => {
    // Both earners' jobs are one list; a partner's used to be reachable only as they joined.
    render(<Harness events={withPartner()} />);
    expect(headline("Alex · Job 1")).toBe("$5,000/mo");
    const partnerRow = screen.getByLabelText("Sam · Job 1");
    expect(headline("Sam · Job 1")).toBe("$2,000/mo");
    // Spans read in the owner's age, not the primary person's: Sam is 40, not 35.
    expect(within(partnerRow).getByText(/age 40–65/)).toBeTruthy();
  });

  it("edits a partner's job — the revision is written back to their RelationshipEvent", () => {
    render(<Harness events={withPartner()} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Sam · Job 1/i }));
    enterNumber(spin(/Monthly salary/i), "3500");
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    expect(headline("Sam · Job 1")).toBe("$3,500/mo");
    expect(partnerMonthlyDollars()).toBe(3500); // the ledger event now carries the new pay
    expect(jobCount()).toBe(1); // and the primary person's jobs are untouched
  });

  it("deletes a partner's job without touching the plan", () => {
    render(<Harness events={withPartner()} />);
    fireEvent.click(screen.getByRole("button", { name: /Delete Sam · Job 1/i }));
    expect(partnerJobs()).toHaveLength(0);
    expect(jobCount()).toBe(1);
    expect(screen.queryByLabelText("Sam · Job 1")).toBeNull();
  });

  it("adds a job for the partner from this panel, via the owner picker", () => {
    render(<Harness events={withPartner([])} />); // partner in the household, no jobs yet
    fireEvent.click(screen.getByRole("button", { name: /Add a job/i }));
    fireEvent.change(screen.getByLabelText("Whose job"), { target: { value: "p-1" } });
    enterNumber(spin(/Monthly salary now/i), "2500");
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));

    expect(partnerJobs()).toHaveLength(1);
    expect(partnerJobs()[0].ownerId).toBe("p-1");
    expect(partnerMonthlyDollars()).toBe(2500);
    expect(jobCount()).toBe(1); // added to the partner, NOT to the primary person
    expect(headline("Sam · Job 1")).toBe("$2,500/mo");
  });

  it("mints a partner's new job off the shared counter, not a per-owner scheme", () => {
    render(<Harness events={withPartner([])} />);
    fireEvent.click(screen.getByRole("button", { name: /Add a job/i }));
    fireEvent.change(screen.getByLabelText("Whose job"), { target: { value: "p-1" } });
    enterNumber(spin(/Monthly salary now/i), "2500");
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));

    const { plan } = authored();
    const minted = partnerJobs()[0].id;
    // One namespace with the plan's jobs, and clear of every id already in the household.
    expect(minted).toMatch(/^job-\d+$/);
    expect(plan.primary.jobs.map((j) => j.id)).not.toContain(minted);
  });

  it("writes nothing when the ledger refuses the revision", () => {
    // A partner's jobs ride their RelationshipEvent, so editing one is a ledger revision. A
    // refusal must leave the job exactly as it was rather than half-edited.
    render(<Harness events={withPartner([partnerJob(2500)])} rejectRevisions />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Sam · Job 1/i }));
    // Sam started this job at their current age, so there is no history field beside it.
    enterNumber(spin(/^Monthly salary\$$/), "9000");
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    expect(partnerMonthlyDollars()).toBe(2500); // the refused salary did not stick
    expect(headline("Sam · Job 1")).toBe("$2,500/mo");
    expect(jobCount()).toBe(1); // and the other plane was never touched either
  });

  it("offers no owner picker when EDITING — the owner is fixed context instead", () => {
    // Moving a job would re-read every age against another birth year, shifting its whole
    // calendar and stranding the pay changes outside the new span. Delete and re-add instead.
    render(<Harness events={withPartner([])} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Alex · Job 1/i }));
    expect(screen.queryByLabelText("Whose job")).toBeNull();
    // Not merely absent: the settled answer is stated where the picker would have been.
    expect(screen.getByTestId("job-owner").textContent).toMatch(/Alex’s job/);
    // Still offered while adding, where it settles whose job this will be.
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    fireEvent.click(screen.getByRole("button", { name: /Add a job/i }));
    expect(screen.getByLabelText("Whose job")).toBeTruthy();
  });

  it("names the partner as the fixed owner when editing THEIR job", () => {
    render(<Harness events={withPartner([partnerJob(2500)])} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Sam · Job 1/i }));
    expect(screen.getByTestId("job-owner").textContent).toMatch(/Sam’s job/);
    expect(screen.queryByLabelText("Whose job")).toBeNull();
  });

  it("states no owner at all on a single-earner plan — there is nobody else it could be", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    expect(screen.queryByTestId("job-owner")).toBeNull();
    expect(screen.queryByLabelText("Whose job")).toBeNull();
  });

  it("creates a job for EITHER eligible owner from the same picker", () => {
    render(<Harness events={withPartner([])} />);
    // The primary person, explicitly — not merely the default.
    fireEvent.click(screen.getByRole("button", { name: /Add a job/i }));
    fireEvent.change(screen.getByLabelText("Whose job"), { target: { value: PRIMARY_PERSON_ID } });
    enterNumber(spin(/Monthly salary/i), "1500");
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));
    expect(jobCount()).toBe(2);
    expect(partnerJobs()).toHaveLength(0);

    // Then the partner, from the same form. The draft opened on Alex's age 35, which is
    // history for 40-year-old Sam — so the form now shows both anchors and "now" is the one
    // to state.
    fireEvent.click(screen.getByRole("button", { name: /Add a job/i }));
    fireEvent.change(screen.getByLabelText("Whose job"), { target: { value: "p-1" } });
    enterNumber(spin(/Monthly salary now/i), "2500");
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));
    expect(jobCount()).toBe(2);
    expect(partnerJobs()).toHaveLength(1);
    expect(partnerJobs()[0].ownerId).toBe("p-1");
  });

  it("re-reads the end-age bound when the owner picker moves to a shorter-lived owner", () => {
    // The bound is the SELECTED owner's, settled at the moment the picker says whose job it is
    // — Alex's expectancy is 90 and Sam's is 85. A form that kept the opening owner's bound
    // would let a partner's job be authored past their death, which the engine then refuses.
    render(<Harness events={withPartner([])} />);
    fireEvent.click(screen.getByRole("button", { name: /Add a job/i }));
    expect(Number(spin(/End age/i).max)).toBe(PLAN_DEFAULTS.primary.lifeExpectancy);

    fireEvent.change(screen.getByLabelText("Whose job"), { target: { value: "p-1" } });
    expect(Number(spin(/End age/i).max)).toBe(85);

    // And it binds on submit: an end typed for Alex, then handed to Sam, lands at Sam's 85.
    enterNumber(spin(/End age/i), "90");
    enterNumber(spin(/Monthly salary now/i), "2500");
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));
    const sam = partnerJobs()[0];
    expect(sam.endYear - (START_YEAR - 40)).toBe(85);
  });

  it("removes a pay change from a partner's job, on their own plane", () => {
    // Base + Adjustments reaches every earner, so Remove must route by owner.
    const raised: Job = {
      ...partnerJob(2000),
      payChanges: [{ id: "adjustment-7", month: 12, kind: "setTo", cents: dollarsToCents(3000) }],
    };
    render(<Harness events={withPartner([raised])} />);
    // Sam is 40 now, so month 12 reads back on the age-41 row of their pay history.
    expect(timeline("Sam · Job 1").getByText(/Pay set to \$3,000\/mo/)).toBeTruthy();
    expect(timeline("Sam · Job 1").getByText("age 41")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: /Remove pay change at age 41 on Sam · Job 1/i }),
    );
    expect(partnerJobs()[0].payChanges).toBeUndefined();
    expect(screen.queryByText(/Pay set to \$3,000\/mo/)).toBeNull();
  });

  it("offers no owner picker in a single-earner household", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Add a job/i }));
    expect(screen.queryByLabelText("Whose job")).toBeNull();
  });
});

describe("JobsPanel — an ordinary edit changes only what it names", () => {
  /**
   * The other half of the ownership guarantee. Proving an edit *cannot* restate the owner is a
   * type argument; this proves the edit that does happen is otherwise inert — the stored job
   * differs in exactly the field edited, and the projection reads it the same way it always did.
   * Both matter: a "preserving" edit that quietly re-serialised the job would keep `ownerId` and
   * still lose everything else.
   */
  const richJob: Job = {
    ...PLAN_DEFAULTS.primary.jobs[0]!,
    name: "Software Engineer",
    payChanges: [{ id: "adjustment-8", month: 24, kind: "changeBy", cents: -dollarsToCents(500) }],
    incomeOverrides: [{ id: "adjustment-9", month: 6, kind: "addBonus", cents: dollarsToCents(5000) }],
  };
  const planWithRichJob: Plan = {
    ...PLAN_DEFAULTS,
    primary: { ...PLAN_DEFAULTS.primary, jobs: [richJob] },
  };

  /** Every wage source the projection pays `ownerId` in `month`, as cents. */
  function wagesFor(series: ProjectionSeries, ownerId: string, month: number): number {
    const sources = series.months.find((m) => m.month === month)?.flows?.incomeSources ?? [];
    return sources
      .filter((s) => s.category === "wages" && s.ownerId === ownerId)
      .reduce((sum, s) => sum + s.cashInflowCents, 0);
  }

  it("serialises to the same job but for the edited field — ownerId included", () => {
    render(<Harness initial={planWithRichJob} />);
    const before = authored().plan.primary.jobs[0];

    fireEvent.click(screen.getByRole("button", { name: /Edit Software Engineer/i }));
    enterNumber(spin(/Monthly salary now/i), "8000");
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    const after = authored().plan.primary.jobs[0];
    expect(after.salary.currentSalaryCents).toBe(dollarsToCents(8000 * 12));
    // Everything else, key for key: put the one edited field back and the two are identical.
    expect({ ...after, salary: { ...after.salary, currentSalaryCents: before.salary.currentSalaryCents } })
      .toEqual(before);
    // Named individually too, so a future `toEqual` that stops comparing deeply still fails here.
    expect(after.ownerId).toBe(PRIMARY_PERSON_ID);
    expect(after.id).toBe(before.id);
    expect(after.payChanges).toEqual(before.payChanges);
    expect(after.incomeOverrides).toEqual(before.incomeOverrides);
    expect(after.salary.startingSalaryCents).toBe(before.salary.startingSalaryCents);
  });

  it("projects the edited job the same way — same owner, same span, new pay", () => {
    render(<Harness initial={planWithRichJob} />);
    const seriesBefore = Projection.fromState(stateOf(authored().plan, authored().ledger), usJurisdiction)
      .run(usJurisdiction).series;
    // Off the JOB's own end — the only thing that says when it stops paying.
    const lastPaidBefore = (PLAN_DEFAULTS.primary.jobs[0]!.endYear! - START_YEAR) * 12 - 1;
    expect(wagesFor(seriesBefore, PRIMARY_PERSON_ID, 0)).toBe(dollarsToCents(5000));

    fireEvent.click(screen.getByRole("button", { name: /Edit Software Engineer/i }));
    enterNumber(spin(/Monthly salary now/i), "8000");
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    const { plan, ledger } = authored();
    const series = Projection.fromState(stateOf(plan, ledger), usJurisdiction).run(usJurisdiction).series;
    // Still the primary person's wages, and nobody else's.
    expect(wagesFor(series, PRIMARY_PERSON_ID, 0)).toBe(dollarsToCents(8000));
    expect(wagesFor(series, "p-1", 0)).toBe(0);
    // The bonus at month 6 and the cut at month 24 still land, on the new baseline.
    expect(wagesFor(series, PRIMARY_PERSON_ID, 6)).toBe(dollarsToCents(8000 + 5000));
    // Two years of CPI on the new anchor ($8,000 → $8,487.20), then the authored $500 cut.
    expect(wagesFor(series, PRIMARY_PERSON_ID, 24)).toBe(dollarsToCents(8487.2 - 500));
    // And the span is untouched: it still stops at the owner's retirement.
    expect(wagesFor(series, PRIMARY_PERSON_ID, lastPaidBefore)).toBeGreaterThan(0);
    expect(wagesFor(series, PRIMARY_PERSON_ID, lastPaidBefore + 1)).toBe(0);
  });
});

describe("JobsPanel — one-month adjustments show on the job", () => {
  /**
   * A bonus used to be COUNTED in the row's subtitle and shown nowhere else on the panel: not on
   * the chart, not in the list, not removable from here. The projection paid it and the graphs
   * below drew it, so the one surface that authors a job's pay was the one surface that denied
   * a part of it existed.
   *
   * It rides the pay series as a ONE-MONTH spike: the month genuinely pays more, and the width
   * is what keeps it from reading as a raise immediately reversed.
   */
  const BONUS = { id: "adjustment-10", month: 12, kind: "addBonus", cents: dollarsToCents(4000) } as const;
  const withBonus: Plan = {
    ...PLAN_DEFAULTS,
    primary: {
      ...PLAN_DEFAULTS.primary,
      jobs: PLAN_DEFAULTS.primary.jobs.map((j) => ({ ...j, incomeOverrides: [BONUS] })),
    },
  };
  /** What the chart marks: `[month, cents]` per one-off, off the hidden data mirror. */
  const oneOffMarks = (): [number, number][] =>
    JSON.parse(screen.getByTestId("pay-chart-one-offs").textContent || "[]");

  it("marks the bonus month on the chart, at what that month actually pays", () => {
    render(<Harness initial={withBonus} />);
    // $5,000 standing pay grown a year at 3% CPI ($5,150), plus the $4,000 bonus.
    expect(oneOffMarks()).toEqual([[12, dollarsToCents(5150 + 4000)]]);
  });

  it("leaves the pay staircase alone — a bonus is not a raise", () => {
    render(<Harness initial={withBonus} />);
    // The seam is the staircase's one authored discontinuity; a bonus must not create another.
    expect(Number(screen.getByTestId("pay-chart-seam").textContent)).toBe(0);
    expect(headline("Job 1")).toBe("$5,000/mo");
  });

  it("lists it in the pay history, in date order among the permanent changes", () => {
    const withBoth: Plan = {
      ...withBonus,
      primary: {
        ...withBonus.primary,
        jobs: withBonus.primary.jobs.map((j) => ({
          ...j,
          payChanges: [{ id: "adjustment-11", month: 24, kind: "setTo", cents: dollarsToCents(7000) }],
        })),
      },
    };
    render(<Harness initial={withBoth} />);
    const rows = timeline("Job 1")
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");
    const bonusAt = rows.findIndex((t) => /Bonus \$4,000/.test(t));
    const raiseAt = rows.findIndex((t) => /Pay set to \$7,000/.test(t));
    expect(bonusAt).toBeGreaterThanOrEqual(0);
    // Month 12 before month 24 — one list in date order, not two lists.
    expect(bonusAt).toBeLessThan(raiseAt);
    // Quoted as what THAT month pays, and said to be one month only.
    expect(rows[bonusAt]).toMatch(/this month only/i);
    expect(rows[bonusAt]).toMatch(/\$9,150 this month/);
  });

  it("removes it from the job, without touching the permanent changes", () => {
    const withBoth: Plan = {
      ...withBonus,
      primary: {
        ...withBonus.primary,
        jobs: withBonus.primary.jobs.map((j) => ({
          ...j,
          payChanges: [{ id: "adjustment-12", month: 24, kind: "setTo", cents: dollarsToCents(7000) }],
        })),
      },
    };
    render(<Harness initial={withBoth} />);
    fireEvent.click(
      // Named by what it is, so stacked siblings sharing a month are separately clickable.
      screen.getByRole("button", { name: /Remove Bonus \$4,000 at age 36 on Job 1/i }),
    );
    expect(authored().plan.primary.jobs[0].incomeOverrides).toBeUndefined();
    expect(authored().plan.primary.jobs[0].payChanges).toHaveLength(1);
    expect(oneOffMarks()).toEqual([]);
  });

  it("stacks two bonuses in one month instead of the second replacing the first", () => {
    const twice: Plan = {
      ...PLAN_DEFAULTS,
      primary: {
        ...PLAN_DEFAULTS.primary,
        jobs: PLAN_DEFAULTS.primary.jobs.map((j) => ({
        ...j,
        incomeOverrides: [
          { id: "a1", month: 12, kind: "addBonus", cents: dollarsToCents(4000) },
          { id: "a2", month: 12, kind: "addBonus", cents: dollarsToCents(1000) },
        ],
        })),
      },
    };
    render(<Harness initial={twice} />);

    // Both listed, each on its own row, and the chart marks the month at the FULL stack:
    // $5,150 grown pay + $4,000 + $1,000.
    const rows = timeline("Job 1")
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");
    expect(rows.filter((t) => /Bonus \$4,000/.test(t))).toHaveLength(1);
    expect(rows.filter((t) => /Bonus \$1,000/.test(t))).toHaveLength(1);
    expect(oneOffMarks()).toEqual([[12, dollarsToCents(5150 + 4000 + 1000)]]);
  });

  it("quotes each stacked row at the running total, not all of them at the same figure", () => {
    const twice: Plan = {
      ...PLAN_DEFAULTS,
      primary: {
        ...PLAN_DEFAULTS.primary,
        jobs: PLAN_DEFAULTS.primary.jobs.map((j) => ({
        ...j,
        incomeOverrides: [
          { id: "a1", month: 12, kind: "addBonus", cents: dollarsToCents(4000) },
          { id: "a2", month: 12, kind: "addBonus", cents: dollarsToCents(1000) },
        ],
        })),
      },
    };
    render(<Harness initial={twice} />);
    const rows = timeline("Job 1")
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");
    // The fold, shown: $9,150 after the first, $10,150 after the second.
    expect(rows.find((t) => /Bonus \$4,000/.test(t))).toMatch(/\$9,150 this month/);
    expect(rows.find((t) => /Bonus \$1,000/.test(t))).toMatch(/\$10,150 this month/);
  });

  it("removes one of a month's stacked adjustments and leaves its sibling standing", () => {
    const twice: Plan = {
      ...PLAN_DEFAULTS,
      primary: {
        ...PLAN_DEFAULTS.primary,
        jobs: PLAN_DEFAULTS.primary.jobs.map((j) => ({
        ...j,
        incomeOverrides: [
          { id: "a1", month: 12, kind: "addBonus", cents: dollarsToCents(4000) },
          { id: "a2", month: 12, kind: "addBonus", cents: dollarsToCents(1000) },
        ],
        })),
      },
    };
    render(<Harness initial={twice} />);
    fireEvent.click(screen.getByRole("button", { name: /Remove Bonus \$4,000 at age 36 on Job 1/i }));

    // By id: the month keeps the other one. Removing by month would have taken both.
    expect(authored().plan.primary.jobs[0].incomeOverrides?.map((o) => o.id)).toEqual(["a2"]);
    expect(oneOffMarks()).toEqual([[12, dollarsToCents(5150 + 1000)]]);
  });

  it("gives two adjustments in one month distinct React identity", () => {
    const twice: Plan = {
      ...PLAN_DEFAULTS,
      primary: {
        ...PLAN_DEFAULTS.primary,
        jobs: PLAN_DEFAULTS.primary.jobs.map((j) => ({
        ...j,
        incomeOverrides: [
          { id: "a1", month: 12, kind: "addBonus", cents: dollarsToCents(4000) },
          { id: "a2", month: 12, kind: "setTo", cents: dollarsToCents(2000) },
        ],
        })),
      },
    };
    render(<Harness initial={twice} />);
    // Two rows and two separately-addressable Remove buttons — the shape a shared key
    // (`jobId:scope`, or the month) collapsed into one.
    expect(screen.getByRole("button", { name: /Remove Bonus \$4,000 at age 36 on Job 1/i })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Remove Pay this month \$2,000 at age 36 on Job 1/i }),
    ).toBeTruthy();
    // A setTo authored after a bonus discards it — the engine's ordering, shown.
    expect(oneOffMarks()).toEqual([[12, dollarsToCents(2000)]]);
  });

  it("stacks a bonus on top of a permanent raise dated the same month", () => {
    const both: Plan = {
      ...PLAN_DEFAULTS,
      primary: {
        ...PLAN_DEFAULTS.primary,
        jobs: PLAN_DEFAULTS.primary.jobs.map((j) => ({
        ...j,
        payChanges: [{ id: "p1", month: 12, kind: "setTo", cents: dollarsToCents(7000) }],
        incomeOverrides: [{ id: "a1", month: 12, kind: "addBonus", cents: dollarsToCents(4000) }],
        })),
      },
    };
    render(<Harness initial={both} />);
    // The raise sets the month's pay and the bonus adds to THAT, not to the old salary.
    expect(oneOffMarks()).toEqual([[12, dollarsToCents(11000)]]);
  });

  /**
   * A raise and a missed paycheck dated the same month. The engine's rule is that the pay
   * change sets the salary state and the override then changes only that month's payment, so
   * the job's own surfaces have to show both facts rather than one cancelling the other.
   */
  const raiseAndMissed: Plan = {
    ...PLAN_DEFAULTS,
    primary: {
      ...PLAN_DEFAULTS.primary,
      jobs: PLAN_DEFAULTS.primary.jobs.map((j) => ({
      ...j,
      payChanges: [{ id: "p1", month: 10, kind: "setTo", cents: dollarsToCents(6000) }],
      incomeOverrides: [{ id: "a1", month: 10, kind: "setTo", cents: 0 }],
      })),
    },
  };

  it("marks the missed month at $0 on the chart, though the raise is in force there", () => {
    render(<Harness initial={raiseAndMissed} />);
    // The chart folds the override over the RAISED salary — and $6,000 set to $0 is $0.
    expect(oneOffMarks()).toEqual([[10, 0]]);
  });

  it("lists the raise and the missed paycheck as two rows, not one", () => {
    render(<Harness initial={raiseAndMissed} />);
    const rows = timeline("Job 1")
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");

    // The raise quotes the salary it establishes; the missed month quotes what it pays.
    expect(rows.find((t) => /Pay set to \$6,000/.test(t))).toMatch(/\$6,000\/mo/);
    expect(rows.find((t) => /Missed paycheck/.test(t))).toMatch(/\$0 this month/);
  });

  it("removes the missed paycheck without touching the raise, and vice versa", () => {
    const { unmount } = render(<Harness initial={raiseAndMissed} />);
    fireEvent.click(
      screen.getByRole("button", { name: /Remove Missed paycheck this month at age 35 on Job 1/i }),
    );
    expect(authored().plan.primary.jobs[0].incomeOverrides).toBeUndefined();
    expect(authored().plan.primary.jobs[0].payChanges?.map((c) => c.id)).toEqual(["p1"]);
    unmount();

    // The other direction: dropping the raise leaves the missed month standing.
    render(<Harness initial={raiseAndMissed} />);
    fireEvent.click(screen.getByRole("button", { name: /Remove pay change at age 35 on Job 1/i }));
    expect(authored().plan.primary.jobs[0].payChanges).toBeUndefined();
    expect(authored().plan.primary.jobs[0].incomeOverrides?.map((o) => o.id)).toEqual(["a1"]);
  });

  it("keeps a month-0 raise deferred while the month-0 miss lands on month 0", () => {
    const atNow: Plan = {
      ...PLAN_DEFAULTS,
      primary: {
        ...PLAN_DEFAULTS.primary,
        jobs: PLAN_DEFAULTS.primary.jobs.map((j) => ({
        ...j,
        payChanges: [{ id: "p1", month: 0, kind: "setTo", cents: dollarsToCents(6000) }],
        incomeOverrides: [{ id: "a1", month: 0, kind: "setTo", cents: 0 }],
        })),
      },
    };
    render(<Harness initial={atNow} />);
    const rows = timeline("Job 1")
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");

    // The raise says it starts next month and quotes the month it starts; the miss is now.
    expect(rows.find((t) => /Pay set to \$6,000/.test(t))).toMatch(/from next month/i);
    expect(rows.find((t) => /Missed paycheck/.test(t))).toMatch(/\$0 this month/);
    expect(oneOffMarks()).toEqual([[0, 0]]);
    // The headline is still the stated current salary — a deferred raise has not moved it.
    expect(headline("Job 1")).toBe("$5,000/mo now");
  });

  it("describes a missed paycheck as one, not as a $0 bonus", () => {
    const missed: Plan = {
      ...PLAN_DEFAULTS,
      primary: {
        ...PLAN_DEFAULTS.primary,
        jobs: PLAN_DEFAULTS.primary.jobs.map((j) => ({
        ...j,
        incomeOverrides: [{ id: "adjustment-13", month: 12, kind: "setTo", cents: 0 }],
        })),
      },
    };
    render(<Harness initial={missed} />);
    expect(timeline("Job 1").getByText(/Missed paycheck this month/i)).toBeTruthy();
    expect(oneOffMarks()).toEqual([[12, 0]]);
  });
});

describe("JobsPanel — permanent pay changes", () => {
  // A pay change lands on `payChanges`, not the starting salary, so the headline stays
  // $5,000/mo while the change moves pay — showing only the headline hides it.
  const withSetToZero = addJobPayChange(PLAN_DEFAULTS, DEFAULT_JOB_ID, { month: 12, kind: "setTo", cents: 0 });

  it("lists a job's permanent pay changes, flagging the headline as CURRENT pay", () => {
    render(<Harness initial={withSetToZero} />);
    expect(headline("Job 1")).toBe("$5,000/mo now");
    // The change itself is listed in full — age 36 = current 35 + month 12.
    expect(timeline("Job 1").getByText(/Pay set to \$0\/mo/)).toBeTruthy();
    expect(timeline("Job 1").getByText("age 36")).toBeTruthy();
  });

  it("does not conflate a permanent pay change with a one-off (single-month) adjustment", () => {
    render(<Harness initial={withSetToZero} />);
    // The old mislabel counted it as a one-off adjustment.
    expect(screen.queryByText(/one-off/i)).toBeNull();
  });

  it("removes a pay change, restoring the plain current-pay headline", () => {
    render(<Harness initial={withSetToZero} />);
    fireEvent.click(screen.getByRole("button", { name: /Remove pay change at age 36 on Job 1/i }));
    expect(screen.queryByText(/Pay set to \$0\/mo/)).toBeNull();
    // No pay changes left, so the headline drops the "now" qualifier.
    expect(headline("Job 1")).toBe("$5,000/mo");
  });

  it("describes a delta cut with the right verb and sign", () => {
    const cut = addJobPayChange(PLAN_DEFAULTS, DEFAULT_JOB_ID, { month: 24, kind: "changeBy", cents: -dollarsToCents(500) });
    render(<Harness initial={cut} />);
    expect(timeline("Job 1").getByText(/Pay cut \$500\/mo/)).toBeTruthy();
    expect(timeline("Job 1").getByText("age 37")).toBeTruthy();
  });
});

describe("JobsPanel — authoring a raise", () => {
  /** Open the disclosed form on a job, by the label its row carries. */
  function openPayChange(label: string) {
    fireEvent.click(screen.getByRole("button", { name: `Change pay on ${label}` }));
  }

  const applyPayChange = (kind: "setTo" | "changeBy", age: number, dollars: number) => {
    fireEvent.change(screen.getByRole("combobox", { name: /Pay change kind/i }), {
      target: { value: kind },
    });
    enterNumber(spin(/From age/i), age);
    enterNumber(spin(/Amount/i), dollars);
    fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
  };

  it("dates a raise by the owner's age and lists it back", () => {
    render(<Harness />);
    openPayChange("Job 1");
    applyPayChange("setTo", 45, 8000);

    // Authored at age 45 with the owner 35 now → month 120, read back as age 45.
    expect(authored().plan.primary.jobs[0].payChanges).toEqual([
      { id: expect.any(String), month: 120, kind: "setTo", cents: dollarsToCents(8000) },
    ]);
    expect(timeline("Job 1").getByText(/Pay set to \$8,000\/mo/)).toBeTruthy();
    expect(timeline("Job 1").getByText("age 45")).toBeTruthy();
    // The headline is CURRENT pay — the month-0 anchor — qualified because a change exists.
    expect(headline("Job 1")).toBe("$5,000/mo now");
  });

  it("authors a cut as a negative delta", () => {
    render(<Harness />);
    openPayChange("Job 1");
    applyPayChange("changeBy", 40, -500);
    expect(authored().plan.primary.jobs[0].payChanges).toEqual([
      { id: expect.any(String), month: 60, kind: "changeBy", cents: -dollarsToCents(500) },
    ]);
    expect(timeline("Job 1").getByText(/Pay cut \$500\/mo/)).toBeTruthy();
  });

  it("writes a partner's raise to the event carrying their job, not the plan", () => {
    render(<Harness events={[partnerJoining([partnerJob(4_000)])]} />);
    openPayChange("Sam · Job 1");
    applyPayChange("setTo", 50, 6000);

    // The partner is 40 now, so age 50 is month 120 — read against THEIR birth year.
    expect(partnerJobs()[0].payChanges).toEqual([
      { id: expect.any(String), month: 120, kind: "setTo", cents: dollarsToCents(6000) },
    ]);
    // Nothing landed on the plan plane.
    expect(authored().plan.primary.jobs[0].payChanges).toBeUndefined();
  });

  it("dates a change BEFORE now as a negative month — that is how a pay history is authored", () => {
    // The floor is the job's start age (18 here), not "now": an age already lived becomes a
    // negative month, which is what routes the change to the historical reconstruction.
    render(<Harness />);
    openPayChange("Job 1");
    applyPayChange("setTo", 20, 7000);
    expect(authored().plan.primary.jobs[0].payChanges).toEqual([
      { id: expect.any(String), month: (20 - 35) * 12, kind: "setTo", cents: dollarsToCents(7000) },
    ]);
  });

  it("clamps a change dated before the job existed — there is no baseline to apply it to", () => {
    render(<Harness />); // the default job starts at 18
    openPayChange("Job 1");
    applyPayChange("setTo", 12, 7000);
    expect(authored().plan.primary.jobs[0].payChanges).toEqual([
      { id: expect.any(String), month: (18 - 35) * 12, kind: "setTo", cents: dollarsToCents(7000) },
    ]);
  });

  it("closes without writing when cancelled", () => {
    render(<Harness />);
    openPayChange("Job 1");
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(screen.queryByRole("group", { name: /Pay change/i })).toBeNull();
    expect(authored().plan.primary.jobs[0].payChanges).toBeUndefined();
  });

  it("leaves the plan untouched when the facade refuses the write", () => {
    render(<Harness rejectRevisions />);
    openPayChange("Job 1");
    applyPayChange("setTo", 45, 8000);
    expect(authored().plan.primary.jobs[0].payChanges).toBeUndefined();
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

  it("does not pool two earners into one limit", () => {
    // $20k + $20k tops a single $24,500 limit, but neither person is over their own.
    render(
      <Harness
        initial={setJobDeferralFraction(PLAN_DEFAULTS, DEFAULT_JOB_ID, 0.3334)}
        events={[partnerDeferring(5000, 33.34)]}
      />,
    );
    expect(screen.queryByText(/paid as taxable income/i)).toBeNull();
  });
});

describe("JobsPanel — authoring a job's pay history", () => {
  // The scenario the front end could not reach at all: a start salary that differs from
  // current pay, plus a raise dated BEFORE now. The engine has always supported both — a
  // negative `JobPayChange.month` routes to the historical reconstruction — and this panel is
  // the surface that authors them.
  const BIRTH_YEAR = PLAN_DEFAULTS.primary.birthYear; // Alex, 35 now, working since 18

  const openPayChange = (label: string) =>
    fireEvent.click(screen.getByRole("button", { name: `Change pay on ${label}` }));

  it("states the two salary anchors separately, and neither rewrites the other", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    enterNumber(spin(/Monthly salary when this job started/i), "3000");
    enterNumber(spin(/Monthly salary now/i), "6667");
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    const { salary } = authored().plan.primary.jobs[0];
    expect(salary.startingSalaryCents).toBe(dollarsToCents(3000) * 12);
    expect(salary.currentSalaryCents).toBe(dollarsToCents(6667) * 12);
    // The headline is the month-0 anchor, which is what the projection starts from.
    expect(headline("Job 1")).toBe("$6,667/mo");
  });

  it("offers only one salary field on a job with no past — there is one fact to state", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Add a job/i })); // starts at 35, today
    expect(screen.queryByRole("spinbutton", { name: /Monthly salary when this job started/i })).toBeNull();
    enterNumber(spin(/Monthly salary/i), "4000");
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));
    // One number in, both anchors out: "it pays X" means a flat history.
    const added = authored().plan.primary.jobs[1].salary;
    expect(added.startingSalaryCents).toBe(dollarsToCents(4000) * 12);
    expect(added.currentSalaryCents).toBe(dollarsToCents(4000) * 12);
  });

  it("lists a pre-'now' raise in the same age-ordered list as a future one", () => {
    // One list through the seam, not two surfaces: finding a raise must not require first
    // answering "before or after today?".
    render(<Harness />);
    openPayChange("Job 1");
    fireEvent.change(screen.getByRole("combobox", { name: /Pay change kind/i }), {
      target: { value: "setTo" },
    });
    enterNumber(spin(/From age/i), "30");
    enterNumber(spin(/Amount/i), "6250");
    fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));

    expect(authored().plan.primary.jobs[0].payChanges).toEqual([
      { id: expect.any(String), month: (30 - 35) * 12, kind: "setTo", cents: dollarsToCents(6250) },
    ]);
    expect(timeline("Job 1").getByText("age 30")).toBeTruthy();
    expect(timeline("Job 1").getByText(/Pay set to \$6,250\/mo/)).toBeTruthy();
    // Left of the seam, which is where the engine reads it from: a negative month is the
    // historical reconstruction's, and it never touches the forward series.
    expect(timeline("Job 1").getByText(/^now ·/)).toBeTruthy();
    // That the negative month then feeds the covered-earnings record is the engine's contract,
    // pinned in `job.test.ts` — what this panel owes is the negative month itself.
  });

  it("redraws every job in today’s money, and defaults to the paycheck", () => {
    // The paycheck of each month by default, because that is what every field on this panel
    // collects — a past salary is authored in the money of its own year, and a chart
    // disagreeing with the number just typed into it would be the worse default.
    render(<Harness />);
    const toggle = screen.getByRole("checkbox", { name: /today’s money/i });
    const startRow = () => timeline("Job 1").getByText(/Started this job/).closest("li")!;
    const nowRow = () => timeline("Job 1").getByText(/^now ·/).closest("li")!;

    // The default plan states $5,000/mo at 18 and $5,000/mo now, and nothing is assumed in
    // between — so as PAYCHECKS the history is flat at what was authored.
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect(startRow().textContent).toContain("$5,000/mo");
    expect(nowRow().textContent).toContain("$5,000/mo");

    fireEvent.click(toggle);
    // In today's money that same flat paycheck was worth MORE the further back it was, so the
    // start row rises. Month 0 is unmoved either way: today's money IS the paycheck today, so
    // the toggle can never disturb the anchor the projection starts from.
    expect(startRow().textContent).not.toContain("$5,000/mo");
    expect(nowRow().textContent).toContain("$5,000/mo");
  });

  it("keeps a raise dated at today's age, and says it starts next month", () => {
    // The owner's own current age is month 0, which the authored current salary owns. The
    // change is neither dropped nor allowed to displace that figure — it takes force at month
    // 1, and the form says so before it is applied rather than after.
    render(<Harness />);
    openPayChange("Job 1");
    enterNumber(spin(/From age/i), "35");
    enterNumber(spin(/Amount/i), "6000");
    expect(screen.getByText(/starts next month/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));

    expect(authored().plan.primary.jobs[0].payChanges).toEqual([
      { id: expect.any(String), month: 0, kind: "setTo", cents: dollarsToCents(6000) },
    ]);
    // Today's pay is untouched; the row quotes the pay from the month it actually begins.
    expect(headline("Job 1")).toBe("$5,000/mo now");
    expect(timeline("Job 1").getByText(/Pay set to \$6,000\/mo — from next month/)).toBeTruthy();
  });

  it("states the month-0 step where it happens, and drops it when the two anchors agree", () => {
    const withHistory: Plan = {
      ...PLAN_DEFAULTS,
      primary: {
        ...PLAN_DEFAULTS.primary,
        jobs: PLAN_DEFAULTS.primary.jobs.map((j) => ({
        ...j,
        salary: { ...j.salary, currentSalaryCents: dollarsToCents(6667) * 12 },
        })),
      },
    };
    render(<Harness initial={withHistory} />);
    // Neutral wording, and no reconciliation offered: the step is an authored fact, and the
    // engine deliberately does not close it.
    // The history is real-flat $5,000/mo of purchasing power, so by now it runs to $5,000 as
    // a paycheck — against the $6,667 just stated.
    expect(screen.getByTestId("seam-note").textContent).toContain(
      "Your history runs to $5,000/mo by now",
    );
    expect(screen.getByTestId("seam-note").textContent).toContain("Today’s pay wins from here on");
    // The chart says it too, as a shape. Recharts draws nothing in jsdom, so the step is
    // asserted through the data mirror the chart renders beside it.
    expect(screen.getByTestId("pay-chart-seam").textContent).toBe(
      String(dollarsToCents(6667) - dollarsToCents(5000)),
    );

    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    enterNumber(spin(/Monthly salary now/i), "5000");
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(screen.queryByTestId("seam-note")).toBeNull();
    // Anchors agreed: no step to draw, and no annotation left on the chart either.
    expect(screen.getByTestId("pay-chart-seam").textContent).toBe("0");
  });

  it("asks nothing about 'now' for a job that ended before it", () => {
    // A wholly-past job has no month-0 pay, and the engine never reads its anchor. Asking for
    // today's pay on an employment that is over is nonsense; the app fills the value in.
    const past: Plan = {
      ...PLAN_DEFAULTS,
      primary: {
        ...PLAN_DEFAULTS.primary,
        jobs: [
          {
            ...PLAN_DEFAULTS.primary.jobs[0],
            startYear: BIRTH_YEAR + 22,
            endYear: BIRTH_YEAR + 26,
            salary: {
              startingSalaryCents: dollarsToCents(1800) * 12,
              currentSalaryCents: dollarsToCents(1800) * 12,
              realGrowthPct: 0,
            },
            payChanges: [{ id: "adjustment-23", month: (24 - 35) * 12, kind: "setTo", cents: dollarsToCents(2100) }],
          },
        ],
      },
    };
    render(<Harness initial={past} />);
    // The headline says what it is, rather than quoting a current pay the engine never reads.
    expect(within(screen.getByLabelText("Job 1")).getByText("ended at age 26")).toBeTruthy();
    // No seam row on the timeline, and no seam note.
    expect(timeline("Job 1").queryByText(/^now ·/)).toBeNull();
    expect(screen.queryByTestId("seam-note")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    expect(screen.queryByRole("spinbutton", { name: /Monthly salary now/i })).toBeNull();
    expect(screen.getByText(/This job ended at age 26/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    // Pinned to what it last paid, not zeroed: pushing the end age past "now" later must not
    // silently pay nothing.
    expect(authored().plan.primary.jobs[0].salary.currentSalaryCents).toBe(dollarsToCents(2100) * 12);
  });

  it("bounds a pay change to the job's own span, clamping a stale default on the way in", () => {
    const past: Plan = {
      ...PLAN_DEFAULTS,
      primary: {
        ...PLAN_DEFAULTS.primary,
        jobs: [{ ...PLAN_DEFAULTS.primary.jobs[0], startYear: BIRTH_YEAR + 22, endYear: BIRTH_YEAR + 26 }],
      },
    };
    render(<Harness initial={past} />);
    openPayChange("Job 1");
    // The form opens on the seam (35) — outside this job — so applying it untouched must land
    // inside the span rather than submit the default it opened on.
    enterNumber(spin(/Amount/i), "2100");
    fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
    expect(authored().plan.primary.jobs[0].payChanges).toEqual([
      { id: expect.any(String), month: (25 - 35) * 12, kind: "setTo", cents: dollarsToCents(2100) },
    ]);
  });

  it("drops pay changes a later start age strands, and says which went", () => {
    const withRaise = addJobPayChange(PLAN_DEFAULTS, DEFAULT_JOB_ID, {
      month: (30 - 35) * 12,
      kind: "setTo",
      cents: dollarsToCents(6250),
    });
    render(<Harness initial={withRaise} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    enterNumber(spin(/Start age/i), "33");
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    expect(authored().plan.primary.jobs[0].payChanges).toBeUndefined();
    // Named, not merely counted — the user can put back whichever one still applies.
    expect(screen.getByText(/One pay change now fell before this job starts.*age 30/)).toBeTruthy();
  });

  it("says nothing when an edit strands nothing", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    enterNumber(spin(/Start age/i), "20");
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(screen.queryByText(/fell before this job starts/)).toBeNull();
  });
});

/**
 * The continuation job as an authoring control. What selecting one MEANS is pinned in the engine
 * (`retirementSolver.test.ts`); these pin only that the Jobs panel asks the question once per
 * earner, offers the right options, writes the answer through, and — the property the whole
 * design turns on — leaves an answer alone when the job list changes underneath it.
 */
describe("JobsPanel — 'If your plan required working longer than expected…'", () => {
  const QUESTION = /If your plan required working longer than expected, which job would you continue\?/i;
  const picker = () => screen.getByRole("combobox", { name: QUESTION }) as HTMLSelectElement;
  const optionLabels = () =>
    Array.from(picker().options).map((o) => o.textContent);
  const choose = (value: string) => fireEvent.change(picker(), { target: { value } });

  /** A second job for the primary, authored to start after the default one ends. */
  const futureJob = (id: string): Job => ({
    ...PLAN_DEFAULTS.primary.jobs[0]!,
    id,
    name: "Consulting",
    startYear: PLAN_DEFAULTS.primary.jobs[0]!.endYear,
    endYear: PLAN_DEFAULTS.primary.jobs[0]!.endYear + 3,
  });

  it("offers None plus every job, and preselects the one being worked now", () => {
    // The default plan's single job is running today, so the initialization rule picks it —
    // and the control shows that rather than a blank "None", because it is the assumption the
    // household's retirement age is already being computed under.
    render(<Harness />);
    // Options read as the ACTION each one takes, and the jobs come first: "do not assume" is a
    // decision of the same kind as the others, not an empty value to be got past.
    expect(optionLabels()).toEqual(["Keep my Job 1 job longer", "Do not assume I would work longer"]);
    expect(picker().value).toBe(DEFAULT_JOB_ID);
    // Nothing has been written: showing a resolved default is not making a choice.
    expect(authored().plan.primary.continuationJobId).toBeUndefined();
  });

  it("offers a job that is already finished", () => {
    // Whether that work could have carried on is knowledge the plan does not have, so a
    // completed job is offered. The initialization rule still will not pick one — here it falls
    // to None, since nothing is running and nothing is due to start.
    const past: Job = {
      ...PLAN_DEFAULTS.primary.jobs[0]!,
      name: "Bar work",
      startYear: START_YEAR - 20,
      endYear: START_YEAR - 10,
    };
    render(<Harness initial={{ ...PLAN_DEFAULTS, primary: { ...PLAN_DEFAULTS.primary, jobs: [past] } }} />);
    expect(optionLabels()).toEqual([
      "Keep my Bar work job longer",
      "Do not assume I would work longer",
    ]);
    expect(picker().value).toBe("");
  });

  it("says what continuing a job will do, including that jobs may overlap", () => {
    // The overlap is the one consequence a reader would not predict, so the control says it up
    // front rather than leaving it to be discovered in the charts.
    render(<Harness />);
    expect(
      screen.getByText(
        /Finley uses this choice when estimating the earliest age you could stop all work\. Other jobs keep their planned dates and may overlap\./i,
      ),
    ).toBeDefined();
    // A running job is not a counterfactual, so the completed-job note stays away.
    expect(screen.queryByText(/if it had continued without ending/i)).toBeNull();
  });

  it("explains a completed selection as a counterfactual, never as taking the job up again", () => {
    // Selecting a finished job models it as never having ended. Copy about restarting or going
    // back would describe a different scenario from the one the engine actually runs.
    const past: Job = {
      ...PLAN_DEFAULTS.primary.jobs[0]!,
      name: "Bar work",
      startYear: START_YEAR - 20,
      endYear: START_YEAR - 10,
    };
    render(<Harness initial={{ ...PLAN_DEFAULTS, primary: { ...PLAN_DEFAULTS.primary, jobs: [past] } }} />);
    choose(past.id);

    expect(
      screen.getByText(
        /Selecting this job models what would have happened if it had continued without ending\./i,
      ),
    ).toBeDefined();
    expect(screen.queryByText(/restart|resume|go back|return to/i)).toBeNull();
  });

  it("writes a choice through, including None", () => {
    render(<Harness initial={{ ...PLAN_DEFAULTS, primary: { ...PLAN_DEFAULTS.primary, jobs: [PLAN_DEFAULTS.primary.jobs[0]!, futureJob("job-2")] } }} />);

    choose("job-2");
    expect(authored().plan.primary.continuationJobId).toBe("job-2");

    choose("");
    // `null`, not absent: "I answered none" must not decay back into "never asked", which would
    // hand the initialization rule the question again.
    expect(authored().plan.primary.continuationJobId).toBeNull();
  });

  it("does NOT change the selection when a job is added", () => {
    // The stability guarantee. A new job — including one the initialization rule would have
    // preferred — cannot silently move which employment the retirement answer leans on.
    render(<Harness initial={{ ...PLAN_DEFAULTS, primary: { ...PLAN_DEFAULTS.primary, jobs: [PLAN_DEFAULTS.primary.jobs[0]!] } }} />);
    choose("");
    expect(authored().plan.primary.continuationJobId).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Add a job/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));

    expect(authored().plan.primary.jobs).toHaveLength(2);
    expect(authored().plan.primary.continuationJobId).toBeNull();
    expect(picker().value).toBe("");
  });

  it("clears the selection when the job it named is deleted", () => {
    // The one moment a selection changes without the user choosing. It falls to None rather than
    // re-running the initialization rule, so a delete cannot quietly nominate a different job.
    render(<Harness initial={{ ...PLAN_DEFAULTS, primary: { ...PLAN_DEFAULTS.primary, jobs: [PLAN_DEFAULTS.primary.jobs[0]!, futureJob("job-2")] } }} />);
    choose("job-2");

    fireEvent.click(screen.getByRole("button", { name: /Delete Consulting/i }));

    expect(authored().plan.primary.continuationJobId).toBeNull();
    expect(picker().value).toBe("");
  });

  it("asks once per earner, naming whose jobs each question is about", () => {
    // Per person, so a two-earner household answers twice — and the labels have to say which is
    // which, since the two pickers are otherwise identical.
    render(<Harness initial={PLAN_DEFAULTS} events={[partnerJoining([partnerJob(4000)])]} />);
    const questions = screen.getAllByRole("combobox", {
      name: /required working longer than expected, which job would/i,
    });
    expect(questions).toHaveLength(2);
    // Whose it is comes from the OWNER, not from "are there several": the primary keeps the
    // second person even in a two-earner household, and only a partner is named.
    expect(
      screen.getByRole("combobox", {
        name: /If Sam\u2019s plan required working longer than expected, which job would Sam continue\?/i,
      }),
    ).toBeDefined();
    expect(screen.getByRole("combobox", { name: QUESTION })).toBeDefined();
  });

  it("writes a partner's answer to their RelationshipEvent, not to the plan", () => {
    // The selection is a fact about a PERSON, so it lands wherever that person's record lives —
    // the plan for the primary, the event they joined on for a partner. One facade method
    // settles that from the id, which is why this panel routes neither.
    render(<Harness initial={PLAN_DEFAULTS} events={[partnerJoining([partnerJob(4000)])]} />);
    const sam = screen.getByRole("combobox", { name: /which job would Sam continue\?/i });

    fireEvent.change(sam, { target: { value: "" } });

    const partner = authored().ledger.events.find((e) => e.type === "RelationshipEvent");
    expect((partner as { person: { continuationJobId?: string | null } }).person.continuationJobId).toBeNull();
    // The primary's own answer is untouched: two members, two independent choices.
    expect(authored().plan.primary.continuationJobId).toBeUndefined();
  });
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
 * needs no rule of its own.
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

  it("hatches the months before the owner joined, and only those", () => {
    // Sam joins at month 60 holding a job already five years old. The first five years are
    // employment this household never collected, and nothing about the job's end is unusual.
    render(<Harness events={[partnerJoining([samsJob()], 60)]} />);

    expect(samsUncounted()).toEqual([[0, 60]]);
    expect(uncountedByCard()[0]).toEqual([]); // Alex's own job, counted throughout
    expect(
      screen.getByText(/not household income because Sam was not yet part of the household/),
    ).toBeTruthy();
  });

  it("hatches the months after the owner left, and only those", () => {
    render(<Harness events={[partnerJoining([samsJob()]), separatingAt(120)]} />);

    expect(samsUncounted()).toEqual([[120, 300]]);
    expect(
      screen.getByText(/not household income because Sam was no longer part of the household/),
    ).toBeTruthy();
    // The job itself is untouched — this is a reading of the plan, never an edit to it.
    expect(partnerJobs()[0]!.endYear).toBe(START_YEAR - 40 + 65);
  });

  it("hatches BOTH ends for a job that outlasts a join and a separation", () => {
    // The case a single trailing suffix could not express: joined at 60, gone at 180, holding
    // the job from 0 to 300. Ten of those twenty-five years are this household's; the panel
    // used to keep the first five on the books silently.
    render(<Harness events={[partnerJoining([samsJob()], 60), separatingAt(180)]} />);

    expect(samsUncounted()).toEqual([
      [0, 60],
      [180, 300],
    ]);
    // Two hatches, two sentences — one per end, neither standing for the other.
    expect(screen.getByText(/was not yet part of the household/)).toBeTruthy();
    expect(screen.getByText(/was no longer part of the household/)).toBeTruthy();
  });

  it("hatches the whole span of a job the household is never paid for", () => {
    // Sam leaves at month 12 and the job does not start until month 60. Every month of it is
    // employment, and none of it is ever this household's.
    render(
      <Harness
        events={[
          partnerJoining([partnerJob(5000, undefined, { startYear: START_YEAR + 5 })]),
          separatingAt(12),
        ]}
      />,
    );

    expect(samsUncounted()).toEqual([[60, 300]]);
    // With no paid months at all there is nothing for the gap to sit before or after, so the
    // sentence claims neither — it says only what is true of every month of the job.
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
