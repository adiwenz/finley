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
  Projection,
  dollarsToCents,
  type Job,
  type Ledger,
  type NewLifeEvent,
  type Plan,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import type { Transact } from "../../hooks/useProjection";
import { useTestProjection } from "../../testing/projectionHarness";
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

  /**
   * A raise and a missed paycheck dated the same month. The engine's rule is that the pay
   * change sets the salary state and the override then changes only that month's payment, so
   * the job's own surfaces have to show both facts rather than one cancelling the other.
   */
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

  it("removes a pay change, restoring the plain current-pay headline", () => {
    render(<Harness initial={withSetToZero} />);
    fireEvent.click(screen.getByRole("button", { name: /Remove pay change at age 36 on Job 1/i }));
    expect(screen.queryByText(/Pay set to \$0\/mo/)).toBeNull();
    // No pay changes left, so the headline drops the "now" qualifier.
    expect(headline("Job 1")).toBe("$5,000/mo");
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

  it("authors a cut as a negative delta", () => {
    render(<Harness />);
    openPayChange("Job 1");
    applyPayChange("changeBy", 40, -500);
    expect(authored().plan.primary.jobs[0].payChanges).toEqual([
      { id: expect.any(String), month: 60, kind: "changeBy", cents: -dollarsToCents(500) },
    ]);
    expect(timeline("Job 1").getByText(/Pay cut \$500\/mo/)).toBeTruthy();
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
  it("discloses that a deferral over the annual limit is paid as taxable income", () => {
    // $5,000/mo = $60k/yr; a 50% deferral is $30k, above the 2026 $24,500 elective limit.
    render(<Harness initial={setJobDeferralFraction(PLAN_DEFAULTS, DEFAULT_JOB_ID, 0.5)} />);
    expect(screen.getByText(/paid as taxable income/i)).toBeTruthy();
    // Phrased as the user's own on a single-earner plan — no name.
    expect(screen.getByText(/Across your jobs/i)).toBeTruthy();
    expect(within(screen.getByLabelText("Job 1")).getByText(/50% to 401\(k\)/i)).toBeTruthy();
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

  it("writes a choice through, including None", () => {
    render(<Harness initial={{ ...PLAN_DEFAULTS, primary: { ...PLAN_DEFAULTS.primary, jobs: [PLAN_DEFAULTS.primary.jobs[0]!, futureJob("job-2")] } }} />);

    choose("job-2");
    expect(authored().plan.primary.continuationJobId).toBe("job-2");

    choose("");
    // `null`, not absent: "I answered none" must not decay back into "never asked", which would
    // hand the initialization rule the question again.
    expect(authored().plan.primary.continuationJobId).toBeNull();
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
