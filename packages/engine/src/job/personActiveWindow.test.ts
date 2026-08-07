/**
 * The active window as a unit, apart from every subsystem that reads it.
 *
 * `personActiveWindow` is the one place membership and death are intersected. These pin the
 * intersection itself; `projectionFacade.run.test.ts` pins that a wage, a raise, a bonus, a
 * benefit and a chart all come out the far side of it agreeing.
 *
 * Months throughout, all exclusive at the top end: a life-end is the first month the person is
 * gone, and a separation month is the first month they are no longer a member.
 */

import { describe, expect, it } from "vitest";
import type { Person } from "../plan/person";
import type { PersonId } from "./job";
import type { HouseholdMembership } from "../ledger/household";
import { lifeExpectancyEndMonthExclusive, personActiveWindow } from "./personActiveWindow";

const NOW_YEAR = 2026;

/** Born 1986, expectancy 85 → dies 2071, which is month 540. */
const person = (overrides: Partial<Person> = {}): Person => ({
  id: "p1" as PersonId,
  name: "Sample",
  birthYear: 1986,
  lifeExpectancy: 85,
  benefitClaimingAge: 67,
  jobs: [],
  ...overrides,
});
const DEATH = 540;

const membership = (startMonth: number, endMonth: number | null, p = person()): HouseholdMembership => ({
  person: p,
  startMonth,
  endMonth,
});

describe("lifeExpectancyEndMonthExclusive", () => {
  it("places birthYear + lifeExpectancy on the calendar as a month", () => {
    expect(lifeExpectancyEndMonthExclusive(person(), NOW_YEAR)).toBe(DEATH);
  });

  it("clamps at 0 for someone already past their expectancy — never a negative window", () => {
    expect(lifeExpectancyEndMonthExclusive(person({ lifeExpectancy: 20 }), NOW_YEAR)).toBe(0);
  });

  it("is unbounded with no frozen 'now' to place the death on", () => {
    // A hand-built base states no `startYear`. Reckoning against a 0 fallback would put this
    // person's death two thousand years out and drag every window and the horizon with it.
    expect(lifeExpectancyEndMonthExclusive(person(), undefined)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("personActiveWindow — membership ∩ life", () => {
  it("ends at the death for a member who never leaves", () => {
    expect(personActiveWindow(membership(0, null), NOW_YEAR)).toEqual({
      startMonth: 0,
      endMonthExclusive: DEATH,
    });
  });

  it("ends at the separation when they leave first", () => {
    expect(personActiveWindow(membership(0, 120), NOW_YEAR)).toEqual({
      startMonth: 0,
      endMonthExclusive: 120,
    });
  });

  it("ends at the death when the separation is dated after it", () => {
    // You cannot leave a household you have already died out of. The separation is not an event
    // in this life, so it does not extend the window past the death — the `min` sees to that
    // without needing a case of its own.
    expect(personActiveWindow(membership(0, 900), NOW_YEAR).endMonthExclusive).toBe(DEATH);
  });

  it("keeps the join as the start — death closes the window, it never opens one", () => {
    expect(personActiveWindow(membership(120, null), NOW_YEAR)).toEqual({
      startMonth: 120,
      endMonthExclusive: DEATH,
    });
  });

  it("is unbounded at both ends for an open membership with no reckonable death", () => {
    // The single-earner shape: the primary joins at -Infinity and never separates, and a base
    // with no `startYear` has no calendar to place a death on.
    expect(personActiveWindow(membership(-Infinity, null), undefined)).toEqual({
      startMonth: Number.NEGATIVE_INFINITY,
      endMonthExclusive: Number.POSITIVE_INFINITY,
    });
  });

  it("closes immediately for someone already past their expectancy at 'now'", () => {
    // Degenerate but well-defined: an empty window, not a backwards one.
    const window = personActiveWindow(membership(0, null, person({ lifeExpectancy: 20 })), NOW_YEAR);
    expect(window.endMonthExclusive).toBe(0);
    expect(window.endMonthExclusive).toBeGreaterThanOrEqual(0);
  });
});
