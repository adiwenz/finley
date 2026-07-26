/**
 * Editing a job as ONE operation (§6, issue #118) — fields and owner in a single form
 * submission.
 *
 * The regression these pin: reassigning used to remove the job from one member and *mint* a
 * new one on the other from the form draft alone, so the job came back with a fresh id and
 * without its one-month overrides, its permanent pay changes, or its employer match — all
 * of which the form never shows and therefore cannot carry. An edit works from the existing
 * full {@link Job} instead, and either resolves completely or writes nothing.
 */

import { describe, it, expect } from "vitest";
import { PRIMARY_PERSON_ID, type Job } from "@finley/engine";
import { editJob } from "./jobEditing";
import type { JobOwner } from "./jobOwners";
import { jobToDraftFor, type JobDraft } from "./planPeople";

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
  writeTarget: { kind: "plan" },
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
      // Stands for the partner's plane; `editJob` is plane-agnostic, so a stub event is
      // enough here — the Jobs panel is where the two planes are actually written.
      writeTarget: { kind: "event", event: { id: "r1" } as never },
    }),
  ];
}

/** The draft the edit form would submit for `job`, with `over` typed into its fields. */
const draftFor = (birthYear: number, job: Job, over: Partial<JobDraft> = {}): JobDraft => ({
  ...jobToDraftFor(birthYear, job),
  ...over,
});

/** Apply an edit's writes to the owners it names, giving each member's resulting job list. */
function applied(result: ReturnType<typeof editJob>): Map<string, readonly Job[]> {
  if (!result.ok) throw new Error(`expected an editable job: ${result.reason}`);
  const lists = new Map<string, readonly Job[]>();
  for (const { owner: o, revise } of result.writes) lists.set(o.id, revise(o.jobs));
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
    // Gone from Alex, on Sam — one job in the household, not zero and not two.
    expect(lists.get(PRIMARY_PERSON_ID)).toEqual([]);
    const moved = lists.get("p-1")!;
    expect(moved).toHaveLength(1);
    expect(moved[0].ownerId).toBe("p-1");
    // The salary edited in the same submission landed with the move.
    expect(moved[0].salary.startingSalaryCents).toBe(9_000_00 * 12);
  });

  it("keeps the job's id across the move", () => {
    const owners = household();
    const moved = applied(
      editJob(owners, PRIMARY_PERSON_ID, "job-1", draftFor(ALEX_BIRTH_YEAR, richJob, { ownerId: "p-1" })),
    ).get("p-1")!;

    // A minted id would be `p-1-job-1` — and every band, override and pay change keyed to
    // `job-1` would be orphaned by the rename.
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
  // The failure cases all return before a single write is produced, so there is no
  // half-applied state to clean up: a job can never be removed from one member without
  // landing on the other.
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
    // Two jobs sharing an id would make their income bands ambiguous — and the loser
    // would be silently dropped by the very next edit.
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
