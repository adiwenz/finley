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
import { PRIMARY_PERSON_ID, type Job } from "@finley/engine";
import { blankJobDraftFor, jobInputFromDraft, jobToDraftFor, type JobDraft } from "./planPeople";

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
  salary: { startingSalaryCents: 60_000_00, realGrowthPct: 0 },
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
    expect(jobToDraftFor(BIRTH_YEAR, job({ name: "Barista" })).name).toBe("Barista");
  });

  it('reads an unnamed job back as "", not undefined — the form binds a string', () => {
    expect(jobToDraftFor(BIRTH_YEAR, job()).name).toBe("");
  });

  it("round-trips a name through both directions unchanged", () => {
    const input = jobInputFromDraft(BIRTH_YEAR, draft({ name: "Barista" }));
    expect(jobToDraftFor(BIRTH_YEAR, job(input)).name).toBe("Barista");
  });
});
