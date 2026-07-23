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
import { useState } from "react";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { dollarsToCents, type Plan } from "@finley/engine";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { addJobPayChange, setJobDeferralFraction, primaryJobs } from "../../planPeople";
import { JobsPanel } from "./jobsPanel";

afterEach(cleanup);

/** Controlled harness so edits round-trip through real plan state, plus a job count probe. */
function Harness({ initial = PLAN_DEFAULTS }: { initial?: Plan }) {
  const [budget, setBudget] = useState<Plan>(initial);
  return (
    <>
      <JobsPanel budget={budget} setBudget={setBudget} />
      <output data-testid="job-count">{primaryJobs(budget).length}</output>
    </>
  );
}

const spin = (name: RegExp | string) => screen.getByRole("spinbutton", { name }) as HTMLInputElement;
const jobCount = () => Number(screen.getByTestId("job-count").textContent);

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

  it("turns an open-ended job into a fixed-term one via the end-age control", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Edit Job 1/i }));
    // Uncheck "open-ended" to reveal the end-age field, then set a fixed end.
    fireEvent.click(screen.getByLabelText(/Open-ended/i));
    fireEvent.change(spin(/End age/i), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(within(screen.getByLabelText("Job 1")).getByText(/age 18–50/)).toBeTruthy();
  });

  it("deletes a job", () => {
    render(<Harness />);
    expect(jobCount()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /Delete Job 1/i }));
    expect(jobCount()).toBe(0);
    expect(screen.getByText(/No jobs yet/i)).toBeTruthy();
  });
});

describe("JobsPanel — permanent pay changes (§6, §10.3)", () => {
  // A pay change lands on the job's `payChanges`, not its starting salary — so the job
  // headline stays $5,000/mo while the change is what actually moves pay. (§72 bug: the
  // panel used to show only the starting figure, hiding the change entirely.)
  const withSetToZero = addJobPayChange(PLAN_DEFAULTS, "career", { month: 12, kind: "setTo", cents: 0 });

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
    const cut = addJobPayChange(PLAN_DEFAULTS, "career", { month: 24, kind: "changeBy", cents: -dollarsToCents(500) });
    render(<Harness initial={cut} />);
    expect(screen.getByText(/Pay cut \$500\/mo from age 37/)).toBeTruthy();
  });
});

describe("JobsPanel — 401(k) elective-limit nudge (§5.4)", () => {
  it("discloses that a deferral over the annual limit is paid as taxable income", () => {
    // $5,000/mo = $60k/yr; a 50% deferral is $30k, above the 2026 $24,500 elective limit.
    render(<Harness initial={setJobDeferralFraction(PLAN_DEFAULTS, "career", 0.5)} />);
    expect(screen.getByText(/paid as taxable income/i)).toBeTruthy();
    // The row also surfaces the elected rate.
    expect(within(screen.getByLabelText("Job 1")).getByText(/50% to 401\(k\)/i)).toBeTruthy();
  });

  it("shows no such disclosure when nothing is deferred", () => {
    render(<Harness />); // default 0% deferral
    expect(screen.queryByText(/paid as taxable income/i)).toBeNull();
  });
});
