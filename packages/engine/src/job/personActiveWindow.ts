/**
 * **When is a person still doing things?** — the one window every person-scoped rule in the
 * engine is clipped by, so no subsystem has to remember death on its own.
 *
 * Two facts close it, authored in different places and previously applied in different places:
 *
 * - **membership** — a partner's money is this household's only between joining and separating;
 *   the primary is a member throughout;
 * - **death** — the exclusive month `birthYear + lifeExpectancy` lands on.
 *
 * They used to be separate bounds with separate reach. Membership clipped wages and — once a
 * benefit became membership-bound too — the benefit; the expectancy clipped ONLY the benefit, by
 * a second check written beside the first. So a job went on paying a household for years after
 * its owner had died, the raise they were authored to get at 95 landed, and the income chart drew
 * all of it, while that same person's Social Security had already stopped. One window, computed
 * once here, is what makes those two answers the same answer.
 *
 * **What is NOT in this window.** Household spending. A survivor is funded at full cost to the
 * end of the horizon: the household does not step its costs down when a member dies, which is
 * conservative rather than dangerous, and is why this is a *person* window and not a household
 * one. The horizon itself is not in it either — see {@link memberHorizonReach}, which asks the
 * opposite question ("how far must the run reach to cover this member?").
 */

import type { Person } from "../plan/person";
import type { HouseholdMembership } from "../ledger/household";

/**
 * A half-open span of months relative to "now" — `startMonth` inclusive,
 * `endMonthExclusive` the first month outside it. Either end may be infinite: a person with no
 * membership record and no reckonable death is unbounded in both directions, which is the shape
 * every single-earner plan has.
 */
export interface PersonActiveWindow {
  readonly startMonth: number;
  readonly endMonthExclusive: number;
}

/**
 * The exclusive month a person's own life ends — the first month they are gone.
 *
 * Derived from their birth year and their own expectancy age against the plan's frozen "now".
 * No fallback and no inheritance: {@link import("../plan/person").Person.lifeExpectancy} is
 * required, so the person being asked about always states one. The primary's expectancy is a
 * default offered at `marry`, never a value read through to from here.
 *
 * `nowYear` may be absent, and then the answer is `+Infinity` rather than a number. A life-end is
 * a birth year plus an age placed on the calendar, so it needs a real frozen "now" — only a
 * hand-built test base is ever without one, and reckoning against a `0` fallback would put the
 * death two thousand years out and drag every window and the horizon with it. Unbounded is the
 * honest answer: with no calendar to place them on, nobody's death bounds anything.
 */
export function lifeExpectancyEndMonthExclusive(
  person: Pick<Person, "birthYear" | "lifeExpectancy">,
  nowYear: number | undefined,
): number {
  if (nowYear === undefined) return Number.POSITIVE_INFINITY;
  // Clamped at 0: a person already past their expectancy at "now" contributes no forward months
  // rather than a negative window.
  return Math.max(0, (person.birthYear + person.lifeExpectancy - nowYear) * 12);
}

/**
 * A membership's window alone — joining to separating, open-ended where it is, and saying
 * nothing about death.
 *
 * Kept separate from {@link personActiveWindow} because the horizon rule needs the two facts
 * apart: whether a separation counts at all depends on where it falls against the deaths
 * ({@link memberHorizonReach}), which an already-intersected window cannot answer.
 */
export function membershipWindow(membership: HouseholdMembership): PersonActiveWindow {
  return {
    startMonth: membership.startMonth,
    // `endMonth` is the separation month — the first month they are NO LONGER a member — so it
    // is already exclusive. `null` means still a member, i.e. no end at all.
    endMonthExclusive: membership.endMonth ?? Number.POSITIVE_INFINITY,
  };
}

/**
 * **THE window.** Membership ∩ life: this person is doing things from the month they join until
 * the earlier of leaving and dying.
 *
 * Everything person-scoped reads it. A job's employment ends here or where it was authored to,
 * whichever is sooner ({@link import("./householdJob").resolveHouseholdJob}); a raise, a bonus or a
 * missed paycheck dated outside it is not applied; a government benefit is not paid outside it
 * ({@link import("../projection/governmentBenefit").buildGovernmentBenefitSources}); and no income
 * series the simulator collects pays its owner outside it, whatever compiled that series
 * ({@link import("../projection/simulate.types").isPersonActiveAt}).
 */
export function personActiveWindow(
  membership: HouseholdMembership,
  nowYear: number | undefined,
): PersonActiveWindow {
  const member = membershipWindow(membership);
  return {
    startMonth: member.startMonth,
    endMonthExclusive: Math.min(
      member.endMonthExclusive,
      lifeExpectancyEndMonthExclusive(membership.person, nowYear),
    ),
  };
}

/**
 * **How far this member's presence requires the projection to run**, or `null` when it requires
 * nothing beyond what the rest of the household already does. The single definition of the
 * horizon rule, shared by the simulation
 * ({@link import("../projection/buildHouseholdInput").buildHouseholdSimInput}) and by the anchor
 * the panel names ({@link import("../retirement/retirementSolver").horizonAnchorOf}), so the run
 * and the sentence describing it cannot disagree.
 *
 * **A separation counts only if it happens while BOTH people are alive.** You cannot leave a
 * household you have already died out of, and you cannot leave a partner who has already died —
 * so a separation dated at or after `min(this member's death, the primary's death)` is not an
 * event in either life, and the member is present until their own death like any other.
 *
 * This is what a naive "any separation ends their claim on the horizon" got wrong. Take a primary
 * who dies in 2070, a partner who dies in 2080, and a separation booked for 2085: the partner
 * never leaves while alive, so the projection has to cover them to 2080. Cutting the run at the
 * primary's 2070 would leave the survivor's last decade unmodelled — the very gap this whole
 * change exists to close — on the strength of a separation that never happens.
 *
 * At/after, not merely after: a separation in the month someone dies is already too late, because
 * `lifeEndMonthExclusive` is the first month they are gone.
 *
 * Symmetric in the two deaths by design. A separation after the PRIMARY's death is as moot as one
 * after the partner's: there is no couple left to dissolve either way, and the survivor's own
 * years are what the money still has to cover.
 */
export function memberHorizonReach(
  /** This member's own {@link lifeExpectancyEndMonthExclusive}. */
  lifeEndMonthExclusive: number,
  /** Their {@link HouseholdMembership.endMonth} — the separation, or `null` for a member who stays. */
  separationMonth: number | null,
  /** The PRIMARY's own life-end month, the other half of "while both are alive". */
  primaryLifeEndMonthExclusive: number,
): number | null {
  const separates =
    separationMonth !== null &&
    separationMonth < Math.min(lifeEndMonthExclusive, primaryLifeEndMonthExclusive);
  if (separates) return null;
  // A member with no reckonable death (a hand-built base with no frozen "now") bounds nothing.
  return Number.isFinite(lifeEndMonthExclusive) ? lifeEndMonthExclusive : null;
}
