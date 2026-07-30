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
 * Which plane a member's jobs are authored on — the name of a plane, not a handle to it.
 *
 * It used to carry the `RelationshipEvent` itself, which was both stale by construction (a
 * snapshot of the ledger at the last render) and an invitation to rebuild `person.jobs` from
 * it. `Projection` finds the event by person id at write time; a caller only needs to know
 * which of its two families of job methods to call.
 */
export type JobWriteTarget = "plan" | "event";

export interface JobOwner {
  readonly id: PersonId;
  readonly name: string;
  readonly birthYear: number;
  /**
   * The age *their* open-ended jobs stop at, not the household's. It bounds their 401(k)
   * deferral years, and the elective limit is per person, so the deferral scan needs each
   * earner's own working span.
   */
  readonly retirementTargetAge: number;
  readonly jobs: readonly Job[];
  /** `-Infinity` for the primary person. */
  readonly startMonth: number;
  /** The month a separation removed them; `null` while still a member. */
  readonly endMonth: number | null;
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
      retirementTargetAge: m.person.retirementTargetAge,
      jobs: m.person.jobs,
      startMonth: m.startMonth,
      endMonth: m.endMonth,
      writeTarget: joinedByEvent && event ? "event" : "plan",
    });
  }
  return owners;
}
