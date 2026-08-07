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
  type JobEditDraft,
} from "./planPeople";
import { START_YEAR } from "./config";
import { PLAN_DEFAULTS } from "./planDefaults";
import { readerOf } from "./testing/projectionHarness";

/**
 * A handle holding just this job. {@link jobToDraftFor} reads pay and deferral through the
 * facade, so the form opens on exactly what a write-back would set.
 */
const draftOf = (j: Job) =>
  jobToDraftFor(
    readerOf({ ...PLAN_DEFAULTS, primary: { ...PLAN_DEFAULTS.primary, jobs: [j] } }),
    BIRTH_YEAR,
    j,
  );

const BIRTH_YEAR = 1991;

const draft = (over: Partial<JobEditDraft> = {}): JobEditDraft => ({
  ...blankJobDraftFor(PRIMARY_PERSON_ID, 35),
  ...over,
});

const job = (over: Partial<Job> = {}): Job => ({
  id: "job-1",
  ownerId: PRIMARY_PERSON_ID,
  startYear: BIRTH_YEAR + 22,
  endYear: BIRTH_YEAR + 65,
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
    const { job: edited } = applyJobDraft(matched(0.5), BIRTH_YEAR, draft({ deferralPct: 6, employerMatchPct: 100 }));
    expect(edited.deferral?.employerMatchFraction).toBe(1);
  });

  it("clears a job's match when the draft drops it to 0", () => {
    const { job: edited } = applyJobDraft(matched(0.5), BIRTH_YEAR, draft({ deferralPct: 6, employerMatchPct: 0 }));
    expect(edited.deferral && "employerMatchFraction" in edited.deferral).toBe(false);
  });

  it("round-trips a match through both directions unchanged", () => {
    const input = jobInputFromDraft(BIRTH_YEAR, draft({ deferralPct: 6, employerMatchPct: 25 }));
    expect(draftOf(job(input)).employerMatchPct).toBe(25);
  });
});

describe("applyJobDraft — the two salary anchors", () => {
  // Someone 35 now (`START_YEAR - 35`), on a job they began at 22.
  const NOW_BIRTH_YEAR = START_YEAR - 35;
  const existing = job({ startYear: NOW_BIRTH_YEAR + 22 });
  const editing = (over: Partial<JobEditDraft> = {}): JobEditDraft =>
    draft({ startAge: 22, startingMonthlyCents: 5_000_00, monthlyCents: 5_000_00, ...over });

  it("writes each anchor from its own field, so one edit cannot rewrite the other", () => {
    const { job: edited } = applyJobDraft(existing, NOW_BIRTH_YEAR, editing({ monthlyCents: 6_667_00 }));
    expect(edited.salary.currentSalaryCents).toBe(6_667_00 * 12);
    expect(edited.salary.startingSalaryCents).toBe(5_000_00 * 12);
  });

  it("keeps the start salary's VALUE when the start age moves, not its meaning", () => {
    // `startingSalaryCents` is dated by the start age itself, so moving 22 → 20 leaves the
    // number alone and it now means "at 20". Re-deriving it would invent data.
    const { job: edited } = applyJobDraft(existing, NOW_BIRTH_YEAR, editing({ startAge: 20 }));
    expect(edited.salary.startingSalaryCents).toBe(5_000_00 * 12);
    expect(edited.startYear).toBe(NOW_BIRTH_YEAR + 20);
  });
});

describe("applyJobDraft — pay changes an edit can no longer hold", () => {
  const NOW_BIRTH_YEAR = START_YEAR - 41;
  const historical = { id: "adjustment-34", month: (30 - 41) * 12, kind: "setTo", cents: 6_250_00 } as const;
  const future = { id: "adjustment-35", month: 72, kind: "setTo", cents: 7_500_00 } as const;
  const existing = job({
    startYear: NOW_BIRTH_YEAR + 28,
    payChanges: [historical, future],
  });
  const editing = (over: Partial<JobEditDraft> = {}): JobEditDraft =>
    draft({ startAge: 28, startingMonthlyCents: 5_000_00, monthlyCents: 6_667_00, ...over });

  it("keeps every change that still falls inside the job", () => {
    const applied = applyJobDraft(existing, NOW_BIRTH_YEAR, editing());
    expect(applied.job.payChanges).toEqual([historical, future]);
    expect(applied.strandedPayChanges).toEqual([]);
  });

  it("drops the changes a later start age strands, and names them", () => {
    // Moving the start from 28 to 33 orphans the age-30 raise: it now predates the job and has
    // no baseline to apply to. Clamping would stack two changes on one month; deleting it
    // silently would lose an authored fact, so it is dropped and reported.
    const applied = applyJobDraft(existing, NOW_BIRTH_YEAR, editing({ startAge: 33 }));
    expect(applied.strandedPayChanges).toEqual([historical]);
    expect(applied.job.payChanges).toEqual([future]);
  });

  it("leaves no empty list behind when every change is stranded", () => {
    const onlyHistory = job({ startYear: NOW_BIRTH_YEAR + 28, payChanges: [historical] });
    const applied = applyJobDraft(onlyHistory, NOW_BIRTH_YEAR, editing({ startAge: 33 }));
    expect(applied.job.payChanges).toBeUndefined();
  });
});

describe("a job that ended before now — the anchor the engine never reads", () => {
  const NOW_BIRTH_YEAR = START_YEAR - 41;
  /** Ran 22–26, raised to $2,100/mo at 24. Fifteen years behind us. */
  const barista = job({
    startYear: NOW_BIRTH_YEAR + 22,
    endYear: NOW_BIRTH_YEAR + 26,
    salary: { startingSalaryCents: 21_600_00, currentSalaryCents: 21_600_00, realGrowthPct: 0 },
    payChanges: [{ id: "adjustment-36", month: (24 - 41) * 12, kind: "setTo", cents: 2_100_00 }],
  });

  it("pins the dead month-0 anchor to what the job last paid, never to zero", () => {
    // `compileJobIncome` drops a wholly-past job before reading the anchor, so the value is
    // inert — which makes the choice purely about which latent state fails better. Zero would
    // silently pay $0/mo the moment the end age moved past "now".
    const { job: edited } = applyJobDraft(
      barista,
      NOW_BIRTH_YEAR,
      draft({ startAge: 22, endAge: 26, startingMonthlyCents: 1_800_00, monthlyCents: 9_999_00 }),
    );
    expect(edited.salary.currentSalaryCents).toBe(2_100_00 * 12);
    expect(edited.salary.startingSalaryCents).toBe(1_800_00 * 12);
  });

  it("does the same for a job added as already over, which has no history to reach for", () => {
    const input = jobInputFromDraft(
      NOW_BIRTH_YEAR,
      draft({ startAge: 22, endAge: 26, startingMonthlyCents: 1_800_00, monthlyCents: 9_999_00 }),
    );
    expect(input.salary.currentSalaryCents).toBe(1_800_00 * 12);
  });

  it("leaves a still-running job's stated current pay alone", () => {
    const input = jobInputFromDraft(
      NOW_BIRTH_YEAR,
      draft({ startAge: 22, endAge: 65, startingMonthlyCents: 1_800_00, monthlyCents: 6_667_00 }),
    );
    expect(input.salary.currentSalaryCents).toBe(6_667_00 * 12);
  });
});
