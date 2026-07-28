/**
 * Who in the household can own a job, and where that person's jobs are authored.
 *
 * The two members' job arrays live on different planes: the primary person's are standing
 * plan data (`Plan.jobs`, the value-editing plane), a partner's ride the
 * `RelationshipEvent` that brought them into the household (the ledger). The Jobs panel
 * gets one uniform list of owners instead, each with a `writeTarget` naming the plane to
 * write back to.
 */

import type { Household, Ledger, Job, PersonId, RelationshipEvent } from "@finley/engine";

export type JobWriteTarget =
  /** The standing plan (`Plan.jobs`) — the primary person, always in the household. */
  | { readonly kind: "plan" }
  /** The `RelationshipEvent` a partner joined with; their jobs ride its `person`. */
  | { readonly kind: "event"; readonly event: RelationshipEvent };

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
      writeTarget: joinedByEvent && event ? { kind: "event", event } : { kind: "plan" },
    });
  }
  return owners;
}
