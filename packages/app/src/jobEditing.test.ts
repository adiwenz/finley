/**
 * Editing a job in place, on the one member who holds it.
 *
 * An edit works from the existing full {@link Job} rather than rebuilding one from the form
 * draft, which would return it with a fresh id and without its one-month overrides, pay
 * changes, or employer match — none of which the form shows, so it cannot carry them.
 *
 * The owner is not editable at all: moving a job re-reads every age against a different birth
 * year, shifting its whole calendar and stranding the pay changes outside the new span. The
 * refusal is pinned below, because the draft still names an owner and a caller could pass a
 * different one.
 */

import { describe, it, expect } from "vitest";
import { PRIMARY_PERSON_ID, type Job } from "@finley/engine";
import { addJob, editJob } from "./jobEditing";
import type { JobOwner } from "./jobOwners";
import { blankJobDraft, jobToDraftFor, type JobEditDraft } from "./planPeople";
import { PLAN_DEFAULTS } from "./planDefaults";
import { readerOf } from "./testing/projectionHarness";

const ALEX_BIRTH_YEAR = 1991; // 35 in 2026
const SAM_BIRTH_YEAR = 1986; // 40 in 2026

/** A job with every field the form does NOT edit populated, so a rebuild would lose them. */
const richJob: Job = {
  id: "job-1",
  name: "Software Engineer",
  ownerId: PRIMARY_PERSON_ID,
  startYear: 2021,
  endYear: ALEX_BIRTH_YEAR + 65,
  salary: { startingSalaryCents: 60_000_00, currentSalaryCents: 60_000_00, realGrowthPct: 1 },
  deferral: { deferralFraction: 0.1, fundAccountId: "retirement", employerMatchFraction: 0.5 },
  incomeOverrides: [{ id: "adjustment-1", month: 6, kind: "addBonus", cents: 5_000_00 }],
  payChanges: [{ id: "adjustment-2", month: 24, kind: "changeBy", cents: -500_00 }],
};

const owner = (over: Partial<JobOwner> & Pick<JobOwner, "id" | "name" | "birthYear" | "jobs">): JobOwner => ({
  startMonth: -Infinity,
  endMonth: null,
  writeTarget: "plan",
  ...over,
});

/** Alex (the plan plane) holding `jobs`, and Sam (a partner, the ledger plane) holding none. */
function household(jobs: readonly Job[] = [richJob], samJobs: readonly Job[] = []): readonly JobOwner[] {
  return [
    owner({ id: PRIMARY_PERSON_ID, name: "Alex", birthYear: ALEX_BIRTH_YEAR, jobs }),
    owner({
      id: "p-1",
      name: "Sam",
      birthYear: SAM_BIRTH_YEAR,
      jobs: samJobs,
      startMonth: 0,
      // `editJob` is plane-agnostic; the plane only routes the commit.
      writeTarget: "event",
    }),
  ];
}

const draftFor = (birthYear: number, job: Job, over: Partial<JobEditDraft> = {}): JobEditDraft => ({
  ...jobToDraftFor(readerOf({ ...PLAN_DEFAULTS, jobs: [job] }), birthYear, job),
  ...over,
});

/**
 * The intents read back as the lists they describe, so an assertion can talk about "Alex's
 * jobs after the edit" rather than about a write shape.
 *
 * Test-side scaffolding, not the production interpreter: `Projection` applies these for real,
 * on whichever plane the owner is authored on, and the engine's tests pin that. What is being
 * checked here is which intents {@link editJob} decides on.
 */
function applied(
  owners: readonly JobOwner[],
  result: ReturnType<typeof editJob>,
): Map<string, readonly Job[]> {
  if (!result.ok) throw new Error(`expected an editable job: ${result.reason}`);
  // Seeded from every member, so an assertion can show a bystander's list is untouched.
  const lists = new Map<string, readonly Job[]>(owners.map((o) => [o.id, o.jobs]));

  for (const write of result.writes) {
    const held = lists.get(write.owner.id) ?? write.owner.jobs;
    switch (write.kind) {
      case "add":
        // `editJob` never authors a new job, so this is `Projection.addJob` minting — the id
        // is the engine's and a test-side interpreter cannot know it.
        lists.set(write.owner.id, [...held, { ...write.job, id: "<minted>", ownerId: write.owner.id } as Job]);
        break;
      case "replace":
        lists.set(
          write.owner.id,
          held.map((j) =>
            j.id === write.jobId ? ({ ...write.job, id: j.id, ownerId: j.ownerId } as Job) : j,
          ),
        );
        break;
      case "remove":
        lists.set(write.owner.id, held.filter((j) => j.id !== write.jobId));
        break;
    }
  }
  return lists;
}

describe("editJob — editing fields, same owner", () => {
  it("replaces the job in place, in the one list it lives on", () => {
    const owners = household();
    const result = editJob(owners, "job-1", draftFor(ALEX_BIRTH_YEAR, richJob, { monthlyCents: 8_000_00 }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // One write, not a remove-then-add: nobody else's list is touched.
    expect(result.writes).toHaveLength(1);
    expect(result.writes[0].owner.id).toBe(PRIMARY_PERSON_ID);

    const jobs = applied(owners, result).get(PRIMARY_PERSON_ID)!;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe("job-1");
    // The edited field is CURRENT pay. What the job paid when it started is a separate
    // authored fact and restating today's pay must not silently rewrite it.
    expect(jobs[0].salary.currentSalaryCents).toBe(8_000_00 * 12);
    expect(jobs[0].salary.startingSalaryCents).toBe(richJob.salary.startingSalaryCents);
  });

  it("keeps its position in the list, so the rows don't reshuffle under an edit", () => {
    const second: Job = { ...richJob, id: "job-2", name: "Consulting" };
    const owners = household([richJob, second]);
    const jobs = applied(
      owners,
      editJob(owners, "job-1", draftFor(ALEX_BIRTH_YEAR, richJob, { name: "Staff Engineer" })),
    ).get(PRIMARY_PERSON_ID)!;

    expect(jobs.map((j) => j.id)).toEqual(["job-1", "job-2"]);
    expect(jobs[0].name).toBe("Staff Engineer");
  });

  it("carries through everything the form does not edit", () => {
    const owners = household();
    const jobs = applied(
      owners,
      editJob(owners, "job-1", draftFor(ALEX_BIRTH_YEAR, richJob, { monthlyCents: 7_000_00 })),
    ).get(PRIMARY_PERSON_ID)!;

    expect(jobs[0].incomeOverrides).toEqual(richJob.incomeOverrides);
    expect(jobs[0].payChanges).toEqual(richJob.payChanges);
    expect(jobs[0].deferral?.employerMatchFraction).toBe(0.5);
    expect(jobs[0].deferral?.fundAccountId).toBe("retirement");
  });
});

describe("editJob — ownership is immutable", () => {
  /**
   * The primary guarantee is a TYPE, so the assertions that matter here are `@ts-expect-error`:
   * each one fails the build if the error it names ever stops happening. A runtime check would
   * be the weaker statement — it can only refuse what the caller managed to express.
   */
  it("cannot be handed an owner at all — the edit draft has no field for one", () => {
    const owners = household();
    // @ts-expect-error — `ownerId` is not a JobEditDraft field, so an edit cannot name one.
    const draft: JobEditDraft = { ...draftFor(ALEX_BIRTH_YEAR, richJob), ownerId: "p-1" };

    // Even smuggled past the type at the call site, the extra key is inert: `applyJobDraft`
    // reads named fields and writes `job.ownerId`, so there is nothing for it to reach.
    const jobs = applied(owners, editJob(owners, "job-1", draft)).get(PRIMARY_PERSON_ID)!;
    expect(jobs[0].ownerId).toBe(PRIMARY_PERSON_ID);
    expect(applied(owners, editJob(owners, "job-1", draft)).get("p-1")).toEqual([]);
  });

  it("takes no owner argument either — the owner is derived from whoever holds the job", () => {
    const owners = household();
    // @ts-expect-error — there is no owner parameter to point somewhere else.
    editJob(owners, PRIMARY_PERSON_ID, "job-1", draftFor(ALEX_BIRTH_YEAR, richJob));

    // Derived, and correct even when the job is on the OTHER member's plane: nothing tells
    // `editJob` where to look but the job id itself.
    const samJob: Job = { ...richJob, id: "p-1-job-1", ownerId: "p-1" };
    const withSam = household([], [samJob]);
    const edited = applied(
      withSam,
      editJob(withSam, "p-1-job-1", draftFor(SAM_BIRTH_YEAR, samJob, { monthlyCents: 7_000_00 })),
    );
    expect(edited.get("p-1")![0].ownerId).toBe("p-1");
    expect(edited.get(PRIMARY_PERSON_ID)).toEqual([]);
  });

  it("preserves ownerId through an ordinary edit that touches every other field", () => {
    const owners = household();
    const jobs = applied(
      owners,
      editJob(
        owners,
        "job-1",
        draftFor(ALEX_BIRTH_YEAR, richJob, {
          name: "Staff Engineer",
          monthlyCents: 9_000_00,
          startingMonthlyCents: 4_000_00,
          startAge: 28,
          endAge: 60,
          realGrowthPct: 2,
          deferralPct: 15,
          employerMatchPct: 100,
        }),
      ),
    ).get(PRIMARY_PERSON_ID)!;

    expect(jobs[0].ownerId).toBe(PRIMARY_PERSON_ID);
    // Ages read against the holder's own clock — there is no second clock to read them against.
    expect(jobs[0].startYear).toBe(ALEX_BIRTH_YEAR + 28);
    expect(jobs[0].endYear).toBe(ALEX_BIRTH_YEAR + 60);
  });
});

describe("addJob — the one place ownership is chosen", () => {
  it("creates a job for the primary person", () => {
    const owners = household([]);
    const result = addJob(owners, PRIMARY_PERSON_ID, blankJobDraft(35));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.writes).toHaveLength(1);
    expect(result.writes[0].kind).toBe("add");
    expect(result.writes[0].owner.id).toBe(PRIMARY_PERSON_ID);
    // Ages resolved against the chosen owner's clock.
    const [write] = result.writes;
    expect(write.kind === "add" && write.job.startYear).toBe(ALEX_BIRTH_YEAR + 35);
  });

  it("creates a job for a partner, on their own clock", () => {
    const owners = household([]);
    const result = addJob(owners, "p-1", blankJobDraft(35));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.writes[0].owner.id).toBe("p-1");
    const [write] = result.writes;
    // The SAME draft, five years earlier: 35 is Sam's 35, not Alex's.
    expect(write.kind === "add" && write.job.startYear).toBe(SAM_BIRTH_YEAR + 35);
  });

  it("carries no owner inside the payload — the member it is added FOR stamps it", () => {
    const result = addJob(household([]), "p-1", blankJobDraft(35));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [write] = result.writes;
    // `JobInput` is `Omit<Job, "id" | "ownerId">`: there is no key here to disagree with the
    // member named beside it, and no id for the app to mint.
    expect(write.kind === "add" && write.job).not.toHaveProperty("ownerId");
    expect(write.kind === "add" && write.job).not.toHaveProperty("id");
  });

  it("refuses an owner who is not in the household", () => {
    const result = addJob(household([]), "p-9", blankJobDraft(35));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/p-9/);
    expect(result).not.toHaveProperty("writes");
  });

  it("strands nothing — a new job has no pay changes to strand", () => {
    const result = addJob(household([]), PRIMARY_PERSON_ID, blankJobDraft(35));
    expect(result.ok && result.strandedPayChanges).toEqual([]);
  });
});

describe("editJob — an edit that cannot be made writes nothing", () => {
  it("refuses a job nobody in the household holds", () => {
    const result = editJob(household(), "job-404", draftFor(ALEX_BIRTH_YEAR, richJob));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/job-404/);
    expect(result).not.toHaveProperty("writes");
  });

  it("names one write, on one member — never a remove paired with an add", () => {
    const result = editJob(household(), "job-1", draftFor(ALEX_BIRTH_YEAR, richJob));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.writes).toHaveLength(1);
    const [write] = result.writes;
    expect(write.kind).toBe("replace");
    expect(write.owner.id).toBe(PRIMARY_PERSON_ID);
    expect(write.kind === "replace" && write.jobId).toBe("job-1");
  });
});

describe("editJob — moving the start age still strands pay changes", () => {
  // Untouched by the ownership work: the one edit that legitimately drops authored facts still
  // drops them, and still names them.
  const withChanges: Job = {
    ...richJob,
    startYear: ALEX_BIRTH_YEAR + 20, // started at 20
    payChanges: [
      { id: "adjustment-3", month: -60, kind: "setTo", cents: 4_000_00 }, // Alex's age 30
      { id: "adjustment-4", month: -12, kind: "changeBy", cents: 500_00 }, // age 34
      { id: "adjustment-5", month: 24, kind: "changeBy", cents: -500_00 }, // age 37
    ],
  };

  it("drops the changes now before the start, and names them", () => {
    const owners = household([withChanges]);
    // Start moved forward to 34: the age-30 change has no job left to sit on.
    const result = editJob(owners, "job-1", draftFor(ALEX_BIRTH_YEAR, withChanges, { startAge: 34 }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strandedPayChanges).toEqual([{ id: "adjustment-3", month: -60, kind: "setTo", cents: 4_000_00 }]);
    const jobs = applied(owners, result).get(PRIMARY_PERSON_ID)!;
    expect(jobs[0].payChanges?.map((c) => c.month)).toEqual([-12, 24]);
    // The edit that dropped them did not also move the job to someone else.
    expect(jobs[0].ownerId).toBe(PRIMARY_PERSON_ID);
  });

  it("strands nothing when the start age moves back", () => {
    const owners = household([withChanges]);
    const result = editJob(owners, "job-1", draftFor(ALEX_BIRTH_YEAR, withChanges, { startAge: 18 }));

    expect(result.ok && result.strandedPayChanges).toEqual([]);
    expect(applied(owners, result).get(PRIMARY_PERSON_ID)![0].payChanges).toHaveLength(3);
  });

  it("drops the whole list, and the key with it, when every change is stranded", () => {
    const owners = household([withChanges]);
    const result = editJob(owners, "job-1", draftFor(ALEX_BIRTH_YEAR, withChanges, { startAge: 38 }));

    expect(result.ok && result.strandedPayChanges).toHaveLength(3);
    expect(applied(owners, result).get(PRIMARY_PERSON_ID)![0].payChanges).toBeUndefined();
  });
});
