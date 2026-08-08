/**
 * **The continuation question, as an authoring control.**
 *
 * What selecting a job MEANS is the solver's, pinned in
 * `packages/engine/src/retirement/retirementSolver.continuation.test.ts`. These pin only that the
 * panel asks once per earner, offers the right options with the right one preselected, writes the
 * answer to the plane its owner lives on, and — the property the whole design turns on — leaves
 * an answer alone when the job list changes underneath it.
 */
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  type Job,
} from "@finley/engine";
import { PLAN_DEFAULTS } from "../../../planDefaults";
import { START_YEAR } from "../../../config";
import {
  DEFAULT_JOB_ID,
  Harness,
  authored,
  partnerJob,
  partnerJoining,
} from "../jobsPanel.testUtils";


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
