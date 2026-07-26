/**
 * @vitest-environment jsdom
 *
 * Jobs panel (§6, issue #72) — the authoring surface for earned income. Pins that a
 * person can hold ANY number of jobs (none privileged, several possibly open-ended),
 * that add / edit / delete are direct value-plane edits to `plan.jobs`, and that the
 * 401(k) elective-limit nudge (which left the Budget editor with the deferral) fires
 * here across all jobs.
 */
import { describe, it, expect, afterEach } from "vitest";
import { useMemo, useRef, useState } from "react";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import {
  createProjectionBase,
  dollarsToCents,
  interpretLedger,
  updateEvent,
  type Job,
  type Ledger,
  type NewLifeEvent,
  type Plan,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import type { EventRevision } from "../../hooks/useLedger";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { START_YEAR } from "../../config";
import { addJobPayChange, setJobDeferralFraction, primaryJobs } from "../../planPeople";
import { JobsPanel } from "./jobsPanel";

afterEach(cleanup);

/**
 * Controlled harness so edits round-trip through real state, plus probes for each plane
 * a job can live on: the primary person's jobs on the plan, a partner's on their
 * `RelationshipEvent` (issue #118). Stands in for `App`, which owns both.
 */
function Harness({
  initial = PLAN_DEFAULTS,
  events = [],
  rejectRevisions = false,
}: {
  initial?: Plan;
  events?: readonly NewLifeEvent[];
  /** Stands in for a §6.1 conflict: every ledger revision is refused, as `App` would. */
  rejectRevisions?: boolean;
}) {
  const [budget, setBudget] = useState<Plan>(initial);
  const [ledger, setLedger] = useState<Ledger>(() => ({
    events: events.map((e, i) => ({ ...e, sequenceNumber: i })),
    nextSequenceNumber: events.length,
  }));
  const base = useMemo(
    () => createProjectionBase(budget, { jurisdiction: usJurisdiction, startYear: START_YEAR }),
    [budget],
  );
  const household = useMemo(() => interpretLedger(ledger, base), [ledger, base]);
  // The ledger, readable synchronously — `onReviseEvents` answers whether it committed
  // before the panel writes the plan side, exactly as `useLedger` does.
  const ledgerRef = useRef(ledger);
  ledgerRef.current = ledger;
  const onReviseEvents = (revisions: readonly EventRevision[]): boolean => {
    if (rejectRevisions) return false;
    let next = ledgerRef.current;
    for (const revision of revisions) {
      const result = updateEvent(next, revision.id, revision.next, base);
      if (!result.ok) return false;
      next = result.ledger;
    }
    ledgerRef.current = next;
    setLedger(next);
    return true;
  };

  return (
    <>
      <JobsPanel
        budget={budget}
        setBudget={setBudget}
        household={household}
        ledger={ledger}
        onReviseEvents={onReviseEvents}
      />
      <output data-testid="job-count">{primaryJobs(budget).length}</output>
      <output data-testid="partner-jobs">{JSON.stringify(partnerJobsOf(ledger))}</output>
    </>
  );
}

/** The jobs currently authored on the partner's RelationshipEvent — the ledger plane. */
function partnerJobsOf(ledger: Ledger): readonly Job[] {
  for (const e of ledger.events) if (e.type === "RelationshipEvent") return e.person.jobs;
  return [];
}

/** A partner joining at month 0 with `jobs` of their own (§8, issue #118). */
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

/** One open-ended partner job paying `monthlyDollars`, started at their age 40 ("now"). */
const partnerJob = (monthlyDollars: number, name?: string): Job => ({
  id: "p-1-job-1",
  ...(name ? { name } : {}),
  ownerId: "p-1",
  startYear: START_YEAR,
  endYear: null,
  salary: { startingSalaryCents: dollarsToCents(monthlyDollars * 12), realGrowthPct: 0 },
});

const spin = (name: RegExp | string) => screen.getByRole("spinbutton", { name }) as HTMLInputElement;
const jobCount = () => Number(screen.getByTestId("job-count").textContent);
const partnerJobs = (): readonly Job[] =>
  JSON.parse(screen.getByTestId("partner-jobs").textContent || "[]") as Job[];
const partnerMonthlyDollars = (i = 0): number =>
  Math.round((partnerJobs()[i]?.salary.startingSalaryCents ?? 0) / 12 / 100);

describe("JobsPanel — listing (§6)", () => {
  it("lists the default job with its salary and open-ended span", () => {
    render(<Harness />);
    const row = screen.getByLabelText("Job 1");
    expect(within(row).getByText("$5,000/mo")).toBeTruthy();
    expect(within(row).getByText(/open-ended \(to retirement\)/i)).toBeTruthy();
  });
});

describe("JobsPanel — add / edit / delete (§6, §10.3)", () => {
  it("adds a second job — a person may hold several, none privileged", () => {
    render(<Harness />);
    expect(jobCount()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /Add a job/i }));
    fireEvent.change(spin(/Monthly salary/i), { target: { value: "2000" } });
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));
    expect(jobCount()).toBe(2);
    expect(within(screen.getByLabelText("Job 2")).getByText("$2,000/mo")).toBeTruthy();
  });

  it("edits a job's salary in place", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    fireEvent.change(spin(/Monthly salary/i), { target: { value: "8000" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(within(screen.getByLabelText("Job 1")).getByText("$8,000/mo")).toBeTruthy();
  });

  it("caps the 401(k) contribution at 100% — you can't defer more than your salary", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    const deferral = spin(/401\(k\) contribution/i);
    fireEvent.change(deferral, { target: { value: "1000" } });
    fireEvent.blur(deferral); // NumInput clamps to its max on blur
    expect(Number(deferral.value)).toBe(100);
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    // Saved at the cap — the row shows 100% to 401(k), not 1000%.
    expect(within(screen.getByLabelText("Job 1")).getByText(/100% to 401\(k\)/i)).toBeTruthy();
  });

  it("turns an open-ended job into a fixed-term one via the end-age control", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    // Uncheck "open-ended" to reveal the end-age field, then set a fixed end.
    fireEvent.click(screen.getByLabelText(/Open-ended/i));
    fireEvent.change(spin(/End age/i), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(within(screen.getByLabelText("Job 1")).getByText(/age 18–50/)).toBeTruthy();
  });

  it("remembers the entered end age across an open-ended toggle instead of resetting it", () => {
    // endAge:null IS open-ended, but the last finite value is kept so ticking the box on
    // then off restores the user's number rather than snapping back to the 65 default.
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    fireEvent.click(screen.getByLabelText(/Open-ended/i)); // reveal the end-age field
    fireEvent.change(spin(/End age/i), { target: { value: "52" } });

    fireEvent.click(screen.getByLabelText(/Open-ended/i)); // back to open-ended
    expect(screen.queryByRole("spinbutton", { name: /End age/i })).toBeNull(); // field hidden

    fireEvent.click(screen.getByLabelText(/Open-ended/i)); // fixed-term again
    expect(Number(spin(/End age/i).value)).toBe(52); // the user's 52, not the default

    // And it saves as the restored value.
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
    // The row header now reads the human title, not the positional "Job 1".
    const row = screen.getByLabelText("Software Engineer");
    expect(within(row).getByText("$5,000/mo")).toBeTruthy();
    // And the name is seeded back when the form re-opens.
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

describe("JobsPanel — every member's jobs (§8, issue #118)", () => {
  const withPartner = (jobs: readonly Job[] = [partnerJob(2000)]) => [partnerJoining(jobs)];

  it("lists a partner's jobs next to the primary person's, each named by its owner", () => {
    // A partner's jobs used to be invisible here — authored at the moment they joined
    // and unreachable afterwards. Now both earners' jobs are one list.
    render(<Harness events={withPartner()} />);
    expect(within(screen.getByLabelText("Alex · Job 1")).getByText("$5,000/mo")).toBeTruthy();
    const partnerRow = screen.getByLabelText("Sam · Job 1");
    expect(within(partnerRow).getByText("$2,000/mo")).toBeTruthy();
    // Spans read in the OWNER's age, not the primary person's: Sam is 40, not 35.
    expect(within(partnerRow).getByText(/from age 40/)).toBeTruthy();
  });

  it("edits a partner's job — the revision is written back to their RelationshipEvent", () => {
    render(<Harness events={withPartner()} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Sam · Job 1/i }));
    fireEvent.change(spin(/Monthly salary/i), { target: { value: "3500" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    expect(within(screen.getByLabelText("Sam · Job 1")).getByText("$3,500/mo")).toBeTruthy();
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
    fireEvent.change(spin(/Monthly salary/i), { target: { value: "2500" } });
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));

    expect(partnerJobs()).toHaveLength(1);
    expect(partnerJobs()[0].ownerId).toBe("p-1");
    expect(partnerMonthlyDollars()).toBe(2500);
    expect(jobCount()).toBe(1); // added to the partner, NOT to the primary person
    expect(within(screen.getByLabelText("Sam · Job 1")).getByText("$2,500/mo")).toBeTruthy();
  });

  it("reassigns a job from one member to the other, ages following the new owner", () => {
    render(<Harness events={withPartner([])} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Alex · Job 1/i }));
    fireEvent.change(screen.getByLabelText("Whose job"), { target: { value: "p-1" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    // It left the plan for the partner's event, keeping its pay.
    expect(jobCount()).toBe(0);
    expect(partnerJobs()).toHaveLength(1);
    expect(partnerMonthlyDollars()).toBe(5000);
    // The start age is unchanged as a NUMBER (18), but now it is Sam's 18.
    expect(within(screen.getByLabelText("Sam · Job 1")).getByText(/from age 18/)).toBeTruthy();
    expect(partnerJobs()[0].startYear).toBe(START_YEAR - 40 + 18);
  });

  it("carries the whole job across a reassignment — id, overrides, pay changes, match", () => {
    // Reassignment used to remove the job and MINT a new one from the form draft, which
    // holds none of this: the job arrived with a fresh id, no bonus, no raise, no match.
    // Fields and owner are one edit applied to the existing job, so all of it rides along.
    const rich = addJobPayChange(
      setJobDeferralFraction(PLAN_DEFAULTS, "job-1", 0.1),
      "job-1",
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
    fireEvent.change(spin(/Monthly salary/i), { target: { value: "6000" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    const [moved] = partnerJobs();
    expect(moved.id).toBe("job-1"); // the same job, not a new one minted on the partner
    expect(moved.ownerId).toBe("p-1");
    expect(moved.salary.startingSalaryCents).toBe(dollarsToCents(6000 * 12)); // edited in the same submit
    expect(moved.payChanges).toEqual([{ month: 24, kind: "changeBy", cents: -dollarsToCents(500) }]);
    expect(moved.incomeOverrides).toEqual([{ month: 6, kind: "addBonus", cents: dollarsToCents(5000) }]);
    expect(moved.deferral?.employerMatchFraction).toBe(0.5);
    expect(jobCount()).toBe(0); // and it left the plan
  });

  it("writes neither plane when the ledger refuses the revision", () => {
    // The two halves of a transfer sit on different planes. A conflict rejecting the
    // ledger half after the plan half had been written would lose the job outright — so
    // the ledger goes first and the plan only follows if it was accepted.
    render(<Harness events={withPartner([])} rejectRevisions />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Alex · Job 1/i }));
    fireEvent.change(screen.getByLabelText("Whose job"), { target: { value: "p-1" } });
    fireEvent.change(spin(/Monthly salary/i), { target: { value: "9000" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    expect(partnerJobs()).toHaveLength(0); // never landed on the partner
    expect(jobCount()).toBe(1); // and never left the plan
    // Untouched, not half-edited: the refused salary did not stick either.
    expect(within(screen.getByLabelText("Alex · Job 1")).getByText("$5,000/mo")).toBeTruthy();
  });

  it("offers no owner picker in a single-earner household", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Add a job/i }));
    expect(screen.queryByLabelText("Whose job")).toBeNull();
  });
});

describe("JobsPanel — permanent pay changes (§6, §10.3)", () => {
  // A pay change lands on the job's `payChanges`, not its starting salary — so the job
  // headline stays $5,000/mo while the change is what actually moves pay. (§72 bug: the
  // panel used to show only the starting figure, hiding the change entirely.)
  const withSetToZero = addJobPayChange(PLAN_DEFAULTS, "job-1", { month: 12, kind: "setTo", cents: 0 });

  it("lists a job's permanent pay changes, flagging the headline as the STARTING salary", () => {
    render(<Harness initial={withSetToZero} />);
    const row = screen.getByLabelText("Job 1");
    // Headline is the starting salary, now flagged as such since a change follows it.
    expect(within(row).getByText(/\$5,000\/mo to start/)).toBeTruthy();
    // The change itself is listed in full — age 36 = current 35 + month 12.
    expect(within(row).getByText(/Pay set to \$0\/mo from age 36/)).toBeTruthy();
  });

  it("does not conflate a permanent pay change with a one-off (single-month) adjustment", () => {
    render(<Harness initial={withSetToZero} />);
    // The pay change must NOT be counted as a one-off adjustment (the old mislabel).
    expect(screen.queryByText(/one-off/i)).toBeNull();
  });

  it("removes a pay change, restoring the plain starting salary", () => {
    render(<Harness initial={withSetToZero} />);
    fireEvent.click(screen.getByRole("button", { name: /Remove pay change at age 36 on Job 1/i }));
    expect(screen.queryByText(/Pay set to \$0\/mo/)).toBeNull();
    // No pay changes left, so the headline drops the "to start" qualifier.
    expect(within(screen.getByLabelText("Job 1")).getByText("$5,000/mo")).toBeTruthy();
  });

  it("describes a delta cut with the right verb and sign", () => {
    const cut = addJobPayChange(PLAN_DEFAULTS, "job-1", { month: 24, kind: "changeBy", cents: -dollarsToCents(500) });
    render(<Harness initial={cut} />);
    expect(screen.getByText(/Pay cut \$500\/mo from age 37/)).toBeTruthy();
  });
});

describe("JobsPanel — 401(k) elective-limit nudge (§5.4)", () => {
  it("discloses that a deferral over the annual limit is paid as taxable income", () => {
    // $5,000/mo = $60k/yr; a 50% deferral is $30k, above the 2026 $24,500 elective limit.
    render(<Harness initial={setJobDeferralFraction(PLAN_DEFAULTS, "job-1", 0.5)} />);
    expect(screen.getByText(/paid as taxable income/i)).toBeTruthy();
    // The row also surfaces the elected rate.
    expect(within(screen.getByLabelText("Job 1")).getByText(/50% to 401\(k\)/i)).toBeTruthy();
  });

  it("shows no such disclosure when nothing is deferred", () => {
    render(<Harness />); // default 0% deferral
    expect(screen.queryByText(/paid as taxable income/i)).toBeNull();
  });
});
