/**
 * Who in the household can own a job, and where that person's jobs are authored.
 *
 * Earned income is per-person, but the two members' arrays live on different planes: the
 * primary person's jobs are standing plan data (`Plan.jobs`, the value-editing plane), a
 * partner's ride the `RelationshipEvent` that brought them into the household (the ledger).
 * The Jobs panel shouldn't have to know that — it gets one uniform list of owners, each
 * with a `writeTarget` naming the plane to write back to.
 *
 * A pure derivation over the already-interpreted {@link Household} plus the ledger, so it
 * is unit-testable without React.
 */

import type { Household, Ledger, Job, PersonId, RelationshipEvent } from "@finley/engine";

/** Where a member's jobs are authored — the plane an edit has to be written to. */
export type JobWriteTarget =
  /** The standing plan (`Plan.jobs`) — the primary person, always in the household. */
  | { readonly kind: "plan" }
  /** The `RelationshipEvent` a partner joined with; their jobs ride its `person`. */
  | { readonly kind: "event"; readonly event: RelationshipEvent };

/** One household member, their jobs, and the plane those jobs are authored on. */
export interface JobOwner {
  readonly id: PersonId;
  readonly name: string;
  /** The owner's birth year — every age in the Jobs form is measured against it. */
  readonly birthYear: number;
  /**
   * The age their open-ended jobs stop at — *their* retirement, not the household's. It
   * bounds their 401(k) deferral years, and the elective limit is per person, so the
   * deferral scan needs each earner's own working span.
   */
  readonly retirementTargetAge: number;
  readonly jobs: readonly Job[];
  /** The month they joined the household; `-Infinity` for the primary person. */
  readonly startMonth: number;
  /** The month they left (a separation), or `null` while still a member. */
  readonly endMonth: number | null;
  readonly writeTarget: JobWriteTarget;
}

/**
 * Every household member as a job owner, in join order (primary first). A member added by
 * an event whose `RelationshipEvent` can't be found is omitted rather than listed
 * unwritably — there is no plane to author their jobs on.
 */
export function jobOwnersOf(household: Household, ledger: Ledger): readonly JobOwner[] {
  const relationshipFor = new Map<string, RelationshipEvent>();
  for (const e of ledger.events) {
    if (e.type === "RelationshipEvent") relationshipFor.set(e.person.id, e);
  }

  const owners: JobOwner[] = [];
  for (const m of household.memberships) {
    // The primary joins with the base household (`-Infinity`) so their jobs are plan data;
    // anyone joining at a real month arrived on an event.
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
