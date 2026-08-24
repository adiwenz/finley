/**
 * **One partnership at a time.** A household may have any number of partners across the plan,
 * but never two at once: their spans have to sit end to end.
 *
 * The model has no vocabulary for a second simultaneous partner and never had. Every
 * person-scoped rule downstream — whose income funds the household, whose accounts leave at a
 * separation, whose tax settles in April, which member the horizon reaches for — reads an
 * ownership that names one partner. Two overlapping ones do not make those rules wrong so much
 * as ambiguous: the shared-obligation split would weight three earners against a budget authored
 * for two, and a "which partner?" picker would appear in surfaces whose whole design assumes
 * there is nothing to pick. So the constraint lives here, at the ledger, where every authoring
 * path already passes.
 *
 * **A span, not a moment.** The question is never "is somebody partnered on this date" but "do
 * these two relationships overlap at all" — which is the only form that catches a partnership
 * authored BEFORE one already on the timeline and left to run into it. Both directions are the
 * same overlap, checked once.
 *
 * **What ends a partnership.** A separation, and death. Both close the span, so partnering again
 * the month a partner leaves or the month one dies is allowed — the ends are exclusive, which is
 * what makes "separate in March, partner again in March" legal in that order and nothing else.
 * Death is read from the partner's own expectancy rather than recorded anywhere, so raising it
 * lengthens the span and can collide with a partnership already booked behind it; that edit is
 * refused by this same rule, on replay, with nothing special written for it.
 */

import type { InterpretState } from "./interpretState";
import type { HouseholdMembership } from "./household";
import type { Person } from "../plan/person";
import { lifeExpectancyEndMonthExclusive } from "../job/personActiveWindow";
import { yearOfMonth } from "../authoring/reachability";

/**
 * One partner's stretch of household membership: from the month they joined to the first month
 * they are gone, by separation or death, whichever comes first.
 */
export interface PartnershipSpan {
  /**
   * Absent for a partner not yet minted — the write-time refusal asks about a person the very
   * call it guards is about to create, so there is no id to name them by yet. Only used to keep a
   * span from conflicting with itself, which a person who does not exist cannot do.
   */
  readonly personId?: string;
  readonly name: string;
  readonly startMonth: number;
  /** First month the partnership is over — so a span ending here and one starting here do not overlap. */
  readonly endMonthExclusive: number;
}

/**
 * The span a partnership occupies. `separationMonth` is already exclusive (the first month they
 * are no longer a member), so it needs no adjustment to sit beside the death month.
 */
export function partnershipSpan(
  person: Pick<Person, "name" | "birthYear" | "lifeExpectancy"> & { readonly id?: string },
  startMonth: number,
  separationMonth: number | null,
  nowYear: number | undefined,
): PartnershipSpan {
  return {
    ...(person.id === undefined ? {} : { personId: person.id }),
    name: person.name,
    startMonth,
    endMonthExclusive: Math.min(
      separationMonth ?? Number.POSITIVE_INFINITY,
      lifeExpectancyEndMonthExclusive(person, nowYear),
    ),
  };
}

/**
 * Every partnership the replay state holds. Base members are excluded by their infinite start —
 * the primary is not somebody the primary is partnered WITH, and they are the only member seeded
 * without a joining month ({@link import("./interpret").seedState}).
 */
export function partnershipSpans(
  state: InterpretState,
  nowYear: number | undefined,
): PartnershipSpan[] {
  const spans: PartnershipSpan[] = [];
  for (const membership of state.personsById.values()) {
    if (!Number.isFinite(membership.startMonth)) continue;
    spans.push(
      partnershipSpan(membership.person, membership.startMonth, membership.endMonth, nowYear),
    );
  }
  return spans;
}

/**
 * The partnership `candidate` collides with, or `null` when it sits clear of all of them.
 *
 * A span never conflicts with itself, so a revision that re-dates an existing partnership is
 * measured against the others alone rather than against the version it replaces.
 */
export function overlappingPartnership(
  spans: readonly PartnershipSpan[],
  candidate: PartnershipSpan,
): PartnershipSpan | null {
  for (const span of spans) {
    if (candidate.personId !== undefined && span.personId === candidate.personId) continue;
    if (candidate.startMonth < span.endMonthExclusive && span.startMonth < candidate.endMonthExclusive) {
      return span;
    }
  }
  return null;
}

/** A month as the reader authored it — the calendar year, or the raw month with no "now" to place it on. */
function when(month: number, nowYear: number | undefined): string {
  return nowYear === undefined ? `month ${month}` : `${yearOfMonth(nowYear, month)}`;
}

/**
 * Why the overlap is refused, in the reader's own terms — and, crucially, WHICH partnership is in
 * the way, since the two cases are fixed by different edits.
 *
 * A conflict that already started is a partnership the reader is currently in: the fix is to end
 * it. A conflict still ahead is one the candidate would run into: the fix is to end the CANDIDATE
 * before it, or move it. Naming the year of the offending relationship rather than of the
 * candidate is what makes the second sentence actionable.
 */
export function partnershipConflictReason(
  candidate: PartnershipSpan,
  conflict: PartnershipSpan,
  nowYear: number | undefined,
): string {
  const who = conflict.name.trim() || "your partner";
  return conflict.startMonth <= candidate.startMonth
    ? `you're already partnered with ${who} in ${when(candidate.startMonth, nowYear)}. ` +
        `Add a separation first or choose a later date`
    : `this partnership would still be running when you partner with ${who} in ` +
        `${when(conflict.startMonth, nowYear)}. Add a separation before then or choose a later date`;
}

/**
 * The same spans as {@link partnershipSpans}, read off the interpreted {@link Household} instead
 * of the replay accumulator — the shape every surface outside interpretation holds. Kept beside
 * its twin so a form asking "would this collide?" and the ledger's own refusal can never answer
 * from two different notions of when a partnership runs.
 */
export function householdPartnershipSpans(
  household: { readonly memberships: readonly HouseholdMembership[] },
  nowYear: number | undefined,
): PartnershipSpan[] {
  const spans: PartnershipSpan[] = [];
  for (const membership of household.memberships) {
    if (!Number.isFinite(membership.startMonth)) continue;
    spans.push(
      partnershipSpan(membership.person, membership.startMonth, membership.endMonth, nowYear),
    );
  }
  return spans;
}
