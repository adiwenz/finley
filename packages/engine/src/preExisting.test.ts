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
import { PRIMARY_PERSON_ID } from "./projectionBase";
import { PRE_NOW_MONTH } from "./projection/nowMarker";
import { ref } from "./scenarioInput";
import type { ScenarioInput } from "./scenarioInput";
import { PRIMARY_PERSON_REF } from "./scenarioRefs";
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
  retirementAge: 65,
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

/** A partner carrying one open-ended $2,000/mo ($24,000/yr) job that pays from "now". */
const partnerJob = {
  startYear: base.startYear,
  endYear: null,
  salary: { startingSalaryCents: 2_400_000, realGrowthPct: 0 },
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
