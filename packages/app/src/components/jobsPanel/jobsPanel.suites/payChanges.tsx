/**
 * **Permanent pay changes — a raise, a cut, and the pay history a job carries.**
 *
 * A pay change lands on `payChanges` and moves pay from a dated month forward; the starting
 * salary and current pay are two separate anchors and neither rewrites the other. These pin the
 * authoring gesture and the list it reads back into, not the pay arithmetic itself — that is
 * `jobPayPath`'s, in the engine.
 *
 * One-off adjustments (a bonus, a missed paycheck) are a different gesture and live in
 * `jobsPanel.oneOffAdjustments.test.tsx`.
 */
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { enterNumber } from "../../../testing/numberField";
import {
  dollarsToCents,
  type Plan,
} from "@finley/engine";
import { PLAN_DEFAULTS } from "../../../planDefaults";
import { addJobPayChange } from "../../../testing/planFixtures";
import {
  DEFAULT_JOB_ID,
  Harness,
  authored,
  headline,
  partnerJob,
  partnerJoining,
  partnerJobs,
  spin,
  timeline,
} from "../jobsPanel.testUtils";


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
    // That there IS a step, and how big, is `job.payPath.test.ts` ("measures the month-0 step
    // rather than closing it", "reports no step when the history lands exactly on today's pay").

    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    enterNumber(spin(/Monthly salary now/i), "5000");
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    // Anchors agreed: no annotation left.
    expect(screen.queryByTestId("seam-note")).toBeNull();
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

    // That the changes are DROPPED, and named, is owned twice below this layer:
    // `planPeople.test.ts` ("drops the changes a later start age strands, and names them") and
    // `jobEditing.test.ts` ("drops the changes now before the start, and names them"). What is
    // this panel's alone is that the user is TOLD, in words, on the surface they edited from.
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
