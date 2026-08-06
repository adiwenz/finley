/**
 * The horizon rule as a unit, apart from either caller.
 *
 * `memberHorizonReach` exists so the simulation horizon (`buildHouseholdInput`) and the anchor the
 * panel names (`horizonAnchorOf`) cannot answer differently — the two used to hold separate copies
 * of "does a separation end this member's claim", and separate copies drift. These pin the rule
 * itself; `projectionFacade.run.test.ts` and `retirementSolver.test.ts` pin that each caller
 * actually routes through it.
 *
 * Months throughout, all exclusive: a life-end is the first month the person is gone, and a
 * separation month is the first month they are no longer a member.
 */

import { describe, expect, it } from "vitest";
import { memberHorizonReach } from "./householdJob";

const PRIMARY_DEATH = 540;
const PARTNER_DEATH = 660;

describe("memberHorizonReach — a separation counts only while both are alive", () => {
  it("returns their own death for a member who never separates", () => {
    expect(memberHorizonReach(PARTNER_DEATH, null, PRIMARY_DEATH)).toBe(PARTNER_DEATH);
  });

  it("returns null for a separation BEFORE the first death", () => {
    expect(memberHorizonReach(PARTNER_DEATH, 300, PRIMARY_DEATH)).toBeNull();
    // The last month it can still happen — the boundary is strict.
    expect(memberHorizonReach(PARTNER_DEATH, PRIMARY_DEATH - 1, PRIMARY_DEATH)).toBeNull();
  });

  it("returns their death for a separation EXACTLY AT the first death", () => {
    // `lifeEndMonthExclusive` is the first month they are gone, so a separation in that month is
    // already too late: there is no couple left to dissolve.
    expect(memberHorizonReach(PARTNER_DEATH, PRIMARY_DEATH, PRIMARY_DEATH)).toBe(PARTNER_DEATH);
  });

  it("returns their death for a separation AFTER the first death", () => {
    expect(memberHorizonReach(PARTNER_DEATH, 600, PRIMARY_DEATH)).toBe(PARTNER_DEATH);
    // Booked past their OWN death as well — doubly moot.
    expect(memberHorizonReach(PARTNER_DEATH, 700, PRIMARY_DEATH)).toBe(PARTNER_DEATH);
  });

  it("is symmetric in the two deaths — the partner's can be the binding one", () => {
    // A partner who dies at 420, before the primary's 540. A separation at 400 happens while both
    // are alive and counts; one at 420 or later does not.
    expect(memberHorizonReach(420, 400, PRIMARY_DEATH)).toBeNull();
    expect(memberHorizonReach(420, 420, PRIMARY_DEATH)).toBe(420);
    expect(memberHorizonReach(420, 500, PRIMARY_DEATH)).toBe(420);
  });

  it("bounds nothing when the member has no reckonable death", () => {
    // A hand-built base with no frozen "now" cannot place a birth year on the calendar, so there
    // is no month for the member to reach and nothing for them to extend.
    expect(memberHorizonReach(Number.POSITIVE_INFINITY, null, PRIMARY_DEATH)).toBeNull();
    expect(
      memberHorizonReach(Number.POSITIVE_INFINITY, 12, Number.POSITIVE_INFINITY),
    ).toBeNull();
  });

  it("treats the primary themself as a member who never separates", () => {
    // The primary is a membership like any other, with `endMonth === null`, so the same call
    // returns their own death and makes them the floor every other member is compared against.
    expect(memberHorizonReach(PRIMARY_DEATH, null, PRIMARY_DEATH)).toBe(PRIMARY_DEATH);
  });
});
