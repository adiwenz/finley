/**
 * **Adding, editing and deleting a job** — the gestures, the form state around them, and the
 * public write each one makes.
 *
 * A person may hold any number of jobs, none privileged, each with its own authored end, and each
 * living on the plane its owner lives on: the primary's on `plan`, a partner's on their
 * `RelationshipEvent`. What the projected money then does is the engine's to prove; the one case
 * here that reaches for a projection does so to show an edit changes ONLY what it names.
 */
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { enterNumber } from "../../../testing/numberField";
import {
  PRIMARY_PERSON_ID,
  dollarsToCents,
  type Job,
} from "@finley/engine";
import { PLAN_DEFAULTS } from "../../../planDefaults";
import { START_YEAR } from "../../../config";
import {
  Harness,
  authored,
  headline,
  jobCount,
  partnerJob,
  partnerJoining,
  partnerJobs,
  partnerMonthlyDollars,
  spin,
  timeline,
} from "../jobsPanel.testUtils";


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

/**
 * The other half of the ownership guarantee — that an ordinary edit is otherwise inert, and that
 * the projection reads the edited job the same way it always did — is owned below this layer and
 * is not re-proved through React:
 *
 * - `jobEditing.test.ts` — "carries through everything the form does not edit", "preserves
 *   ownerId through an ordinary edit that touches every other field", "keeps its position in the
 *   list, so the rows don't reshuffle under an edit"
 * - `job.payPath.test.ts` / `job.adjustments.test.ts` — what the edited salary then pays, month
 *   by month, with the job's own pay changes and bonuses still landing on the new baseline
 *
 * What stays here is the interaction: `edits a job's salary in place`, above.
 */

