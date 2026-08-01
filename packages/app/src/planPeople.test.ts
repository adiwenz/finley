/**
 * The draft <-> job seam, focused on the optional human `name`: stored only when typed
 * (trimmed), never as an empty/whitespace title, and read back into the edit draft as "" when
 * absent — so an unnamed job stays unnamed and reports fall back to its stable id.
 *
 * Two functions, each one direction. {@link jobInputFromDraft} builds authoring input and
 * carries no id, because the facade mints it. {@link jobToDraftFor} only reads, so a job
 * fixture here is stated outright — nothing is being authored to need one minted.
 */
import { describe, it, expect } from "vitest";
import { PRIMARY_PERSON_ID, RETIREMENT_ID, type Job } from "@finley/engine";
import {
  applyJobDraft,
  blankJobDraftFor,
  jobInputFromDraft,
  jobToDraftFor,
  type JobDraft,
} from "./planPeople";
import { PLAN_DEFAULTS } from "./planDefaults";
import { readerOf } from "./testing/projectionHarness";

/**
 * A handle holding just this job. {@link jobToDraftFor} reads pay and deferral through the
 * facade, so the form opens on exactly what a write-back would set.
 */
const draftOf = (j: Job) => jobToDraftFor(readerOf({ ...PLAN_DEFAULTS, jobs: [j] }), BIRTH_YEAR, j);

const BIRTH_YEAR = 1991;

const draft = (over: Partial<JobDraft> = {}): JobDraft => ({
  ...blankJobDraftFor(PRIMARY_PERSON_ID, 35),
  ...over,
});

const job = (over: Partial<Job> = {}): Job => ({
  id: "job-1",
  ownerId: PRIMARY_PERSON_ID,
  startYear: BIRTH_YEAR + 22,
  endYear: null,
  salary: { startingSalaryCents: 60_000_00, currentSalaryCents: 60_000_00, realGrowthPct: 0 },
  ...over,
});

describe("jobInputFromDraft — a job's optional name on the way in", () => {
  it("stores a typed name, trimmed", () => {
    expect(jobInputFromDraft(BIRTH_YEAR, draft({ name: "  Software Engineer  " })).name).toBe(
      "Software Engineer",
    );
  });

  it("omits the name entirely when the draft's name is blank or whitespace", () => {
    expect(jobInputFromDraft(BIRTH_YEAR, draft({ name: "" })).name).toBeUndefined();
    expect(jobInputFromDraft(BIRTH_YEAR, draft({ name: "   " })).name).toBeUndefined();
    // Absent, not present-and-empty: an unnamed job carries no `name` key at all.
    expect("name" in jobInputFromDraft(BIRTH_YEAR, draft({ name: "" }))).toBe(false);
  });

  it("names no id, so the facade's mint is the only one there is", () => {
    expect("id" in jobInputFromDraft(BIRTH_YEAR, draft())).toBe(false);
  });
});

describe("jobToDraftFor — reading a job back into the edit form", () => {
  it("reads a name back as itself", () => {
    expect(draftOf(job({ name: "Barista" })).name).toBe("Barista");
  });

  it('reads an unnamed job back as "", not undefined — the form binds a string', () => {
    expect(draftOf(job()).name).toBe("");
  });

  it("round-trips a name through both directions unchanged", () => {
    const input = jobInputFromDraft(BIRTH_YEAR, draft({ name: "Barista" }));
    expect(draftOf(job(input)).name).toBe("Barista");
  });
});

describe("employer 401(k) match — the draft <-> job seam", () => {
  const matched = (fraction: number): Job =>
    job({ deferral: { deferralFraction: 0.06, fundAccountId: RETIREMENT_ID, employerMatchFraction: fraction } });

  it("reads a job's match back as a whole-number percent", () => {
    expect(draftOf(matched(0.5)).employerMatchPct).toBe(50);
  });

  it("reads a deferring job with no match back as 0%, not undefined", () => {
    const deferring = job({ deferral: { deferralFraction: 0.06, fundAccountId: RETIREMENT_ID } });
    expect(draftOf(deferring).employerMatchPct).toBe(0);
  });

  it("sets the fraction on the way in when there's a deferral to match", () => {
    const input = jobInputFromDraft(BIRTH_YEAR, draft({ deferralPct: 6, employerMatchPct: 50 }));
    expect(input.deferral?.employerMatchFraction).toBe(0.5);
  });

  it("omits the match key when the percent is 0", () => {
    const input = jobInputFromDraft(BIRTH_YEAR, draft({ deferralPct: 6, employerMatchPct: 0 }));
    expect(input.deferral && "employerMatchFraction" in input.deferral).toBe(false);
  });

  it("carries no match when there's no deferral to match", () => {
    const input = jobInputFromDraft(BIRTH_YEAR, draft({ deferralPct: 0, employerMatchPct: 50 }));
    expect(input.deferral).toBeUndefined();
  });

  it("applies the draft's match to an existing job, overwriting the prior value", () => {
    const edited = applyJobDraft(matched(0.5), BIRTH_YEAR, draft({ deferralPct: 6, employerMatchPct: 100 }));
    expect(edited.deferral?.employerMatchFraction).toBe(1);
  });

  it("clears a job's match when the draft drops it to 0", () => {
    const edited = applyJobDraft(matched(0.5), BIRTH_YEAR, draft({ deferralPct: 6, employerMatchPct: 0 }));
    expect(edited.deferral && "employerMatchFraction" in edited.deferral).toBe(false);
  });

  it("round-trips a match through both directions unchanged", () => {
    const input = jobInputFromDraft(BIRTH_YEAR, draft({ deferralPct: 6, employerMatchPct: 25 }));
    expect(draftOf(job(input)).employerMatchPct).toBe(25);
  });
});
