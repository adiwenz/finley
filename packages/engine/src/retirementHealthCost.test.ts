import { describe, expect, it } from "vitest";
import { personHealthAtYear, healthExpenseAtYear } from "./retirementHealthCost";
import type { RetirementPerson } from "./retirementTypes";

/** A minimal person; per-test overrides tweak only the health-relevant fields. */
function person(overrides: Partial<RetirementPerson> = {}): RetirementPerson {
  return {
    id: "p1",
    currentAge: 60,
    lifeExpectancy: 90,
    ssClaimingAge: 67,
    annualEmploymentIncomeCents: 0,
    annualSocialSecurityCents: 0,
    plannedRetirementAge: 65,
    annualHealthExpenseCents: 1_200_00,
    healthRealGrowthRate: 0,
    ...overrides,
  };
}

describe("personHealthAtYear", () => {
  it("uses the pre-Medicare figure below the enrolment age", () => {
    const p = person({ medicareEligibilityAge: 65, postMedicareHealthAnnualCents: 500_00 });
    expect(personHealthAtYear(p, 0)).toBe(1_200_00); // age 60
  });

  it("steps to the residual at/after the enrolment age", () => {
    const p = person({ medicareEligibilityAge: 65, postMedicareHealthAnnualCents: 500_00 });
    expect(personHealthAtYear(p, 5)).toBe(500_00); // age 65
  });

  it("runs the pre-Medicare figure for life when no enrolment age is set", () => {
    const p = person({ medicareEligibilityAge: undefined });
    expect(personHealthAtYear(p, 20)).toBe(1_200_00); // age 80, still self-funded
  });

  it("compounds the in-force figure at the real growth rate from year 0", () => {
    const p = person({ healthRealGrowthRate: 0.02 });
    expect(personHealthAtYear(p, 10)).toBe(Math.round(1_200_00 * Math.pow(1.02, 10)));
  });

  it("is 0 once the person is past life expectancy", () => {
    expect(personHealthAtYear(person(), 31)).toBe(0); // age 91 > 90
  });

  it("is 0 when the in-force base is absent", () => {
    const p = person({ annualHealthExpenseCents: undefined });
    expect(personHealthAtYear(p, 0)).toBe(0);
  });
});

describe("healthExpenseAtYear", () => {
  it("sums each living person's own line", () => {
    const persons = [
      person({ id: "a", annualHealthExpenseCents: 1_000_00 }),
      person({ id: "b", annualHealthExpenseCents: 700_00 }),
    ];
    expect(healthExpenseAtYear(persons, 0)).toBe(1_700_00);
  });

  it("drops a person's line once they pass life expectancy", () => {
    const persons = [
      person({ id: "a", lifeExpectancy: 70, annualHealthExpenseCents: 1_000_00 }),
      person({ id: "b", lifeExpectancy: 90, annualHealthExpenseCents: 700_00 }),
    ];
    expect(healthExpenseAtYear(persons, 15)).toBe(700_00); // a is 75 (>70), gone
  });
});
