/**
 * Owner-aware job editing. `Plan.jobs` holds only the primary person's jobs; a partner's ride
 * the `RelationshipEvent` that brought them into the household, so reaching for `Plan.jobs`
 * directly misses partners.
 *
 * A job belongs to the member it was added for and cannot be handed to another: moving one
 * re-reads every age against a different birth year, which shifts the job's whole calendar and
 * strands the pay changes falling outside the new span — more than one form submission can
 * honestly model. Delete it and add it to the other member instead. {@link editJob} therefore
 * works from the existing {@link Job}, keeping its id, overrides, pay changes and employer
 * match, none of which the form shows.
 *
 * Nothing is written here: checks run first and a failure returns no writes, so a rejected
 * edit cannot leave a job in neither list. The caller commits.
 */

import type { Job, JobInput, JobPayChange, PersonId } from "@finley/engine";
import { applyJobDraft, type JobDraft } from "./planPeople";
import type { JobOwner } from "./jobOwners";

/**
 * One change to one member's jobs, named as an intent rather than a list transform: the write
 * authority is `Projection`, which takes intents (`addJob` / `addPartnerJob`, `replaceJob` /
 * `replacePartnerJob`, `removeJob` / `removePartnerJob`) and never a list.
 * `jobWrites.ts` routes each of these to its owner's plane.
 *
 * `add` is a brand-new job and always mints; `replace` names an id the engine already issued
 * and keeps it. Every write names one member, because a job stays with the member it was
 * added for — no write here crosses between two.
 */
export type JobWrite =
  | { readonly kind: "add"; readonly owner: JobOwner; readonly job: JobInput }
  | {
      readonly kind: "replace";
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

/** The whole outcome of one edit: every list that must change, or why nothing can. */
export type JobEditResult =
  | {
      readonly ok: true;
      /** Same id, new fields, whichever owner now holds it. */
      readonly job: Job;
      readonly writes: readonly JobWrite[];
      /**
       * Pay changes the edit dropped because they now predate the job's start — see
       * {@link applyJobDraft}. Empty on an edit that strands nothing; a caller that ignores
       * this loses an authored fact without saying so.
       */
      readonly strandedPayChanges: readonly JobPayChange[];
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
 * Apply `draft` to the job `jobId` held by `sourceOwnerId`, replacing it in place. The owner is
 * not among the things an edit may change — see this module's note.
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

  // A job's owner is settled when it is added and never afterwards, so a draft naming someone
  // else is a caller bug rather than a request — the form does not offer the choice. Refusing
  // is what lets `applyJobDraft` read every age against the one birth year below.
  if (draft.ownerId !== source.id) {
    return {
      ok: false,
      reason: `a job's owner cannot be changed — "${jobId}" is ${source.name}'s`,
    };
  }

  // Built from the full existing job, so its id, one-month overrides, pay changes and employer
  // match survive an edit that only ever sees a handful of fields.
  const { job: edited, strandedPayChanges } = applyJobDraft(existing, source.birthYear, draft);

  return {
    ok: true,
    job: edited,
    strandedPayChanges,
    writes: [{ kind: "replace", owner: source, jobId, job: jobInputOf(edited) }],
  };
}
