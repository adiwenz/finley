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
import { editJob } from "./jobEditing";
import type { JobOwner } from "./jobOwners";
import { jobToDraftFor, type JobDraft } from "./planPeople";
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
  endYear: null,
  salary: { startingSalaryCents: 60_000_00, currentSalaryCents: 60_000_00, realGrowthPct: 1 },
  deferral: { deferralFraction: 0.1, fundAccountId: "retirement", employerMatchFraction: 0.5 },
  incomeOverrides: [{ month: 6, kind: "addBonus", cents: 5_000_00 }],
  payChanges: [{ month: 24, kind: "changeBy", cents: -500_00 }],
};

const owner = (over: Partial<JobOwner> & Pick<JobOwner, "id" | "name" | "birthYear" | "jobs">): JobOwner => ({
  retirementTargetAge: 65,
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

const draftFor = (birthYear: number, job: Job, over: Partial<JobDraft> = {}): JobDraft => ({
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
    const result = editJob(owners, PRIMARY_PERSON_ID, "job-1", draftFor(ALEX_BIRTH_YEAR, richJob, { monthlyCents: 8_000_00 }));

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
      editJob(owners, PRIMARY_PERSON_ID, "job-1", draftFor(ALEX_BIRTH_YEAR, richJob, { name: "Staff Engineer" })),
    ).get(PRIMARY_PERSON_ID)!;

    expect(jobs.map((j) => j.id)).toEqual(["job-1", "job-2"]);
    expect(jobs[0].name).toBe("Staff Engineer");
  });

  it("carries through everything the form does not edit", () => {
    const owners = household();
    const jobs = applied(
      owners,
      editJob(owners, PRIMARY_PERSON_ID, "job-1", draftFor(ALEX_BIRTH_YEAR, richJob, { monthlyCents: 7_000_00 })),
    ).get(PRIMARY_PERSON_ID)!;

    expect(jobs[0].incomeOverrides).toEqual(richJob.incomeOverrides);
    expect(jobs[0].payChanges).toEqual(richJob.payChanges);
    expect(jobs[0].deferral?.employerMatchFraction).toBe(0.5);
    expect(jobs[0].deferral?.fundAccountId).toBe("retirement");
  });
});

describe("editJob — the owner is not editable", () => {
  // A job stays with the member it was added for. The draft still carries an `ownerId` (the
  // form collects it when ADDING), so a caller can name someone else — and must be refused
  // rather than quietly obeyed or quietly ignored.
  it("refuses a draft naming a different member, and writes nothing", () => {
    const owners = household();
    const result = editJob(
      owners,
      PRIMARY_PERSON_ID,
      "job-1",
      draftFor(ALEX_BIRTH_YEAR, richJob, { ownerId: "p-1", monthlyCents: 9_000_00 }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/owner cannot be changed/i);
    // Not half-applied: the edited salary rode on the same submission and is refused with it.
    expect(result).not.toHaveProperty("writes");
  });

  it("refuses a draft naming nobody in the household", () => {
    const result = editJob(
      household(),
      PRIMARY_PERSON_ID,
      "job-1",
      draftFor(ALEX_BIRTH_YEAR, richJob, { ownerId: "p-9" }),
    );
    expect(result.ok).toBe(false);
  });

  it("leaves the job on its owner, holding every field, when the draft agrees", () => {
    const owners = household();
    const result = editJob(
      owners,
      PRIMARY_PERSON_ID,
      "job-1",
      draftFor(ALEX_BIRTH_YEAR, richJob, { startAge: 30, endAge: 60 }),
    );

    const lists = applied(owners, result);
    // Ages read against the holder's own clock, and nobody else's list moved.
    expect(lists.get(PRIMARY_PERSON_ID)![0].startYear).toBe(ALEX_BIRTH_YEAR + 30);
    expect(lists.get(PRIMARY_PERSON_ID)![0].endYear).toBe(ALEX_BIRTH_YEAR + 60);
    expect(lists.get("p-1")).toEqual([]);
  });
});

describe("editJob — an edit that cannot be made writes nothing", () => {
  it("refuses a job the named owner does not hold", () => {
    const result = editJob(household(), PRIMARY_PERSON_ID, "job-404", draftFor(ALEX_BIRTH_YEAR, richJob));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/job-404/);
  });

  it("refuses an unknown source owner", () => {
    const result = editJob(household(), "p-9", "job-1", draftFor(ALEX_BIRTH_YEAR, richJob));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/p-9/);
  });

  it("names one write, on one member — never a remove paired with an add", () => {
    const result = editJob(household(), PRIMARY_PERSON_ID, "job-1", draftFor(ALEX_BIRTH_YEAR, richJob));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.writes).toHaveLength(1);
    const [write] = result.writes;
    expect(write.kind).toBe("replace");
    expect(write.owner.id).toBe(PRIMARY_PERSON_ID);
    expect(write.kind === "replace" && write.jobId).toBe("job-1");
  });
});
