/**
 * Who in the household can own a job, and where that person's jobs are authored
 * (§8, issue #118).
 *
 * Earned income is per-person: every household member holds their own `jobs` array. But
 * the two members' arrays live on different planes. The primary person's jobs are
 * standing plan data (`Plan.jobs`, the value-editing plane, §10.2); a partner's ride the
 * `RelationshipEvent` that brought them into the household (the ledger). The Jobs panel
 * shouldn't have to know that: it asks for the household's job owners and gets one
 * uniform list — name, birth year, jobs, and a `writeTarget` saying which plane to write
 * back to.
 *
 * Pure derivation over the already-interpreted {@link Household} plus the ledger, so it
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
  readonly jobs: readonly Job[];
  /** The month they joined the household; `-Infinity` for the primary person. */
  readonly startMonth: number;
  /** The month they left (a separation), or `null` while still a member. */
  readonly endMonth: number | null;
  readonly writeTarget: JobWriteTarget;
}

/**
 * Every member of the household as a job owner, in join order (the primary person
 * first). A member added by an event but whose `RelationshipEvent` cannot be found is
 * omitted rather than listed unwritably — there is no plane to author their jobs on.
 */
export function jobOwnersOf(household: Household, ledger: Ledger): readonly JobOwner[] {
  const relationshipFor = new Map<string, RelationshipEvent>();
  for (const e of ledger.events) {
    if (e.type === "RelationshipEvent") relationshipFor.set(e.person.id, e);
  }

  const owners: JobOwner[] = [];
  for (const m of household.memberships) {
    // The primary joins with the base household (`-Infinity`), so their jobs are plan
    // data; anyone who joined at a real month arrived on an event.
    const joinedByEvent = Number.isFinite(m.startMonth);
    const event = relationshipFor.get(m.person.id);
    if (joinedByEvent && event === undefined) continue;
    owners.push({
      id: m.person.id,
      name: m.person.name,
      birthYear: m.person.birthYear,
      jobs: m.person.jobs,
      startMonth: m.startMonth,
      endMonth: m.endMonth,
      writeTarget: joinedByEvent && event ? { kind: "event", event } : { kind: "plan" },
    });
  }
  return owners;
}
