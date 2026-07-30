/**
 * Committing job-list rewrites to the two authoring planes.
 *
 * A member's jobs live on one of two planes: the primary person's are standing plan data
 * (`Plan.jobs`), a partner's ride the `RelationshipEvent` that brought them into the
 * household. The routing lives here once rather than re-derived in each panel.
 *
 * **Atomic across the planes.** One edit can rewrite two members' lists (moving a job between
 * them) that sit on different planes, so every write goes through ONE `Projection` handle: the
 * facade throws on a refusal and the whole handle is discarded, so a conflict cannot land a job
 * removed from one member and missing from the other. The ledger side is applied first, so a
 * refusal reads the same as it did when the two planes were written in sequence.
 */

import type { Job, PersonId, RelationshipEvent } from "@finley/engine";
import type { JobWrite } from "./jobEditing";
import { nextJobIdFor } from "./planPeople";
import type { Transact } from "./hooks/useProjection";

/**
 * Apply one write to the list it targets. Only the **ledger** plane needs this: a partner's
 * jobs are a field of their `RelationshipEvent`, so the revised event has to be built whole
 * before `reviseTransaction` can be handed it. The plan plane has a facade method per intent
 * and never rebuilds a list.
 *
 * A job arriving without an id is new and is minted for; one arriving with an id is the same
 * job landing from another member, and keeps it.
 */
export function applyJobWrite(
  jobs: readonly Job[],
  write: JobWrite,
  ownerId: PersonId,
): readonly Job[] {
  switch (write.kind) {
    case "add": {
      const { id, ...rest } = write.job;
      return [...jobs, { ...rest, id: id ?? nextJobIdFor(ownerId, jobs), ownerId } as Job];
    }
    case "replace":
      return jobs.map((j) =>
        j.id === write.jobId ? ({ ...write.job, id: j.id, ownerId: j.ownerId } as Job) : j,
      );
    case "remove":
      return jobs.filter((j) => j.id !== write.jobId);
  }
}

/**
 * Returns whether it committed — `false` leaves **both** planes exactly as they were, with the
 * reason in the hook's `conflict`.
 *
 * Writes aimed at one partner are folded into a single event revision, so two changes to the
 * same member's list compose instead of the second overwriting the first off a stale event.
 */
export function commitJobWrites(writes: readonly JobWrite[], transact: Transact): boolean {
  return (
    transact((p) => {
      // Ledger plane, grouped by the event each partner's jobs ride on.
      const revised = new Map<string, { event: RelationshipEvent; jobs: readonly Job[] }>();
      for (const write of writes) {
        if (write.owner.writeTarget.kind !== "event") continue;
        const event = write.owner.writeTarget.event;
        const jobs = applyJobWrite(
          revised.get(event.id)?.jobs ?? event.person.jobs,
          write,
          write.owner.id,
        );
        revised.set(event.id, { event, jobs });
      }
      for (const { event, jobs } of revised.values()) {
        p.reviseTransaction(event.id, { ...event, person: { ...event.person, jobs: [...jobs] } });
      }

      // Plan plane — one facade method per intent, so nothing here reshapes `Plan.jobs`.
      for (const write of writes) {
        if (write.owner.writeTarget.kind !== "plan") continue;
        switch (write.kind) {
          case "add":
            p.addJob(write.owner.id, write.job);
            break;
          case "replace":
            p.replaceJob(write.jobId, write.job);
            break;
          case "remove":
            p.removeJob(write.jobId);
            break;
        }
      }
      // The transaction's own result, so a refusal (which returns `undefined`) is
      // distinguishable from a write that simply had nothing to return.
      return true;
    }) === true
  );
}
