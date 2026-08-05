/**
 * Cut 1 of pre-existing debts / children / partners: the dedicated authoring methods that place
 * an **anchor** (partner, child, separation) at its true past month or open a **holding** (loan)
 * at the now marker with current terms — reusing the existing event types, no new primitives.
 *
 * These verify the doorway (`Projection.startPartnered` / `haveExistingChild` / `carryLoan` and
 * their `ScenarioInput` entries) computes the internal month convention the engine already
 * understands, so the "enter current, never reconstruct" rule holds without the caller ever
 * naming a negative month.
 */

import { describe, expect, it } from "vitest";
import { Projection } from "./index";
import { nullJurisdiction } from "./jurisdiction";
import { PRIMARY_PERSON_ID } from "./compile/projectionBase";
import { PRE_NOW_MONTH } from "./projection/nowMarker";
import { ref } from "./input/scenarioInput";
import type { ScenarioInput } from "./input/scenarioInput";
import { PRIMARY_PERSON_REF } from "./input/scenarioRefs";
import type { PersonId } from "./job";

/** A quiet, fully-deterministic scenario: no returns, no inflation, no income — so a holding's
 * balance and an anchor's clipped cost fall out as exact literals rather than grown numbers. */
const base = {
  name: "Test",
  startYear: 2026,
  openingBalanceCents: 5_000_000,
  savingsReturnPct: 0,
  retirementReturnPct: 0,
  brokerageReturnPct: 0,
  sharedScheme: "proportional" as const,
  inflationPct: 0,
  currentAge: 30,
  lifeExpectancy: 90,
  benefitClaimingAge: 67,
};

describe("carryLoan — a debt already on the books", () => {
  it("opens the liability at the now marker, so its first payment lands in month 0", () => {
    const p = Projection.init(base, nullJurisdiction);
    // $24,000 over 24 months at 0% APR → a clean $1,000/mo amortization.
    const loanId = p.carryLoan({
      ownerId: PRIMARY_PERSON_ID as PersonId,
      kind: "auto",
      balanceCents: 2_400_000,
      apr: 0,
      remainingTermMonths: 24,
    });
    expect(loanId).toMatch(/^loan-\d+$/);

    // The holding is dated `-1`, never a caller-supplied month.
    const event = p.state.scenario.ledger.events[0];
    expect(event?.month).toBe(PRE_NOW_MONTH);

    // Because it opens at `-1`, month 0 is already the FIRST amortizing payment: $24,000 − $1,000.
    const months = p.run(nullJurisdiction).series.months;
    expect(months[0]?.liabilityBalancesCents[loanId]).toBe(2_300_000);
  });
});

describe("haveExistingChild — a child already born", () => {
  it("clips the 18-year cost stream to the months of childhood that REMAIN", () => {
    const p = Projection.init({ ...base, openingBalanceCents: 50_000_000 }, nullJurisdiction);
    // A one-year-old (12 months) carrying $12,000/yr → $1,000/mo of remaining cost.
    const childId = p.haveExistingChild({ name: "Robin", ageMonths: 12, annualCostCents: 1_200_000 });
    expect(childId).toMatch(/^child-\d+$/);

    // The birth anchor sits at its true past month, not a caller-supplied one.
    const event = p.state.scenario.ledger.events[0];
    if (event?.type !== "ChildEvent") throw new Error("expected a ChildEvent");
    expect(event.birthMonth).toBe(-12);

    // 18×12 − 12 = 204 months of cost survive the clip: it drains month 0 through 203, then stops.
    const months = p.run(nullJurisdiction).series.months;
    expect(months[0]?.netWorthNominalCents).toBe(49_900_000);
    expect(months[203]?.netWorthNominalCents).toBe(29_600_000);
    expect(months[204]?.netWorthNominalCents).toBe(29_600_000);
  });

  it("refuses an age of 0 — that is a birth now, not a child already born", () => {
    const p = Projection.init(base, nullJurisdiction);
    expect(() => p.haveExistingChild({ name: "Robin", ageMonths: 0, annualCostCents: 1_200_000 })).toThrow(
      /ageMonths must be a positive integer/,
    );
  });
});

/** A partner carrying one long-running $2,000/mo ($24,000/yr) job that pays from "now". */
const partnerJob = {
  startYear: base.startYear,
  endYear: 2090,
  // Starts at "now", so both anchors are the one stated salary — a flat history.
  salary: { startingSalaryCents: 2_400_000, currentSalaryCents: 2_400_000, realGrowthPct: 0 },
} as const;

describe("startPartnered — a partner already in the household", () => {
  it("pays the partner's income from month 0 however far back the partnering is dated", () => {
    const p = Projection.init(base, nullJurisdiction);
    const partnerId = p.startPartnered({
      partneredForMonths: 120,
      name: "Sam",
      birthYear: 1990,
      jobs: [partnerJob],
    });
    expect(partnerId).toMatch(/^person-\d+$/);

    // The partnering anchor sits at its true past month (−120), not month 0.
    const event = p.state.scenario.ledger.events[0];
    expect(event?.month).toBe(-120);

    // Income compiles membership-agnostically and clips to month 0: $2,000 lands in month 0.
    const months = p.run(nullJurisdiction).series.months;
    expect(months[0]?.netWorthNominalCents).toBe(5_200_000);
  });

  it("lets the partner separate BEFORE now, clipping support to what remains", () => {
    const p = Projection.init(base, nullJurisdiction);
    const partnerId = p.startPartnered({
      partneredForMonths: 120,
      name: "Sam",
      birthYear: 1990,
      jobs: [partnerJob],
    }) as PersonId;
    // Separated two years ago, with 36 months of alimony ORIGINALLY ordered — 24 already elapsed.
    p.separate({
      month: -24,
      partnerPersonId: partnerId,
      alimonyMonthlyCents: 100_000,
      alimonyDurationMonths: 36,
    });

    const months = p.run(nullJurisdiction).series.months;
    // The departed partner earns nothing now, and 36 − 24 = 12 months of alimony survive: $1,000
    // drains months 0 through 11 (12 × $1,000 = $12,000 off $50,000), then the household holds flat.
    expect(months[0]?.netWorthNominalCents).toBe(4_900_000);
    expect(months[11]?.netWorthNominalCents).toBe(3_800_000);
    expect(months[12]?.netWorthNominalCents).toBe(3_800_000);
  });

  it("refuses a partnering of 0 months — that is a wedding now, not an existing partner", () => {
    const p = Projection.init(base, nullJurisdiction);
    expect(() => p.startPartnered({ partneredForMonths: 0, name: "Sam", birthYear: 1990 })).toThrow(
      /partneredForMonths must be a positive integer/,
    );
  });
});

describe("ownHome — a home already owned at start", () => {
  it("opens the property at its current value and the mortgage at its balance, both at the now marker with no down-payment draw", () => {
    const p = Projection.init(base, nullJurisdiction);
    // $400k home carrying a $240k mortgage over 240 months at 0% APR → $1,000/mo amortization.
    const homeId = p.ownHome({
      ownerId: PRIMARY_PERSON_ID as PersonId,
      valueCents: 40_000_000,
      mortgage: { balanceCents: 24_000_000, apr: 0, remainingTermMonths: 240 },
    });
    expect(homeId).toMatch(/^home-\d+$/);
    const mortgageId = `${homeId}-mortgage`;

    // The mortgage LoanEvent sorts first (the property's precondition needs it to exist), and both
    // holdings are dated `-1`, never a caller-supplied month.
    const events = p.state.scenario.ledger.events;
    expect(events[0]?.type).toBe("LoanEvent");
    expect(events[0]?.month).toBe(PRE_NOW_MONTH);
    expect(events[1]?.type).toBe("HomePurchaseEvent");
    expect(events[1]?.month).toBe(PRE_NOW_MONTH);

    // On the books at "now": the property opens at its full value and the mortgage at its full
    // balance, and savings is untouched — a holding draws no down payment (contrast `buyHome`).
    const { series } = p.run(nullJurisdiction);
    expect(series.opening.propertyValuesCents[homeId]).toBe(40_000_000);
    expect(series.opening.liabilityBalancesCents[mortgageId]).toBe(24_000_000);
    expect(series.opening.accountBalancesCents.savings).toBe(5_000_000);

    // Month 0 is the mortgage's first amortizing payment: $240,000 − $1,000.
    expect(series.months[0]?.liabilityBalancesCents[mortgageId]).toBe(23_900_000);
  });

  it("owns a home outright — no mortgage, no securing link", () => {
    const p = Projection.init(base, nullJurisdiction);
    const homeId = p.ownHome({ ownerId: PRIMARY_PERSON_ID as PersonId, valueCents: 40_000_000 });

    const events = p.state.scenario.ledger.events;
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("HomePurchaseEvent");
    expect(events[0]?.type === "HomePurchaseEvent" && events[0].securedByLiabilityId).toBeUndefined();

    const { series } = p.run(nullJurisdiction);
    expect(series.opening.propertyValuesCents[homeId]).toBe(40_000_000);
    expect(series.opening.accountBalancesCents.savings).toBe(5_000_000);
  });

  it("carries acquiredMonth and originalPriceCents as behavior-free basis metadata", () => {
    const p = Projection.init(base, nullJurisdiction);
    const homeId = p.ownHome({
      ownerId: PRIMARY_PERSON_ID as PersonId,
      valueCents: 40_000_000,
      // Bought 8 years ago for $250k — the future capital-gains basis, read by no current-balance logic.
      acquiredMonth: -96,
      originalPriceCents: 25_000_000,
    });
    const event = p.state.scenario.ledger.events[0];
    if (event?.type !== "HomePurchaseEvent") throw new Error("expected a HomePurchaseEvent");
    expect(event.acquiredMonth).toBe(-96);
    expect(event.originalPriceCents).toBe(25_000_000);

    // Behavior-free: the opening value is the CURRENT value, untouched by the original price.
    const { series } = p.run(nullJurisdiction);
    expect(series.opening.propertyValuesCents[homeId]).toBe(40_000_000);
  });
});

/** Fails the test if the declarative build was refused — narrows the union and surfaces the reason. */
function built(input: ScenarioInput): Projection {
  const result = Projection.fromInput(input, nullJurisdiction);
  if (!result.ok) throw new Error(`expected a built projection, got: ${result.error.reason}`);
  return result.projection;
}

describe("ScenarioInput — the declarative surface for anchors and holdings", () => {
  it("routes each entry through its dedicated method, minting the internal month convention", () => {
    const p = built({
      ...base,
      events: [
        { type: "startPartnered", ref: ref("sam"), partneredForMonths: 120, name: "Sam", birthYear: 1990 },
        { type: "haveExistingChild", ageMonths: 12, name: "Robin", annualCostCents: 1_200_000 },
        { type: "carryLoan", ownerRef: PRIMARY_PERSON_REF, kind: "auto", balanceCents: 2_400_000, apr: 0, remainingTermMonths: 24 },
      ],
    });
    const partnering = p.ledger.events.find((e) => e.type === "RelationshipEvent");
    const child = p.ledger.events.find((e) => e.type === "ChildEvent");
    const loan = p.ledger.events.find((e) => e.type === "LoanEvent");
    expect(partnering?.month).toBe(-120);
    expect(child?.type === "ChildEvent" && child.birthMonth).toBe(-12); // the birth anchor
    expect(loan?.month).toBe(PRE_NOW_MONTH);
  });

  it("routes an ownHome entry through the facade, expanding to a mortgage holding and its property", () => {
    const p = built({
      ...base,
      events: [
        {
          type: "ownHome",
          ref: ref("house"),
          ownerRef: PRIMARY_PERSON_REF,
          valueCents: 40_000_000,
          mortgage: { balanceCents: 24_000_000, apr: 0, remainingTermMonths: 240 },
        },
      ],
    });
    const property = p.ledger.events.find((e) => e.type === "HomePurchaseEvent");
    const mortgage = p.ledger.events.find((e) => e.type === "LoanEvent");
    expect(property?.month).toBe(PRE_NOW_MONTH);
    expect(mortgage?.month).toBe(PRE_NOW_MONTH);
    // The property names the mortgage, and both are holdings on the books at "now".
    if (property?.type !== "HomePurchaseEvent" || mortgage?.type !== "LoanEvent") {
      throw new Error("expected an expanded home holding");
    }
    expect(property.securedByLiabilityId).toBe(mortgage.liabilityId);
    const { series } = p.run(nullJurisdiction);
    expect(series.opening.propertyValuesCents[property.propertyId]).toBe(40_000_000);
    expect(series.opening.liabilityBalancesCents[mortgage.liabilityId]).toBe(24_000_000);
  });

  it("dates a declarative pre-now separation against the partner it names", () => {
    // `startPartnered` at −120 makes a separation at −24 both expressible and correctly ordered.
    const p = built({
      ...base,
      events: [
        { type: "startPartnered", ref: ref("sam"), partneredForMonths: 120, name: "Sam", birthYear: 1990 },
        { type: "separate", month: -24, partnerRef: ref("sam"), alimonyMonthlyCents: 100_000, alimonyDurationMonths: 36 },
      ],
    });
    const separation = p.ledger.events.find((e) => e.type === "SeparationEvent");
    expect(separation?.month).toBe(-24);
    // 12 months of alimony remain: $1,000 drains months 0..11 off the $50,000 opening.
    const months = p.run(nullJurisdiction).series.months;
    expect(months[11]?.netWorthNominalCents).toBe(3_800_000);
    expect(months[12]?.netWorthNominalCents).toBe(3_800_000);
  });
});
