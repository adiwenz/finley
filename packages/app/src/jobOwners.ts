/**
 * Who in the household can own a job, and where that person's jobs are authored.
 *
 * The two members' job arrays live on different planes: the primary person's are standing
 * plan data (`Plan.jobs`, the value-editing plane), a partner's ride the
 * `RelationshipEvent` that brought them into the household (the ledger). The Jobs panel
 * gets one uniform list of owners instead, each with a `writeTarget` naming the plane its
 * jobs are written on.
 */

import type { Household, Ledger, Job, PersonId, RelationshipEvent } from "@finley/engine";

/**
 * Which plane a member's jobs are authored on — the name of a plane, not a handle to one. A
 * caller only needs to know which of `Projection`'s two families of job methods to call;
 * `Projection` finds the `RelationshipEvent` by person id at write time, off the state it is
 * committing against rather than a snapshot from the last render.
 */
export type JobWriteTarget = "plan" | "event";

export interface JobOwner {
  readonly id: PersonId;
  readonly name: string;
  readonly birthYear: number;
  readonly jobs: readonly Job[];
  /**
   * `-Infinity` for the primary person — the one thing this list reads it for is which plane a
   * member's jobs are authored on.
   *
   * There is deliberately no `endMonth` beside it. A separation's effect on what a household is
   * paid is the engine's to state (`ProjectionResult.jobPayDisplay`), and carrying the month
   * here is how the app came to answer that question twice.
   */
  readonly startMonth: number;
  readonly writeTarget: JobWriteTarget;
}

/**
 * Every household member as a job owner, in join order (primary first). A member whose
 * `RelationshipEvent` can't be found is omitted rather than listed unwritably.
 */
export function jobOwnersOf(household: Household, ledger: Ledger): readonly JobOwner[] {
  const relationshipFor = new Map<string, RelationshipEvent>();
  for (const e of ledger.events) {
    if (e.type === "RelationshipEvent") relationshipFor.set(e.person.id, e);
  }

  const owners: JobOwner[] = [];
  for (const m of household.memberships) {
    // The primary joins with the base household (`-Infinity`); anyone joining at a real
    // month arrived on an event.
    const joinedByEvent = Number.isFinite(m.startMonth);
    const event = relationshipFor.get(m.person.id);
    if (joinedByEvent && event === undefined) continue;
    owners.push({
      id: m.person.id,
      name: m.person.name,
      birthYear: m.person.birthYear,
      jobs: m.person.jobs,
      startMonth: m.startMonth,
      writeTarget: joinedByEvent && event ? "event" : "plan",
    });
  }
  return owners;
}
