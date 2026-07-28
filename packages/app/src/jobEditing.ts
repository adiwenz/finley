/**
 * Owner-aware job editing. `Plan.jobs` holds only the primary person's jobs; a partner's ride
 * the `RelationshipEvent` that brought them into the household, so reaching for `Plan.jobs`
 * directly misses partners.
 *
 * One form submission can change fields *and* hand the job to another member, as one edit:
 * splitting them minted a *new* job, losing its id, one-month overrides, permanent pay changes
 * and employer match. {@link editJob} works from the existing {@link Job}, keeps its id, and
 * resolves the draft's ages against the new owner.
 *
 * Nothing is written here: checks run first and a failure returns no writes, so a rejected
 * edit cannot leave a job in neither list. The caller commits.
 */

import type { Job, PersonId } from "@finley/engine";
import { applyJobDraft, type JobDraft } from "./planPeople";
import type { JobOwner } from "./jobOwners";

/**
 * One member's job list, rewritten. `revise` is a pure transform rather than a finished
 * list so the caller can apply it as a *functional* state update — two edits in one tick
 * then compose instead of the second discarding the first.
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
      /** Same id, new fields, whichever owner now holds it. */
      readonly job: Job;
      readonly writes: readonly JobListWrite[];
    }
  | { readonly ok: false; readonly reason: string };

export interface OwnedJob {
  readonly owner: JobOwner;
  readonly job: Job;
  /** The job's own title: its name, else its position among ITS OWNER's jobs ("Job 2"). */
  readonly title: string;
  /**
   * The title as it must read *across the household*. With a second earner the owner is
   * named ("Sam · Job 1"), since two members' jobs can share a title — and often do, both
   * being unnamed. On a single-earner plan that prefix stays off.
   */
  readonly label: string;
}

/**
 * Every job in the household, in join order — the primary person's first, then each
 * partner's. The one place a display title is derived, so every surface names a job
 * identically.
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
 * Rewrite one job wherever it lives in the household — the owner-aware counterpart to
 * `plan.jobs.map(...)`. `revise` gets the whole existing {@link Job}, so overrides, pay
 * changes and every other field survive by default.
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
 * Same owner: replaced in place. Another member: the *same* job object — id, overrides, pay
 * changes, employer match and all — moves across, its start/end ages re-read against the
 * target's birth year.
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
  // object leaves the source list and lands in the target's.
  const edited = applyJobDraft(existing, target.birthYear, draft);

  if (target.id === source.id) {
    return {
      ok: true,
      job: edited,
      writes: [{ owner: source, revise: (jobs) => jobs.map((j) => (j.id === jobId ? edited : j)) }],
    };
  }

  // Ids are minted per owner (`job-N` / `p-1-job-N`), so a moved job should not collide —
  // but it keeps its id across the move, and two jobs sharing an id would make the income
  // bands ambiguous.
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
