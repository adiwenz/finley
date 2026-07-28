/**
 * Committing job-list rewrites to the two authoring planes.
 *
 * A member's jobs live on one of two planes: the primary person's are standing plan data
 * (`Plan.jobs`), a partner's ride the `RelationshipEvent` that brought them into the
 * household. Every writing surface needs the same routing, so it lives here once rather
 * than re-derived — differently, and eventually wrongly — in each panel.
 *
 * **Atomic across the planes.** One edit can rewrite two members' lists (moving a job
 * between them) that sit on different planes. So the ledger side goes first as one
 * all-or-nothing batch, and the plan side only if accepted: a conflict can't land half an
 * edit, leaving a job removed from one member and missing from the other.
 */

import type { Dispatch, SetStateAction } from "react";
import type { Plan } from "@finley/engine";
import type { JobListWrite } from "./jobEditing";
import type { EventRevision } from "./hooks/useLedger";

/** Where the two planes are actually written — the app's state setters. */
export interface JobWriteTargets {
  readonly setBudget: Dispatch<SetStateAction<Plan>>;
  /** Revise ledger events in one all-or-nothing write; `false` = rejected, nothing changed. */
  readonly onReviseEvents: (revisions: readonly EventRevision[]) => boolean;
}

/**
 * Commit job-list rewrites, each to whichever plane its owner is authored on. Returns
 * whether it committed — `false` leaves **both** planes exactly as they were.
 *
 * Plan writes revise the LATEST plan (functional update), so two edits in one tick compose
 * instead of discarding each other.
 */
export function commitJobWrites(
  writes: readonly JobListWrite[],
  { setBudget, onReviseEvents }: JobWriteTargets,
): boolean {
  const revisions: EventRevision[] = [];
  for (const { owner, revise } of writes) {
    if (owner.writeTarget.kind !== "event") continue;
    const event = owner.writeTarget.event;
    revisions.push({
      id: event.id,
      next: { ...event, person: { ...event.person, jobs: [...revise(event.person.jobs)] } },
    });
  }
  if (revisions.length > 0 && !onReviseEvents(revisions)) return false;
  for (const { owner, revise } of writes) {
    if (owner.writeTarget.kind === "plan") {
      setBudget((current) => ({ ...current, jobs: [...revise(current.jobs)] }));
    }
  }
  return true;
}
