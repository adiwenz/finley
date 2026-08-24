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

/** The same plan with spending to divide, for the cases that assert who is charged what. */
function withBudget(): Projection {
  return Projection.fromState(
    stateOf({ ...samplePlan, primary: { ...samplePlan.primary, jobs: [] } }),
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

/**
 * The authored shared-expense split, at the authoring plane — where the number is written,
 * corrected, refused, and where it stops.
 *
 * It rides on the RELATIONSHIP, which is the whole of what makes sequential partners
 * independent: Casey's percentage is a fact about Alex-and-Casey, and Blake's leaves with Blake.
 */
describe("the shared-expense split is written per partnership", () => {
  const shareOf = (state: ProjectionState, personId: string): number | undefined => {
    const event = state.scenario.ledger.events.find(
      (e) => e.type === "RelationshipEvent" && e.person.id === personId,
    ) as { partnerSharePercent?: number } | undefined;
    return event?.partnerSharePercent;
  };

  /** What the projection ACTUALLY charges this partner, as a fraction of the household's budget. */
  function chargedFraction(p: Projection, month: number, personId: string): number {
    const flows = p.run(nullJurisdiction).series.months[month]!.flows!;
    return (flows.obligationChargedByPersonCents[personId] ?? 0) / flows.totalObligationsCents;
  }

  it("defaults a new partnership to 50/50, storing nothing to say so", () => {
    // Absent MEANS the default, so a scenario written before the field existed and one written
    // today with the field left alone are the same scenario — and both replay at 50/50, never at
    // a percentage back-computed from anybody's history.
    const p = fresh();
    const sam = p.marry(partner("Sam", 0)) as PersonId;
    expect(shareOf(p.toState(), sam)).toBeUndefined();
    const membership = p
      .run(nullJurisdiction)
      .household.memberships.find((m) => m.person.id === sam)!;
    expect(membership.sharedExpensePercent).toBe(50);
  });

  it("carries an authored percentage through to the household it describes", () => {
    const p = fresh();
    const sam = p.marry({ ...partner("Sam", 0), partnerSharePercent: 30 }) as PersonId;
    const membership = p
      .run(nullJurisdiction)
      .household.memberships.find((m) => m.person.id === sam)!;
    expect(membership.sharedExpensePercent).toBe(30);
  });

  it("takes both ends — 0 and 100 — as ordinary answers", () => {
    for (const percent of [0, 100]) {
      const p = fresh();
      const sam = p.marry({ ...partner("Sam", 0), partnerSharePercent: percent }) as PersonId;
      expect(
        p.run(nullJurisdiction).household.memberships.find((m) => m.person.id === sam)!
          .sharedExpensePercent,
      ).toBe(percent);
    }
  });

  it("refuses a percentage nobody could have meant, rather than quietly rounding it", () => {
    // Clamping 130 to 100 or 12.5 to 12 would put a number the household never chose behind the
    // projection. The form clamps as you type, so anything reaching here was not typed there.
    for (const bad of [-1, 101, 130, 12.5, Number.NaN]) {
      const p = fresh();
      expect(() => p.marry({ ...partner("Sam", 0), partnerSharePercent: bad })).toThrow(
        /shared-expense share/,
      );
    }
  });

  it("changes only when the household changes it, through a revision", () => {
    const p = fresh();
    const sam = p.marry({ ...partner("Sam", 0), partnerSharePercent: 30 }) as PersonId;
    const eventId = p
      .toState()
      .scenario.ledger.events.find((e) => e.type === "RelationshipEvent")!.id;
    p.reviseTransaction(eventId, { type: "marry", partnerSharePercent: 65 });
    expect(shareOf(p.toState(), sam)).toBe(65);
    // And a revision that says nothing about the split leaves it exactly where it was.
    p.reviseTransaction(eventId, { type: "marry", name: "Samantha" });
    expect(shareOf(p.toState(), sam)).toBe(65);
  });

  it("starts a later partnership from the default rather than from the last one", () => {
    // The rule the sequential case exists for: Blake's 30 is Blake's, and Casey inherits none
    // of it — the split lives on the relationship, and the relationship ended.
    const p = fresh();
    const sam = p.marry({ ...partner("Sam", 0), partnerSharePercent: 30 }) as PersonId;
    p.separate({ month: 5 * YEAR, partnerPersonId: sam });
    const kim = p.marry(partner("Kim", 5 * YEAR)) as PersonId;

    const memberships = p.run(nullJurisdiction).household.memberships;
    expect(memberships.find((m) => m.person.id === sam)!.sharedExpensePercent).toBe(30);
    expect(memberships.find((m) => m.person.id === kim)!.sharedExpensePercent).toBe(50);
  });

  it("lets sequential partners hold genuinely different percentages", () => {
    const p = fresh();
    const sam = p.marry({ ...partner("Sam", 0), partnerSharePercent: 30 }) as PersonId;
    p.separate({ month: 5 * YEAR, partnerPersonId: sam });
    const kim = p.marry({ ...partner("Kim", 5 * YEAR), partnerSharePercent: 80 }) as PersonId;
    const memberships = p.run(nullJurisdiction).household.memberships;
    expect(memberships.find((m) => m.person.id === sam)!.sharedExpensePercent).toBe(30);
    expect(memberships.find((m) => m.person.id === kim)!.sharedExpensePercent).toBe(80);
  });

  it("applies the incoming partner's split on a same-month handover, not the outgoing one's", () => {
    // Sam out and Kim in on the identical month — the case where a "the partner" slot rather
    // than two distinct people would answer with whichever percentage it happened to still hold.
    const p = withBudget();
    const sam = p.marry({ ...partner("Sam", 0), partnerSharePercent: 20 }) as PersonId;
    p.separate({ month: 5 * YEAR, partnerPersonId: sam });
    const kim = p.marry({ ...partner("Kim", 5 * YEAR), partnerSharePercent: 80 }) as PersonId;

    expect(chargedFraction(p, 5 * YEAR - 1, sam)).toBeCloseTo(0.2, 3);
    expect(chargedFraction(p, 5 * YEAR, sam)).toBe(0);
    expect(chargedFraction(p, 5 * YEAR, kim)).toBeCloseTo(0.8, 3);
  });

  it("hands the whole budget to the primary in the months nobody is partnered", () => {
    const p = withBudget();
    const sam = p.marry({ ...partner("Sam", 0), partnerSharePercent: 30 }) as PersonId;
    p.separate({ month: 3 * YEAR, partnerPersonId: sam });
    for (const month of [3 * YEAR, 3 * YEAR + 1, 4 * YEAR]) {
      expect(chargedFraction(p, month, "p1")).toBe(1);
      expect(chargedFraction(p, month, sam)).toBe(0);
    }
  });
});

/**
 * Scenarios written under the old proportional/even lever, restored today.
 *
 * They become fixed 50/50 — never a percentage inferred from the history they carry. Back-computing
 * one would be the same mistake the whole change is against: a number nobody chose, standing where
 * an authored one belongs, and drifting the moment anything about the household drifted.
 */
describe("a scenario saved before the split was a number", () => {
  /** A state as the old app wrote it: a `sharedScheme` on the plan, and no split anywhere. */
  function legacyState(scheme: "proportional" | "even"): ProjectionState {
    const p = fresh();
    p.marry(partner("Sam", 0));
    const written = JSON.parse(JSON.stringify(p.toState())) as ProjectionState & {
      scenario: { plan: Record<string, unknown> };
    };
    written.scenario.plan.sharedScheme = scheme;
    return written;
  }

  it("restores either old lever at a fixed 50/50", () => {
    for (const scheme of ["proportional", "even"] as const) {
      const restored = Projection.fromState(legacyState(scheme), nullJurisdiction);
      const partnership = restored
        .run(nullJurisdiction)
        .household.memberships.find((m) => Number.isFinite(m.startMonth))!;
      expect(partnership.sharedExpensePercent).toBe(50);
    }
  });

  it("gives the two old levers the identical household, since neither is a percentage", () => {
    const asProportional = Projection.fromState(legacyState("proportional"), nullJurisdiction)
      .run(nullJurisdiction)
      .series.months.map((m) => m.flows?.obligationChargedByPersonCents);
    const asEven = Projection.fromState(legacyState("even"), nullJurisdiction)
      .run(nullJurisdiction)
      .series.months.map((m) => m.flows?.obligationChargedByPersonCents);
    expect(asProportional).toEqual(asEven);
  });

  it("keeps the stale lever out of the projection entirely", () => {
    // It survives the round trip as an unread field on the document — the format is unchanged and
    // nothing migrates — and no part of the run reads it.
    const restored = Projection.fromState(legacyState("proportional"), nullJurisdiction).toState();
    expect((restored.scenario.plan as unknown as Record<string, unknown>).sharedScheme).toBe(
      "proportional",
    );
    expect(restored.version).toBe(legacyState("proportional").version);
  });
});
