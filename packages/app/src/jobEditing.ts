/**
 * Owner-aware job editing. `Plan.jobs` holds only the primary person's jobs; a partner's ride
 * the `RelationshipEvent` that brought them into the household, so reaching for `Plan.jobs`
 * directly misses partners.
 *
 * A job belongs to the member it was added for and cannot be handed to another: moving one
 * re-reads every age against a different birth year, which shifts the job's whole calendar and
 * strands the pay changes falling outside the new span — more than one form submission can
 * honestly model, and a correction would have to be an explicit transfer operation that reviews
 * those consequences. None exists: delete the job and add it to the other member instead.
 *
 * So {@link addJob} names the owner and {@link editJob} derives it, working from the existing
 * {@link Job} to keep its id, overrides, pay changes and employer match — none of which the
 * form shows, so none of which a draft could carry.
 *
 * Nothing is written here: checks run first and a failure returns no writes, so a rejected
 * edit cannot leave a job in neither list. The caller commits.
 */

import type { Job, JobInput, JobPayChange, PersonId } from "@finley/engine";
import { applyJobDraft, jobInputFromDraft, type JobEditDraft } from "./planPeople";
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

/**
 * The whole outcome of one add or edit: every list that must change, or why nothing can.
 * Shared by {@link addJob} and {@link editJob}, which differ only in whether the owner is
 * chosen or derived — everything downstream of that treats the two identically.
 */
export type JobEditResult =
  | {
      readonly ok: true;
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
 * Create a job for `ownerId`, from a draft that names them. The owner is chosen HERE and
 * nowhere else — {@link editJob} takes a draft with no owner to choose from, so this is the
 * only moment in a job's life when the question is open.
 *
 * The facade mints the id and stamps the owner from the member the job is added for; nothing
 * about ownership travels inside the {@link JobInput}.
 */
export function addJob(
  owners: readonly JobOwner[],
  ownerId: PersonId,
  draft: JobEditDraft,
): JobEditResult {
  const target = owners.find((o) => o.id === ownerId);
  if (target === undefined) {
    return { ok: false, reason: `no household member "${ownerId}" to own this job` };
  }
  return {
    ok: true,
    // Ages resolve against the owner being created for — the same clock every later edit reads.
    writes: [{ kind: "add", owner: target, job: jobInputFromDraft(target.birthYear, draft) }],
    // A new job carries no pay changes, so an add can strand none.
    strandedPayChanges: [],
  };
}

/**
 * Apply `draft` to the job `jobId`, replacing it in place.
 *
 * The owner is **derived**, not supplied: whoever holds `jobId` holds it after the edit too, and
 * their birth year is the clock every age in the draft is read against. A {@link JobEditDraft}
 * carries no owner, so there is nothing here to reconcile and no way to name a second person.
 */
export function editJob(
  owners: readonly JobOwner[],
  jobId: string,
  draft: JobEditDraft,
): JobEditResult {
  const holder = owners.find((o) => o.jobs.some((j) => j.id === jobId));
  if (holder === undefined) {
    return { ok: false, reason: `no job "${jobId}" in this household` };
  }
  const existing = holder.jobs.find((j) => j.id === jobId)!;

  // Built from the full existing job, so its id, one-month overrides, pay changes and employer
  // match survive an edit that only ever sees a handful of fields.
  const { job: edited, strandedPayChanges } = applyJobDraft(existing, holder.birthYear, draft);

  return {
    ok: true,
    writes: [{ kind: "replace", owner: holder, jobId, job: jobInputOf(edited) }],
    strandedPayChanges,
  };
}
