/**
 * @vitest-environment jsdom
 *
 * Jobs panel. Pins that a person can hold any number of jobs (none privileged, several
 * possibly open-ended), that add/edit/delete are value-plane edits to `plan.jobs`, and that
 * the 401(k) elective-limit nudge fires here across all jobs.
 */
import { describe, it, expect, afterEach } from "vitest";
import { useMemo } from "react";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import {
  PRIMARY_PERSON_ID,
  RETIREMENT_ID,
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
const DEFAULT_JOB_ID = PLAN_DEFAULTS.jobs[0]!.id;

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
}: {
  initial?: Plan;
  events?: readonly NewLifeEvent[];
  /** Stands in for a conflict: the transaction is refused, as the facade would refuse it. */
  rejectRevisions?: boolean;
}) {
  const { state, transact } = useTestProjection(initial, {
    events: events.map((e, i) => ({ ...e, sequenceNumber: i })),
    nextSequenceNumber: events.length,
  });
  const budget = state.scenario.plan;
  const ledger = state.scenario.ledger;
  const projection = useMemo(() => Projection.fromState(state, usJurisdiction), [state]);
  const household = useMemo(() => projection.run(usJurisdiction).household, [projection]);

  return (
    <>
      <JobsPanel
        budget={budget}
        transact={rejectRevisions ? refuseEveryWrite : transact}
        household={household}
        ledger={ledger}
        projection={projection}
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

const partnerJoining = (jobs: readonly Job[]): NewLifeEvent => ({
  id: "r1",
  type: "RelationshipEvent",
  month: 0,
  person: {
    id: "p-1",
    name: "Sam",
    birthYear: START_YEAR - 40,
    retirementTargetAge: 65,
    benefitClaimingAge: 67,
    jobs,
  },
});

/** Open-ended, started at the partner's age 40 ("now"). */
const partnerJob = (monthlyDollars: number, name?: string): Job => ({
  id: "p-1-job-1",
  ...(name ? { name } : {}),
  ownerId: "p-1",
  startYear: START_YEAR,
  endYear: null,
  salary: { startingSalaryCents: dollarsToCents(monthlyDollars * 12), currentSalaryCents: dollarsToCents(monthlyDollars * 12), realGrowthPct: 0 },
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
  it("lists the default job with its salary and open-ended span", () => {
    render(<Harness />);
    expect(headline("Job 1")).toBe("$5,000/mo");
    expect(within(screen.getByLabelText("Job 1")).getByText(/open-ended \(to retirement\)/i)).toBeTruthy();
  });
});

describe("JobsPanel — add / edit / delete", () => {
  it("adds a second job — a person may hold several, none privileged", () => {
    render(<Harness />);
    expect(jobCount()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /Add a job/i }));
    fireEvent.change(spin(/Monthly salary/i), { target: { value: "2000" } });
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));
    expect(jobCount()).toBe(2);
    expect(headline("Job 2")).toBe("$2,000/mo");
  });

  it("edits a job's salary in place", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    fireEvent.change(spin(/Monthly salary now/i), { target: { value: "8000" } });
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
    fireEvent.change(spin(/401\(k\) contribution/i), { target: { value: "6" } });
    fireEvent.change(spin(/Employer match/i), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    // Deposited on top of the deferral in the engine — here we pin only that the authored
    // fraction reaches the plan and reads out on the row beside the contribution.
    expect(authored().plan.jobs[0]?.deferral?.employerMatchFraction).toBe(0.5);
    expect(within(screen.getByLabelText("Job 1")).getByText(/6% to 401\(k\) · 50% match/i)).toBeTruthy();
  });

  it("reads a match back into the edit form so it round-trips", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    fireEvent.change(spin(/401\(k\) contribution/i), { target: { value: "6" } });
    fireEvent.change(spin(/Employer match/i), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    expect(Number(spin(/Employer match/i).value)).toBe(50);
  });

  it("shows no match on the row when the deferral has none", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    fireEvent.change(spin(/401\(k\) contribution/i), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    const row = screen.getByLabelText("Job 1");
    expect(within(row).getByText(/6% to 401\(k\)/i)).toBeTruthy();
    expect(within(row).queryByText(/match/i)).toBeNull();
  });

  it("turns an open-ended job into a fixed-term one via the end-age control", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    fireEvent.click(screen.getByLabelText(/Open-ended/i));
    fireEvent.change(spin(/End age/i), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(within(screen.getByLabelText("Job 1")).getByText(/age 18–50/)).toBeTruthy();
  });

  it("remembers the entered end age across an open-ended toggle instead of resetting it", () => {
    // Open-ended keeps the last finite value, so toggling the box on then off restores the
    // user's number rather than the 65 default.
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    fireEvent.click(screen.getByLabelText(/Open-ended/i)); // reveal the end-age field
    fireEvent.change(spin(/End age/i), { target: { value: "52" } });

    fireEvent.click(screen.getByLabelText(/Open-ended/i)); // back to open-ended
    expect(screen.queryByRole("spinbutton", { name: /End age/i })).toBeNull(); // field hidden

    fireEvent.click(screen.getByLabelText(/Open-ended/i)); // fixed-term again
    expect(Number(spin(/End age/i).value)).toBe(52); // the user's 52, not the default

    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(within(screen.getByLabelText("Job 1")).getByText(/age 18–52/)).toBeTruthy();
  });

  it("deletes a job", () => {
    render(<Harness />);
    expect(jobCount()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /Delete Job 1/i }));
    expect(jobCount()).toBe(0);
    expect(screen.getByText(/No jobs yet/i)).toBeTruthy();
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
    expect(within(partnerRow).getByText(/from age 40/)).toBeTruthy();
  });

  it("edits a partner's job — the revision is written back to their RelationshipEvent", () => {
    render(<Harness events={withPartner()} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Sam · Job 1/i }));
    fireEvent.change(spin(/Monthly salary/i), { target: { value: "3500" } });
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
    fireEvent.change(spin(/Monthly salary now/i), { target: { value: "2500" } });
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));

    expect(partnerJobs()).toHaveLength(1);
    expect(partnerJobs()[0].ownerId).toBe("p-1");
    expect(partnerMonthlyDollars()).toBe(2500);
    expect(jobCount()).toBe(1); // added to the partner, NOT to the primary person
    expect(headline("Sam · Job 1")).toBe("$2,500/mo");
  });

  it("reassigns a job from one member to the other, ages following the new owner", () => {
    render(<Harness events={withPartner([])} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Alex · Job 1/i }));
    fireEvent.change(screen.getByLabelText("Whose job"), { target: { value: "p-1" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    expect(jobCount()).toBe(0);
    expect(partnerJobs()).toHaveLength(1);
    expect(partnerMonthlyDollars()).toBe(5000);
    // The start age is unchanged as a number (18), but now it is Sam's 18.
    expect(within(screen.getByLabelText("Sam · Job 1")).getByText(/from age 18/)).toBeTruthy();
    expect(partnerJobs()[0].startYear).toBe(START_YEAR - 40 + 18);
  });

  it("reassigns a partner's job back to the primary person, ages following the new owner", () => {
    // The reverse direction: off the RelationshipEvent and onto the plan. The facade owns both
    // halves (`reassignJob`), so the panel asks for a move and never sequences one.
    render(<Harness events={withPartner([partnerJob(2500, "Nursing")])} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Sam · Nursing/i }));
    fireEvent.change(screen.getByLabelText("Whose job"), { target: { value: PRIMARY_PERSON_ID } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    expect(partnerJobs()).toEqual([]);
    const { plan } = authored();
    // The same job — its id survived the crossing, so its income band did too.
    expect(plan.jobs.map((j) => j.id)).toEqual([DEFAULT_JOB_ID, "p-1-job-1"]);
    const moved = plan.jobs.find((j) => j.id === "p-1-job-1")!;
    expect(moved.ownerId).toBe(PRIMARY_PERSON_ID);
    expect(moved.salary.startingSalaryCents).toBe(dollarsToCents(2500 * 12));
    // Sam's age-40 start, re-read against Alex's clock: the same age, a different year.
    expect(moved.startYear).toBe(START_YEAR - PLAN_DEFAULTS.currentAge + 40);
    // Sam is still in the household, so titles stay owner-qualified — under Alex now.
    expect(screen.getByLabelText("Alex · Nursing")).toBeTruthy();
  });

  it("mints a partner's new job off the shared counter, not a per-owner scheme", () => {
    render(<Harness events={withPartner([])} />);
    fireEvent.click(screen.getByRole("button", { name: /Add a job/i }));
    fireEvent.change(screen.getByLabelText("Whose job"), { target: { value: "p-1" } });
    fireEvent.change(spin(/Monthly salary now/i), { target: { value: "2500" } });
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));

    const { plan } = authored();
    const minted = partnerJobs()[0].id;
    // One namespace with the plan's jobs, and clear of every id already in the household.
    expect(minted).toMatch(/^job-\d+$/);
    expect(plan.jobs.map((j) => j.id)).not.toContain(minted);
  });

  it("carries the whole job across a reassignment — id, overrides, pay changes, match", () => {
    // One edit to the existing job, so all of it rides along; minting from the form draft
    // instead loses id, bonus, raise and match.
    const rich = addJobPayChange(
      setJobDeferralFraction(PLAN_DEFAULTS, DEFAULT_JOB_ID, 0.1),
      DEFAULT_JOB_ID,
      { month: 24, kind: "changeBy", cents: -dollarsToCents(500) },
    );
    const withMatch: Plan = {
      ...rich,
      jobs: rich.jobs.map((j) => ({
        ...j,
        deferral: { ...j.deferral!, employerMatchFraction: 0.5 },
        incomeOverrides: [{ month: 6, kind: "addBonus", cents: dollarsToCents(5000) }],
      })),
    };

    render(<Harness initial={withMatch} events={withPartner([])} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Alex · Job 1/i }));
    fireEvent.change(screen.getByLabelText("Whose job"), { target: { value: "p-1" } });
    fireEvent.change(spin(/Monthly salary now/i), { target: { value: "6000" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    const [moved] = partnerJobs();
    expect(moved.id).toBe(DEFAULT_JOB_ID); // the same job, not a new one minted on the partner
    expect(moved.ownerId).toBe("p-1");
    expect(moved.salary.currentSalaryCents).toBe(dollarsToCents(6000 * 12)); // edited in the same submit
    expect(moved.payChanges).toEqual([{ month: 24, kind: "changeBy", cents: -dollarsToCents(500) }]);
    expect(moved.incomeOverrides).toEqual([{ month: 6, kind: "addBonus", cents: dollarsToCents(5000) }]);
    expect(moved.deferral?.employerMatchFraction).toBe(0.5);
    expect(jobCount()).toBe(0); // and it left the plan
  });

  it("writes neither plane when the ledger refuses the revision", () => {
    // Ledger first, plan only if accepted: the reverse order loses the job outright when the
    // ledger half is refused.
    render(<Harness events={withPartner([])} rejectRevisions />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Alex · Job 1/i }));
    fireEvent.change(screen.getByLabelText("Whose job"), { target: { value: "p-1" } });
    fireEvent.change(spin(/Monthly salary now/i), { target: { value: "9000" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    expect(partnerJobs()).toHaveLength(0); // never landed on the partner
    expect(jobCount()).toBe(1); // and never left the plan
    // Untouched, not half-edited: the refused salary did not stick either.
    expect(headline("Alex · Job 1")).toBe("$5,000/mo");
  });

  it("removes a pay change from a partner's job, on their own plane", () => {
    // Base + Adjustments reaches every earner, so Remove must route by owner.
    const raised: Job = {
      ...partnerJob(2000),
      payChanges: [{ month: 12, kind: "setTo", cents: dollarsToCents(3000) }],
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

describe("JobsPanel — handing a whole job to a partner, end to end", () => {
  // Guards the regression where reassignment was two unrelated writes — dropped from
  // `Plan.jobs`, a fresh job minted on the partner from the draft: new id, no match, no pay
  // change, no bonus, ages against the wrong birth year. Asserted on both planes and the
  // projection, covering the `Plan.jobs` / `RelationshipEvent` / `compilePersonIncomeSeries` seam.
  const PRIMARY_BIRTH_YEAR = START_YEAR - PLAN_DEFAULTS.currentAge; // Alex, 35 now
  const PARTNER_BIRTH_YEAR = START_YEAR - 40; // Sam, 40 now, retiring at 65
  const JOIN_MONTH = 60; // Sam arrives five years in
  const PARTNER_RETIREMENT_MONTH = (65 - 40) * 12; // their open-ended jobs stop here
  const NEW_START_AGE = 32; // Sam's 32 — a year they reached BEFORE the plan's "now"

  const PAY_CHANGE = { month: 120, kind: "changeBy", cents: dollarsToCents(500) } as const;
  const BONUS = { month: 72, kind: "addBonus", cents: dollarsToCents(2_000) } as const;

  /** The primary person's job, carrying everything the edit form never shows. */
  const richJob: Job = {
    id: "job-1",
    name: "Software Engineer",
    ownerId: PRIMARY_PERSON_ID,
    startYear: PRIMARY_BIRTH_YEAR + 30, // Alex started it at 30
    endYear: null,
    salary: { startingSalaryCents: dollarsToCents(60_000), currentSalaryCents: dollarsToCents(60_000), realGrowthPct: 0 },
    deferral: { deferralFraction: 0.06, fundAccountId: RETIREMENT_ID, employerMatchFraction: 0.5 },
    payChanges: [PAY_CHANGE],
    incomeOverrides: [BONUS],
  };
  const planWithRichJob: Plan = { ...PLAN_DEFAULTS, jobs: [richJob] };
  const samJoinsAt = (month: number): NewLifeEvent => ({ ...partnerJoining([]), month });

  /** Every wage source the projection pays `ownerId` in `month`, as cents. */
  function wagesFor(series: ProjectionSeries, ownerId: string, month: number): number {
    const sources = series.months.find((m) => m.month === month)?.flows?.incomeSources ?? [];
    return sources
      .filter((s) => s.category === "wages" && s.ownerId === ownerId)
      .reduce((sum, s) => sum + s.cashInflowCents, 0);
  }

  it("moves the job itself — id, match, pay change and bonus — and the projection follows", () => {
    render(<Harness initial={planWithRichJob} events={[samJoinsAt(JOIN_MONTH)]} />);

    // One submission: a different owner, and a different salary and start age.
    fireEvent.click(screen.getByRole("button", { name: /Edit Alex · Software Engineer/i }));
    fireEvent.change(screen.getByLabelText("Whose job"), { target: { value: "p-1" } });
    fireEvent.change(spin(/Monthly salary now/i), { target: { value: "6000" } });
    fireEvent.change(spin(/Start age/i), { target: { value: String(NEW_START_AGE) } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    const { plan, ledger } = authored();

    // It left the plan, and landed on the partner exactly once.
    expect(plan.jobs).toEqual([]);
    expect(jobCount()).toBe(0);
    const moved = partnerJobs();
    expect(moved).toHaveLength(1);
    // Nothing partially transferred: one job with this id in the whole household.
    expect([...plan.jobs, ...moved].filter((j) => j.id === "job-1")).toHaveLength(1);
    expect(screen.queryByLabelText("Alex · Software Engineer")).toBeNull();
    expect(screen.getByLabelText("Sam · Software Engineer")).toBeTruthy();

    // The same job, edited — not a new one built from the draft.
    const job = moved[0];
    expect(job.id).toBe("job-1"); // the id it arrived with, not one minted on landing
    expect(job.ownerId).toBe("p-1");
    expect(job.name).toBe("Software Engineer");
    expect(job.salary.currentSalaryCents).toBe(dollarsToCents(72_000)); // $6,000/mo, edited
    // Untouched by an edit to today's pay: what it paid on day one is its own authored fact.
    expect(job.salary.startingSalaryCents).toBe(dollarsToCents(60_000));
    expect(job.endYear).toBeNull();
    // Ages resolve against the target owner: Sam's 32, five years earlier than Alex's would be.
    expect(job.startYear).toBe(PARTNER_BIRTH_YEAR + NEW_START_AGE);
    expect(job.startYear).not.toBe(PRIMARY_BIRTH_YEAR + NEW_START_AGE);
    // Everything the form never shows rode along untouched.
    expect(job.deferral).toEqual({
      deferralFraction: 0.06,
      fundAccountId: RETIREMENT_ID,
      employerMatchFraction: 0.5,
    });
    expect(job.payChanges).toEqual([PAY_CHANGE]);
    expect(job.incomeOverrides).toEqual([BONUS]);

    const series = Projection.fromState(stateOf(plan, ledger), usJurisdiction).run(usJurisdiction).series;
    // The income is the partner's now — the primary person has no job left to pay them.
    expect(wagesFor(series, "p-1", JOIN_MONTH + 1)).toBeGreaterThan(0);
    expect(wagesFor(series, PRIMARY_PERSON_ID, JOIN_MONTH + 1)).toBe(0);
    // The job started in 2018, but a member's jobs pay only from the month they join.
    expect(wagesFor(series, "p-1", 1)).toBe(0);
    expect(wagesFor(series, "p-1", JOIN_MONTH - 1)).toBe(0);
    // It stops at the boundary its owner carries: open-ended, so Sam's retirement age.
    expect(wagesFor(series, "p-1", PARTNER_RETIREMENT_MONTH - 1)).toBeGreaterThan(0);
    expect(wagesFor(series, "p-1", PARTNER_RETIREMENT_MONTH)).toBe(0);
  });

  it("stops the moved job's income at a separation, not at the partner's retirement", () => {
    // The other boundary: the window that clips the income is the membership's, not the job's.
    const separation: NewLifeEvent = {
      id: "s1",
      type: "SeparationEvent",
      month: 180,
      partnerPersonId: "p-1",
      alimonyMonthlyCents: 0,
      alimonyDurationMonths: 0,
      childSupportMonthlyCents: 0,
    };
    render(<Harness initial={planWithRichJob} events={[samJoinsAt(JOIN_MONTH), separation]} />);

    fireEvent.click(screen.getByRole("button", { name: /Edit Alex · Software Engineer/i }));
    fireEvent.change(screen.getByLabelText("Whose job"), { target: { value: "p-1" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    const { plan, ledger } = authored();
    expect(plan.jobs).toEqual([]);
    expect(partnerJobs()).toHaveLength(1);

    const series = Projection.fromState(stateOf(plan, ledger), usJurisdiction).run(usJurisdiction).series;
    expect(wagesFor(series, "p-1", 179)).toBeGreaterThan(0); // last month as a member
    expect(wagesFor(series, "p-1", 180)).toBe(0); // gone with the separation
    expect(wagesFor(series, "p-1", PARTNER_RETIREMENT_MONTH - 1)).toBe(0); // long since stopped
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
    fireEvent.change(spin(/From age/i), { target: { value: String(age) } });
    fireEvent.change(spin(/Amount/i), { target: { value: String(dollars) } });
    fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
  };

  it("dates a raise by the owner's age and lists it back", () => {
    render(<Harness />);
    openPayChange("Job 1");
    applyPayChange("setTo", 45, 8000);

    // Authored at age 45 with the owner 35 now → month 120, read back as age 45.
    expect(authored().plan.jobs[0].payChanges).toEqual([
      { month: 120, kind: "setTo", cents: dollarsToCents(8000) },
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
    expect(authored().plan.jobs[0].payChanges).toEqual([
      { month: 60, kind: "changeBy", cents: -dollarsToCents(500) },
    ]);
    expect(timeline("Job 1").getByText(/Pay cut \$500\/mo/)).toBeTruthy();
  });

  it("writes a partner's raise to the event carrying their job, not the plan", () => {
    render(<Harness events={[partnerJoining([partnerJob(4_000)])]} />);
    openPayChange("Sam · Job 1");
    applyPayChange("setTo", 50, 6000);

    // The partner is 40 now, so age 50 is month 120 — read against THEIR birth year.
    expect(partnerJobs()[0].payChanges).toEqual([
      { month: 120, kind: "setTo", cents: dollarsToCents(6000) },
    ]);
    // Nothing landed on the plan plane.
    expect(authored().plan.jobs[0].payChanges).toBeUndefined();
  });

  it("dates a change BEFORE now as a negative month — that is how a pay history is authored", () => {
    // The floor is the job's start age (18 here), not "now": an age already lived becomes a
    // negative month, which is what routes the change to the historical reconstruction.
    render(<Harness />);
    openPayChange("Job 1");
    applyPayChange("setTo", 20, 7000);
    expect(authored().plan.jobs[0].payChanges).toEqual([
      { month: (20 - 35) * 12, kind: "setTo", cents: dollarsToCents(7000) },
    ]);
  });

  it("clamps a change dated before the job existed — there is no baseline to apply it to", () => {
    render(<Harness />); // the default job starts at 18
    openPayChange("Job 1");
    applyPayChange("setTo", 12, 7000);
    expect(authored().plan.jobs[0].payChanges).toEqual([
      { month: (18 - 35) * 12, kind: "setTo", cents: dollarsToCents(7000) },
    ]);
  });

  it("closes without writing when cancelled", () => {
    render(<Harness />);
    openPayChange("Job 1");
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(screen.queryByRole("group", { name: /Pay change/i })).toBeNull();
    expect(authored().plan.jobs[0].payChanges).toBeUndefined();
  });

  it("leaves the plan untouched when the facade refuses the write", () => {
    render(<Harness rejectRevisions />);
    openPayChange("Job 1");
    applyPayChange("setTo", 45, 8000);
    expect(authored().plan.jobs[0].payChanges).toBeUndefined();
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
  const BIRTH_YEAR = START_YEAR - PLAN_DEFAULTS.currentAge; // Alex, 35 now, working since 18

  const openPayChange = (label: string) =>
    fireEvent.click(screen.getByRole("button", { name: `Change pay on ${label}` }));

  it("states the two salary anchors separately, and neither rewrites the other", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    fireEvent.change(spin(/Monthly salary at age 18/i), { target: { value: "3000" } });
    fireEvent.change(spin(/Monthly salary now/i), { target: { value: "6667" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    const { salary } = authored().plan.jobs[0];
    expect(salary.startingSalaryCents).toBe(dollarsToCents(3000) * 12);
    expect(salary.currentSalaryCents).toBe(dollarsToCents(6667) * 12);
    // The headline is the month-0 anchor, which is what the projection starts from.
    expect(headline("Job 1")).toBe("$6,667/mo");
  });

  it("offers only one salary field on a job with no past — there is one fact to state", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Add a job/i })); // starts at 35, today
    expect(screen.queryByRole("spinbutton", { name: /Monthly salary at age/i })).toBeNull();
    fireEvent.change(spin(/Monthly salary/i), { target: { value: "4000" } });
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));
    // One number in, both anchors out: "it pays X" means a flat history.
    const added = authored().plan.jobs[1].salary;
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
    fireEvent.change(spin(/From age/i), { target: { value: "30" } });
    fireEvent.change(spin(/Amount/i), { target: { value: "6250" } });
    fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));

    expect(authored().plan.jobs[0].payChanges).toEqual([
      { month: (30 - 35) * 12, kind: "setTo", cents: dollarsToCents(6250) },
    ]);
    expect(timeline("Job 1").getByText("age 30")).toBeTruthy();
    expect(timeline("Job 1").getByText(/Pay set to \$6,250\/mo/)).toBeTruthy();
    // Left of the seam, which is where the engine reads it from: a negative month is the
    // historical reconstruction's, and it never touches the forward series.
    expect(timeline("Job 1").getByText(/^now ·/)).toBeTruthy();
    // That the negative month then feeds the covered-earnings record is the engine's contract,
    // pinned in `job.test.ts` — what this panel owes is the negative month itself.
  });

  it("keeps a raise dated at today's age, and says it starts next month", () => {
    // The owner's own current age is month 0, which the authored current salary owns. The
    // change is neither dropped nor allowed to displace that figure — it takes force at month
    // 1, and the form says so before it is applied rather than after.
    render(<Harness />);
    openPayChange("Job 1");
    fireEvent.change(spin(/From age/i), { target: { value: "35" } });
    fireEvent.change(spin(/Amount/i), { target: { value: "6000" } });
    expect(screen.getByText(/starts next month/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));

    expect(authored().plan.jobs[0].payChanges).toEqual([
      { month: 0, kind: "setTo", cents: dollarsToCents(6000) },
    ]);
    // Today's pay is untouched; the row quotes the pay from the month it actually begins.
    expect(headline("Job 1")).toBe("$5,000/mo now");
    expect(timeline("Job 1").getByText(/Pay set to \$6,000\/mo — from next month/)).toBeTruthy();
  });

  it("states the month-0 step where it happens, and drops it when the two anchors agree", () => {
    const withHistory: Plan = {
      ...PLAN_DEFAULTS,
      jobs: PLAN_DEFAULTS.jobs.map((j) => ({
        ...j,
        salary: { ...j.salary, currentSalaryCents: dollarsToCents(6667) * 12 },
      })),
    };
    render(<Harness initial={withHistory} />);
    // Neutral wording, and no reconciliation offered: the step is an authored fact, and the
    // engine deliberately does not close it.
    expect(screen.getByText(/History reaches \$5,000\/mo/)).toBeTruthy();
    expect(screen.getByText(/Today’s pay wins from here on/)).toBeTruthy();
    // The chart says it too, as a shape. Recharts draws nothing in jsdom, so the step is
    // asserted through the data mirror the chart renders beside it.
    expect(screen.getByTestId("pay-chart-seam").textContent).toBe(
      String(dollarsToCents(6667) - dollarsToCents(5000)),
    );

    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    fireEvent.change(spin(/Monthly salary now/i), { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(screen.queryByText(/History reaches/)).toBeNull();
    // Anchors agreed: no step to draw, and no annotation left on the chart either.
    expect(screen.getByTestId("pay-chart-seam").textContent).toBe("0");
  });

  it("asks nothing about 'now' for a job that ended before it", () => {
    // A wholly-past job has no month-0 pay, and the engine never reads its anchor. Asking for
    // today's pay on an employment that is over is nonsense; the app fills the value in.
    const past: Plan = {
      ...PLAN_DEFAULTS,
      jobs: [
        {
          ...PLAN_DEFAULTS.jobs[0],
          startYear: BIRTH_YEAR + 22,
          endYear: BIRTH_YEAR + 26,
          salary: {
            startingSalaryCents: dollarsToCents(1800) * 12,
            currentSalaryCents: dollarsToCents(1800) * 12,
            realGrowthPct: 0,
          },
          payChanges: [{ month: (24 - 35) * 12, kind: "setTo", cents: dollarsToCents(2100) }],
        },
      ],
    };
    render(<Harness initial={past} />);
    // The headline says what it is, rather than quoting a current pay the engine never reads.
    expect(within(screen.getByLabelText("Job 1")).getByText("ended at age 26")).toBeTruthy();
    // No seam row on the timeline, and no seam note.
    expect(timeline("Job 1").queryByText(/^now ·/)).toBeNull();
    expect(screen.queryByText(/History reaches/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    expect(screen.queryByRole("spinbutton", { name: /Monthly salary now/i })).toBeNull();
    expect(screen.getByText(/This job ended at age 26/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    // Pinned to what it last paid, not zeroed: pushing the end age past "now" later must not
    // silently pay nothing.
    expect(authored().plan.jobs[0].salary.currentSalaryCents).toBe(dollarsToCents(2100) * 12);
  });

  it("bounds a pay change to the job's own span, clamping a stale default on the way in", () => {
    const past: Plan = {
      ...PLAN_DEFAULTS,
      jobs: [{ ...PLAN_DEFAULTS.jobs[0], startYear: BIRTH_YEAR + 22, endYear: BIRTH_YEAR + 26 }],
    };
    render(<Harness initial={past} />);
    openPayChange("Job 1");
    // The form opens on the seam (35) — outside this job — so applying it untouched must land
    // inside the span rather than submit the default it opened on.
    fireEvent.change(spin(/Amount/i), { target: { value: "2100" } });
    fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
    expect(authored().plan.jobs[0].payChanges).toEqual([
      { month: (25 - 35) * 12, kind: "setTo", cents: dollarsToCents(2100) },
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
    fireEvent.change(spin(/Start age/i), { target: { value: "33" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    expect(authored().plan.jobs[0].payChanges).toBeUndefined();
    // Named, not merely counted — the user can put back whichever one still applies.
    expect(screen.getByText(/One pay change now fell before this job starts.*age 30/)).toBeTruthy();
  });

  it("says nothing when an edit strands nothing", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    fireEvent.change(spin(/Start age/i), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(screen.queryByText(/fell before this job starts/)).toBeNull();
  });
});
