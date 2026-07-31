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

import type { Job, JobInput, PersonId } from "@finley/engine";
import { applyJobDraft, type JobDraft } from "./planPeople";
import type { JobOwner } from "./jobOwners";

/**
 * One change to one member's jobs, named as an intent rather than a list transform: the write
 * authority is `Projection`, which takes intents (`addJob` / `addPartnerJob`, `replaceJob` /
 * `replacePartnerJob`, `removeJob` / `removePartnerJob`) and never a list.
 * `jobWrites.ts` routes each of these to its owner's plane.
 *
 * `add` is a brand-new job and always mints. An existing job arriving from another member is a
 * `reassign` instead — a different verb, because it names an id the engine already issued and
 * must keep, and the engine performs the two-plane move itself.
 */
export type JobWrite =
  | { readonly kind: "add"; readonly owner: JobOwner; readonly job: JobInput }
  | {
      readonly kind: "replace";
      readonly owner: JobOwner;
      readonly jobId: string;
      readonly job: JobInput;
    }
  | {
      /** The job keeps `jobId` and lands on `owner`'s plane — see `Projection.reassignJob`. */
      readonly kind: "reassign";
      readonly owner: JobOwner;
      readonly jobId: string;
      readonly job: JobInput;
    }
  | { readonly kind: "remove"; readonly owner: JobOwner; readonly jobId: string };

/**
 * A job as authoring input: its `ownerId` drops away (the plane it lands on stamps it) and so
 * does its `id` — identity is the engine's, and a move names the id separately rather than
 * smuggling it through here.
 */
export function jobInputOf(job: Job): JobInput {
  const { ownerId: _owner, id: _id, ...rest } = job;
  return rest;
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
      readonly writes: readonly JobWrite[];
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
      writes: [{ kind: "replace", owner: source, jobId, job: jobInputOf(edited) }],
    };
  }

  // ONE write: the engine takes the job off the source's plane and lands it on the target's
  // under the same id, so its one-month overrides, pay changes and employer match come with it.
  // Nothing here removes and re-adds, so there is no window where the job belongs to neither.
  return {
    ok: true,
    job: edited,
    writes: [{ kind: "reassign", owner: target, jobId, job: jobInputOf(edited) }],
  };
}
