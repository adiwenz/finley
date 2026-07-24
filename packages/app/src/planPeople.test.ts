/**
 * Job draft <-> standing {@link Job} round-trip (issue #72). Focused on the optional
 * human `name`: it is stored only when the user actually typed one (trimmed), never as
 * an empty/whitespace title, and reads back into the edit draft as "" when absent — so
 * an unnamed job stays unnamed and reports fall back to its stable id.
 */
import { describe, it, expect } from "vitest";
import { PLAN_DEFAULTS } from "./planDefaults";
import { addJobFromDraft, blankJobDraft, jobToDraft, primaryJobs, type JobDraft } from "./planPeople";

const draft = (over: Partial<JobDraft> = {}): JobDraft => ({ ...blankJobDraft(PLAN_DEFAULTS), ...over });
const lastJob = (plan = PLAN_DEFAULTS, d: JobDraft = draft()) =>
  primaryJobs(addJobFromDraft(plan, d)).at(-1)!;

describe("planPeople — a job's optional name on the draft round-trip", () => {
  it("stores a typed name (trimmed) on the standing job", () => {
    expect(lastJob(PLAN_DEFAULTS, draft({ name: "  Software Engineer  " })).name).toBe(
      "Software Engineer",
    );
  });

  it("omits the name entirely when the draft's name is blank or whitespace", () => {
    expect(lastJob(PLAN_DEFAULTS, draft({ name: "" })).name).toBeUndefined();
    expect(lastJob(PLAN_DEFAULTS, draft({ name: "   " })).name).toBeUndefined();
    // The key is absent, not present-and-empty — an unnamed job carries no `name` at all.
    expect("name" in lastJob(PLAN_DEFAULTS, draft({ name: "" }))).toBe(false);
  });

  it("reads a name back into the edit draft, and \"\" for an unnamed job", () => {
    const named = lastJob(PLAN_DEFAULTS, draft({ name: "Barista" }));
    expect(jobToDraft(PLAN_DEFAULTS, named).name).toBe("Barista");
    // The default plan's job is unnamed — its draft name is the empty string, not undefined.
    expect(jobToDraft(PLAN_DEFAULTS, primaryJobs(PLAN_DEFAULTS)[0]).name).toBe("");
  });
});
