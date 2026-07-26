/**
 * Editing one job from the Jobs form — **one domain operation** (§6, issue #118).
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
