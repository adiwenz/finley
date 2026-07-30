/**
 * Job draft <-> standing {@link Job} round-trip, focused on the optional human `name`:
 * stored only when typed (trimmed), never as an empty/whitespace title, and read back
 * into the edit draft as "" when absent — so an unnamed job stays unnamed and reports
 * fall back to its stable id.
 */
import { describe, it, expect } from "vitest";
import { PRIMARY_PERSON_ID, Projection, nullJurisdiction, type Job } from "@finley/engine";
import { PLAN_DEFAULTS } from "./planDefaults";
import { START_YEAR } from "./config";
import {
  blankJobDraft,
  jobInputFromDraft,
  jobToDraft,
  primaryBirthYear,
  primaryJobs,
  type JobDraft,
} from "./planPeople";

const draft = (over: Partial<JobDraft> = {}): JobDraft => ({ ...blankJobDraft(PLAN_DEFAULTS), ...over });

/**
 * The whole round trip a form makes: a draft becomes facade input, the facade authors the
 * standing job — minting its id and stamping its owner, neither of which is stated here — and
 * the job comes back out.
 */
function authored(d: JobDraft = draft(), plan = PLAN_DEFAULTS): Job {
  const p = Projection.create({ plan, startYear: START_YEAR }, nullJurisdiction);
  p.addJob(PRIMARY_PERSON_ID, jobInputFromDraft(primaryBirthYear(plan), d));
  return p.plan.jobs.at(-1)!;
}

describe("planPeople — a job's optional name on the draft round-trip", () => {
  it("stores a typed name (trimmed) on the standing job", () => {
    expect(authored(draft({ name: "  Software Engineer  " })).name).toBe("Software Engineer");
  });

  it("omits the name entirely when the draft's name is blank or whitespace", () => {
    expect(authored(draft({ name: "" })).name).toBeUndefined();
    expect(authored(draft({ name: "   " })).name).toBeUndefined();
    // Absent, not present-and-empty: an unnamed job carries no `name` key at all.
    expect("name" in authored(draft({ name: "" }))).toBe(false);
  });

  it("reads a name back into the edit draft, and \"\" for an unnamed job", () => {
    expect(jobToDraft(PLAN_DEFAULTS, authored(draft({ name: "Barista" }))).name).toBe("Barista");
    // The default plan's job is unnamed: draft name is "", not undefined.
    expect(jobToDraft(PLAN_DEFAULTS, primaryJobs(PLAN_DEFAULTS)[0]).name).toBe("");
  });
});
