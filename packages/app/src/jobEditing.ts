/**
 * Editing the household's jobs — **owner-aware, as one domain operation**.
 *
 * Every surface that changes a job goes through here: the Jobs panel (standing pay, spans,
 * deferral, who owns it) and the Base + Adjustments pay-change control (a bonus, a missed
 * paycheck, a raise, a cut). Each of them used to reach for `Plan.jobs` directly, which is
 * only *the primary person's* jobs — a partner's ride the `RelationshipEvent` that brought
 * them into the household, so an adjustment aimed at a partner's job silently hit nothing.
 * {@link ownedJobsOf} lists every member's jobs as one roster and {@link reviseJob} rewrites
 * any of them without the caller knowing which plane it lives on.
 *
 * A single submission of the job form can change the job's fields *and* hand the job to a
 * different household member. Those are not two edits: the salary, the ages, and the owner
 * are all fields of one form, applied to one job, at one moment. Treating them separately is
 * what broke reassignment — the job was removed from one member and a *new* job minted on
 * the other, so it came out with a fresh id and without its one-month overrides, its
 * permanent pay changes, or its employer match.
 *
 * So {@link editJob} works from the **existing full {@link Job}** ({@link applyJobDraft}),
 * keeps its id, resolves the draft's ages against whichever owner now holds it, and returns
 * the *complete* set of list rewrites the edit implies — one per member whose jobs change.
 * Nothing is written here: every check runs first, and a failure returns no writes at all, so
 * a rejected edit cannot leave a job removed from one member and missing from the other.
 * Committing the writes is the caller's job (the Jobs panel), which is where the two
 * authoring planes — `Plan.jobs` and a partner's `RelationshipEvent` — are known.
 *
 * Pure over the {@link JobOwner} list, so it is unit-testable without React.
 */

import type { Job, PersonId } from "@finley/engine";
import { applyJobDraft, type JobDraft } from "./planPeople";
import type { JobOwner } from "./jobOwners";

/**
 * One member's job list, rewritten. `revise` is a pure transform rather than a finished
 * list so the caller can apply it as a *functional* state update — two edits in one tick
 * compose instead of the second discarding the first.
 */
export interface JobListWrite {
  readonly owner: JobOwner;
  readonly revise: (jobs: readonly Job[]) => readonly Job[];
}

/**
 * The whole outcome of one edit: every list that must change, or why nothing can. A
 * transfer carries **two** writes (the target gaining the job, the source losing it) that
 * are only ever committed together.
 */
export type JobEditResult =
  | {
      readonly ok: true;
      /** The edited job itself — same id, new fields, whichever owner now holds it. */
      readonly job: Job;
      readonly writes: readonly JobListWrite[];
    }
  | { readonly ok: false; readonly reason: string };

/** One job together with the member who holds it — a row of the household's job roster. */
export interface OwnedJob {
  readonly owner: JobOwner;
  readonly job: Job;
  /** The job's own title: its name, else its position among ITS OWNER's jobs ("Job 2"). */
  readonly title: string;
  /**
   * The title as it must read *across the household*. With a second earner the owner is
   * named ("Sam · Job 1"), since two members' jobs can carry the same title — and often do,
   * both being unnamed. On a single-earner plan that prefix would be noise, so it stays off.
   */
  readonly label: string;
}

/**
 * Every job in the household, in join order — the primary person's first, then each
 * partner's. The one place a job's display title is derived, so the Jobs panel's rows, the
 * pay-change job picker, and the confirmation notes all name a job identically.
 */
export function ownedJobsOf(owners: readonly JobOwner[]): readonly OwnedJob[] {
  const severalOwners = owners.length > 1;
  return owners.flatMap((owner) =>
    owner.jobs.map((job, i) => {
      const title = job.name?.trim() || `Job ${i + 1}`;
      return { owner, job, title, label: severalOwners ? `${owner.name} · ${title}` : title };
    }),
  );
}

/**
 * Rewrite one job wherever it lives in the household — the owner-aware counterpart to a
 * `plan.jobs.map(...)`. `revise` is handed the whole existing {@link Job} and returns its
 * replacement, so overrides, pay changes and every other field survive by default; the
 * returned write goes to whichever plane that job's owner is authored on.
 *
 * Nothing is written here (see {@link editJob}): an unknown job returns no writes at all.
 */
export function reviseJob(
  owners: readonly JobOwner[],
  jobId: string,
  revise: (job: Job) => Job,
): JobEditResult {
  const found = ownedJobsOf(owners).find((o) => o.job.id === jobId);
  if (found === undefined) return { ok: false, reason: `no job "${jobId}" in this household` };
  const revised = revise(found.job);
  return {
    ok: true,
    job: revised,
    writes: [
      { owner: found.owner, revise: (jobs) => jobs.map((j) => (j.id === jobId ? revised : j)) },
    ],
  };
}

/**
 * Apply `draft` to the job `jobId` currently held by `sourceOwnerId`.
 *
 * When the draft names the same owner the job is replaced in place. When it names another
 * member the *same* job object — id, overrides, pay changes, employer match and all — moves
 * across: dropped from the source's list and appended to the target's, with its start and
 * end ages re-read against the target's birth year.
 */
export function editJob(
  owners: readonly JobOwner[],
  sourceOwnerId: PersonId,
  jobId: string,
  draft: JobDraft,
): JobEditResult {
  const source = owners.find((o) => o.id === sourceOwnerId);
  if (source === undefined) return { ok: false, reason: `no household member "${sourceOwnerId}"` };

  const existing = source.jobs.find((j) => j.id === jobId);
  if (existing === undefined) {
    return { ok: false, reason: `${source.name} holds no job "${jobId}"` };
  }

  const target = owners.find((o) => o.id === draft.ownerId);
  if (target === undefined) {
    return { ok: false, reason: `no household member "${draft.ownerId}" to own this job` };
  }

  // Built ONCE, from the full existing job, against the new owner's clock — the same
  // object is what leaves the source list and what lands in the target's.
  const edited = applyJobDraft(existing, target.birthYear, draft);

  if (target.id === source.id) {
    return {
      ok: true,
      job: edited,
      writes: [{ owner: source, revise: (jobs) => jobs.map((j) => (j.id === jobId ? edited : j)) }],
    };
  }

  // Ids are minted per owner (`job-N` / `p-1-job-N`), so a moved job cannot collide with
  // the target's own — but the job keeps its id across the move, so this is checked rather
  // than assumed: two jobs sharing an id would make the income bands ambiguous.
  if (target.jobs.some((j) => j.id === edited.id)) {
    return { ok: false, reason: `${target.name} already holds a job "${edited.id}"` };
  }

  return {
    ok: true,
    job: edited,
    writes: [
      { owner: target, revise: (jobs) => [...jobs, edited] },
      { owner: source, revise: (jobs) => jobs.filter((j) => j.id !== jobId) },
    ],
  };
}
