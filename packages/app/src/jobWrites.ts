/**
 * Committing job-list rewrites to the two authoring planes.
 *
 * A member's jobs live on one of two planes: the primary person's are standing plan data
 * (`Plan.jobs`), a partner's ride the `RelationshipEvent` that brought them into the
 * household. Which plane is a fact about the member, so the routing lives here once rather
 * than being re-derived in each panel — but it is only routing. Both planes are facade
 * methods; nothing here builds a job list, and nothing here mints an id.
 *
 * **Atomic across the planes.** One edit can rewrite two members' lists, so every write goes
 * through ONE `Projection` handle: the facade throws on a refusal and the whole handle is
 * discarded, so a conflict cannot land a job removed from one member and missing from the other.
 * A move between members is a single `reassign` — the facade owns both halves of it, since only
 * the engine may say what a relocated job's id is.
 */

import type { JobWrite } from "./jobEditing";
import type { Transact } from "./hooks/useProjection";

/** Whether this owner's jobs are authored on the plan rather than on their own event. */
const onPlan = (write: JobWrite): boolean => write.owner.writeTarget === "plan";

export function commitJobWrites(writes: readonly JobWrite[], transact: Transact): boolean {
  return (
    transact((p) => {
      // Removals first, so a list rewritten down and up in one edit lets go before it lands.
      // A cross-member move is no longer among these — `reassign` does both halves inside the
      // facade — so the ordering matters only to edits that genuinely remove.
      for (const write of writes) {
        if (write.kind !== "remove") continue;
        if (onPlan(write)) p.removeJob(write.jobId);
        else p.removePartnerJob(write.jobId);
      }

      for (const write of writes) {
        switch (write.kind) {
          case "add":
            if (onPlan(write)) p.addJob(write.owner.id, write.job);
            else p.addPartnerJob(write.owner.id, write.job);
            break;
          case "replace":
            if (onPlan(write)) p.replaceJob(write.jobId, write.job);
            else p.replacePartnerJob(write.jobId, write.job);
            break;
          case "reassign":
            // Plane-agnostic: the engine finds where the job is and where the owner keeps
            // theirs, so this is the one job write that does not route on `writeTarget`.
            p.reassignJob(write.jobId, write.owner.id, write.job);
            break;
          case "remove":
            break; // already applied above
        }
      }
      // The transaction's own result, so a refusal (which returns `undefined`) is
      // distinguishable from a write that simply had nothing to return.
      return true;
    }) === true
  );
}
