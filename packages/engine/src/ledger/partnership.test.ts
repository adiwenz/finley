/**
 * One partnership at a time — the household may have any number of partners across a plan, but
 * their spans must sit end to end.
 *
 * Written against the facade rather than the handler, because the point of the rule is that it
 * holds for every path that can produce an overlap: adding, re-dating, removing the separation
 * between two, raising an expectancy until the first partnership swallows the gap, and a whole
 * ledger arriving from outside. Each of those reaches the check by a different route, and a test
 * written at the handler would prove only that the check works, not that they all pass it.
 */

import { describe, it, expect } from "vitest";
import { Projection } from "../index";
import { samplePlan, stateOf, SAMPLE_START_YEAR } from "../testing/samplePlan";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { dollarsToCents } from "../money/cashFlowSeries";
import type { PersonId } from "../job/job";
import type { ProjectionState } from "../authoring/state";

function fresh(): Projection {
  return Projection.fromState(
    stateOf({ ...samplePlan, primary: { ...samplePlan.primary, jobs: [] }, budgetLines: [] }),
    nullJurisdiction,
  );
}

/** A partner who outlives the plan, so only a separation ever ends their partnership. */
function partner(name: string, month: number) {
  return { month, name, birthYear: SAMPLE_START_YEAR - 40, lifeExpectancy: 90 };
}

const YEAR = 12;

describe("one partnership at a time — adding", () => {
  it("refuses a second partner while the first is still here", () => {
    const p = fresh();
    p.marry(partner("Sam", 2 * YEAR));

    expect(() => p.marry(partner("Kim", 5 * YEAR))).toThrow(
      /already partnered with Sam in 2031\. Add a separation first or choose a later date/,
    );
  });

  it("refuses a starting partner when a partnership already covers month zero", () => {
    const p = fresh();
    p.startPartnered({ partneredForMonths: 5 * YEAR, name: "Sam", birthYear: SAMPLE_START_YEAR - 40, lifeExpectancy: 90 });

    expect(() =>
      p.startPartnered({
        partneredForMonths: 2 * YEAR,
        name: "Kim",
        birthYear: SAMPLE_START_YEAR - 40,
        lifeExpectancy: 90,
      }),
    ).toThrow(/already partnered with Sam/);
  });

  it("refuses a partnership inserted BEFORE a future one, with no separation between them", () => {
    const p = fresh();
    p.marry(partner("Sam", 10 * YEAR));

    // The overlap runs forwards, not backwards, so the refusal names the partnership the new one
    // would run INTO and the year it starts — the date the reader has to separate before.
    expect(() => p.marry(partner("Kim", 2 * YEAR))).toThrow(
      /would still be running when you partner with Sam in 2036/,
    );
  });

  it("allows a new partnership the very month the last one ends", () => {
    const p = fresh();
    const sam = p.marry(partner("Sam", 2 * YEAR)) as PersonId;
    p.separate({ month: 5 * YEAR, partnerPersonId: sam });

    expect(() => p.marry(partner("Kim", 5 * YEAR))).not.toThrow();
  });

  it("allows a new partnership once the last partner has died", () => {
    const p = fresh();
    // Reaches 81 in the plan's second year, so month 12 is the first month they are gone.
    p.marry({ month: 0, name: "Sam", birthYear: SAMPLE_START_YEAR - 80, lifeExpectancy: 81 });

    expect(() => p.marry(partner("Kim", 1 * YEAR))).not.toThrow();
  });

  it("still refuses a new partnership the month BEFORE a death ends the last one", () => {
    const p = fresh();
    p.marry({ month: 0, name: "Sam", birthYear: SAMPLE_START_YEAR - 80, lifeExpectancy: 81 });

    expect(() => p.marry(partner("Kim", 11))).toThrow(/already partnered with Sam/);
  });
});

describe("one partnership at a time — editing what already exists", () => {
  /** Sam from year 2 to year 5, then Kim from year 6 — two partnerships with a year between. */
  function sequential(): { p: Projection; sam: PersonId; kim: PersonId; separation: string } {
    const p = fresh();
    const sam = p.marry(partner("Sam", 2 * YEAR)) as PersonId;
    const separation = p.separate({ month: 5 * YEAR, partnerPersonId: sam });
    const kim = p.marry(partner("Kim", 6 * YEAR)) as PersonId;
    return { p, sam, kim, separation };
  }

  it("refuses moving a partnership into the interval another one occupies", () => {
    const { p, kim } = sequential();

    expect(() => p.reviseTransaction(kim, { type: "marry", month: 3 * YEAR })).toThrow(
      /already partnered with Sam/,
    );
  });

  it("refuses removing the separation that keeps two partnerships apart", () => {
    const { p, separation } = sequential();

    expect(() => p.removeTransaction(separation)).toThrow(/already partnered with Sam/);
  });

  it("refuses moving a separation past the partnership that follows it", () => {
    const { p, separation } = sequential();

    expect(() => p.reviseTransaction(separation, { type: "separate", month: 7 * YEAR })).toThrow(
      /already partnered with Sam/,
    );
  });

  it("allows moving a separation anywhere that keeps the two apart", () => {
    const { p, separation } = sequential();

    expect(() =>
      p.reviseTransaction(separation, { type: "separate", month: 6 * YEAR }),
    ).not.toThrow();
  });

  it("refuses raising a life expectancy until the first partnership swallows the gap", () => {
    const p = fresh();
    // Sam's death, not a separation, is what ends this partnership: they reach 81 in the plan's
    // second year, leaving Kim's year-2 partnering clear of it.
    const sam = p.marry({ month: 0, name: "Sam", birthYear: SAMPLE_START_YEAR - 80, lifeExpectancy: 81 }) as PersonId;
    p.marry(partner("Kim", 2 * YEAR));

    // Blamed on the edit, and on the partnership the edit strands: Kim's partnering is the one
    // that no longer replays once Sam's outlives the gap it sat in.
    expect(() => p.reviseTransaction(sam, { type: "marry", lifeExpectancy: 95 })).toThrow(
      /causes event "person-2".*already partnered with Sam in 2028/s,
    );
  });

  it("allows a life-expectancy change that leaves the gap intact", () => {
    const p = fresh();
    const sam = p.marry({ month: 0, name: "Sam", birthYear: SAMPLE_START_YEAR - 80, lifeExpectancy: 81 }) as PersonId;
    p.marry(partner("Kim", 2 * YEAR));

    expect(() => p.reviseTransaction(sam, { type: "marry", lifeExpectancy: 82 })).not.toThrow();
  });
});

describe("one partnership at a time — imported scenarios", () => {
  it("refuses a ledger whose relationships overlap, naming the event that fails", () => {
    const p = fresh();
    const sam = p.marry(partner("Sam", 2 * YEAR)) as PersonId;
    const separation = p.separate({ month: 5 * YEAR, partnerPersonId: sam });
    p.marry(partner("Kim", 6 * YEAR));

    // A hand-edited file: the separation that made the two legal is gone, and the events that
    // depended on it are not. Nothing on the authoring path ever produced this state.
    const exported = JSON.parse(JSON.stringify(p.toState())) as ProjectionState;
    const tampered: ProjectionState = {
      ...exported,
      scenario: {
        ...exported.scenario,
        ledger: {
          ...exported.scenario.ledger,
          events: exported.scenario.ledger.events.filter((e) => e.id !== separation),
        },
      },
    };

    expect(() => Projection.fromState(tampered, nullJurisdiction)).toThrow(
      /cannot load.*already partnered with Sam/s,
    );
  });
});

describe("sequential partnerships keep each partner's own money and work", () => {
  it("scopes accounts, income and membership to the partner they belong to", () => {
    const p = fresh();
    const sam = p.marry({
      ...partner("Sam", 0),
      jobs: [
        {
          startYear: SAMPLE_START_YEAR,
          endYear: SAMPLE_START_YEAR + 30,
          salary: {
            startingSalaryCents: dollarsToCents(60_000),
            currentSalaryCents: dollarsToCents(60_000),
            realGrowthPct: 0,
          },
        },
      ],
      accounts: { savingsBalanceCents: dollarsToCents(10_000) },
    }) as PersonId;
    p.separate({ month: 5 * YEAR, partnerPersonId: sam });
    const kim = p.marry({
      ...partner("Kim", 5 * YEAR),
      accounts: { savingsBalanceCents: dollarsToCents(4_000) },
    }) as PersonId;

    const household = p.run(nullJurisdiction).household;

    // Each partnership occupies exactly its own stretch, and they meet without overlapping.
    const windows = new Map(
      household.memberships
        .filter((m) => Number.isFinite(m.startMonth))
        .map((m) => [m.person.id, [m.startMonth, m.endMonth] as const]),
    );
    expect(windows.get(sam)).toEqual([0, 5 * YEAR]);
    expect(windows.get(kim)).toEqual([5 * YEAR, null]);

    // Ownership never pools: each partner's account names them and nobody else.
    const ownersOf = (personId: string) =>
      household.accounts.filter((a) => a.owners.length === 1 && a.owners[0] === personId);
    expect(ownersOf(sam).length).toBeGreaterThan(0);
    expect(ownersOf(kim).length).toBeGreaterThan(0);
    expect(ownersOf(sam).some((a) => ownersOf(kim).includes(a))).toBe(false);

    // Sam's wages stop with the partnership, not with the job they were authored to hold.
    const samIncome = household.series.filter(
      (s) => s.ownerId === sam && s.seriesType === "income",
    );
    expect(samIncome.length).toBeGreaterThan(0);
    for (const s of samIncome) expect(s.endMonth).toBeLessThan(5 * YEAR);
  });
});
