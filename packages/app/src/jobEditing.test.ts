/**
 * Editing a job as ONE operation — fields and owner in a single form submission.
 *
 * The regression pinned here: reassigning used to remove the job from one member and
 * *mint* a new one on the other from the form draft alone, so it came back with a fresh id
 * and without its one-month overrides, pay changes, or employer match — none of which the
 * form shows, so it cannot carry them. An edit works from the existing full {@link Job}
 * instead, and either resolves completely or writes nothing.
 */

import { describe, it, expect } from "vitest";
import { PRIMARY_PERSON_ID, type Job } from "@finley/engine";
import { editJob, type JobWrite } from "./jobEditing";
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
  salary: { startingSalaryCents: 60_000_00, realGrowthPct: 1 },
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
function applied(result: ReturnType<typeof editJob>): Map<string, readonly Job[]> {
  if (!result.ok) throw new Error(`expected an editable job: ${result.reason}`);
  const lists = new Map<string, readonly Job[]>();
  const apply = (jobs: readonly Job[], write: JobWrite): readonly Job[] => {
    switch (write.kind) {
      case "add": {
        // Only ever a job moving between members, which keeps its id — `editJob` never
        // authors a new one, so an intent without an id would be a bug in it.
        if (write.job.id === undefined) throw new Error("editJob emitted a job with no id");
        return [...jobs, { ...write.job, id: write.job.id, ownerId: write.owner.id } as Job];
      }
      case "replace":
        return jobs.map((j) =>
          j.id === write.jobId ? ({ ...write.job, id: j.id, ownerId: j.ownerId } as Job) : j,
        );
      case "remove":
        return jobs.filter((j) => j.id !== write.jobId);
    }
  };
  for (const write of result.writes) {
    lists.set(write.owner.id, apply(lists.get(write.owner.id) ?? write.owner.jobs, write));
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

    const jobs = applied(result).get(PRIMARY_PERSON_ID)!;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe("job-1");
    expect(jobs[0].salary.startingSalaryCents).toBe(8_000_00 * 12);
  });

  it("keeps its position in the list, so the rows don't reshuffle under an edit", () => {
    const second: Job = { ...richJob, id: "job-2", name: "Consulting" };
    const owners = household([richJob, second]);
    const jobs = applied(
      editJob(owners, PRIMARY_PERSON_ID, "job-1", draftFor(ALEX_BIRTH_YEAR, richJob, { name: "Staff Engineer" })),
    ).get(PRIMARY_PERSON_ID)!;

    expect(jobs.map((j) => j.id)).toEqual(["job-1", "job-2"]);
    expect(jobs[0].name).toBe("Staff Engineer");
  });

  it("carries through everything the form does not edit", () => {
    const owners = household();
    const jobs = applied(
      editJob(owners, PRIMARY_PERSON_ID, "job-1", draftFor(ALEX_BIRTH_YEAR, richJob, { monthlyCents: 7_000_00 })),
    ).get(PRIMARY_PERSON_ID)!;

    expect(jobs[0].incomeOverrides).toEqual(richJob.incomeOverrides);
    expect(jobs[0].payChanges).toEqual(richJob.payChanges);
    expect(jobs[0].deferral?.employerMatchFraction).toBe(0.5);
    expect(jobs[0].deferral?.fundAccountId).toBe("retirement");
  });
});

describe("editJob — changing the owner", () => {
  it("moves the job and applies the edited fields in the SAME submission", () => {
    const owners = household();
    const result = editJob(
      owners,
      PRIMARY_PERSON_ID,
      "job-1",
      draftFor(ALEX_BIRTH_YEAR, richJob, { ownerId: "p-1", monthlyCents: 9_000_00, startAge: 30, endAge: 60 }),
    );

    const lists = applied(result);
    // One job in the household, not zero and not two.
    expect(lists.get(PRIMARY_PERSON_ID)).toEqual([]);
    const moved = lists.get("p-1")!;
    expect(moved).toHaveLength(1);
    expect(moved[0].ownerId).toBe("p-1");
    expect(moved[0].salary.startingSalaryCents).toBe(9_000_00 * 12);
  });

  it("keeps the job's id across the move", () => {
    const owners = household();
    const moved = applied(
      editJob(owners, PRIMARY_PERSON_ID, "job-1", draftFor(ALEX_BIRTH_YEAR, richJob, { ownerId: "p-1" })),
    ).get("p-1")!;

    // A minted id would be `p-1-job-1`, orphaning every band, override and pay change
    // keyed to `job-1`.
    expect(moved[0].id).toBe("job-1");
  });

  it("preserves the overrides, pay changes, employer match and deferral account", () => {
    const owners = household();
    const moved = applied(
      editJob(owners, PRIMARY_PERSON_ID, "job-1", draftFor(ALEX_BIRTH_YEAR, richJob, { ownerId: "p-1" })),
    ).get("p-1")!;

    expect(moved[0].incomeOverrides).toEqual(richJob.incomeOverrides);
    expect(moved[0].payChanges).toEqual(richJob.payChanges);
    expect(moved[0].deferral).toEqual(richJob.deferral);
    expect(moved[0].name).toBe("Software Engineer");
  });

  it("re-reads the draft's ages against the NEW owner's birth year", () => {
    const owners = household();
    // Alex's job started at their age 30 (2021); handed to Sam, "started at 30" is SAM's 30.
    const moved = applied(
      editJob(
        owners,
        PRIMARY_PERSON_ID,
        "job-1",
        draftFor(ALEX_BIRTH_YEAR, richJob, { ownerId: "p-1", startAge: 30, endAge: 65 }),
      ),
    ).get("p-1")!;

    expect(moved[0].startYear).toBe(SAM_BIRTH_YEAR + 30);
    expect(moved[0].endYear).toBe(SAM_BIRTH_YEAR + 65);
    // Not the source owner's clock — that would silently shift the job five years.
    expect(moved[0].startYear).not.toBe(ALEX_BIRTH_YEAR + 30);
  });

  it("appends to the target's own jobs rather than replacing them", () => {
    const samJob: Job = { ...richJob, id: "p-1-job-1", name: "Nursing", ownerId: "p-1" };
    const owners = household([richJob], [samJob]);
    const moved = applied(
      editJob(owners, PRIMARY_PERSON_ID, "job-1", draftFor(ALEX_BIRTH_YEAR, richJob, { ownerId: "p-1" })),
    ).get("p-1")!;

    expect(moved.map((j) => j.id)).toEqual(["p-1-job-1", "job-1"]);
  });
});

describe("editJob — a transfer that cannot be made writes nothing", () => {
  // Every failure returns before a single write is produced, so there is no half-applied
  // state: a job can never leave one member without landing on the other.
  it("refuses an unknown target owner", () => {
    const result = editJob(household(), PRIMARY_PERSON_ID, "job-1", draftFor(ALEX_BIRTH_YEAR, richJob, { ownerId: "p-9" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/p-9/);
    expect(result).not.toHaveProperty("writes");
  });

  it("refuses a job the named owner does not hold", () => {
    const result = editJob(household(), PRIMARY_PERSON_ID, "job-404", draftFor(ALEX_BIRTH_YEAR, richJob));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/job-404/);
  });

  it("refuses to move a job onto an id the target already holds", () => {
    // Two jobs sharing an id make their income bands ambiguous, and the loser is silently
    // dropped by the very next edit.
    const collision: Job = { ...richJob, ownerId: "p-1" };
    const result = editJob(
      household([richJob], [collision]),
      PRIMARY_PERSON_ID,
      "job-1",
      draftFor(ALEX_BIRTH_YEAR, richJob, { ownerId: "p-1" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/already holds/);
  });
});
