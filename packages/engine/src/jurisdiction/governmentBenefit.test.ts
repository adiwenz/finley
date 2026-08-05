import { describe, expect, it } from "vitest";
import {
  priceGovernmentBenefitBaseMonthlyCents,
  type GovernmentBenefitClaim,
} from "./governmentBenefit";
import { nullJurisdiction, type Jurisdiction } from "./jurisdiction";

const claim: GovernmentBenefitClaim = {
  record: { annualWagesCents: new Map([[2020, 6_000_000]]) },
  claimYear: 2046,
  claimingAge: 67,
  currentAge: 67,
};

/** A stub that returns a fixed nominal base benefit, ignoring the record. */
const flatBase = (monthlyCents: number): Jurisdiction => ({
  ...nullJurisdiction,
  governmentBenefitBaseMonthlyCents: () => monthlyCents,
});

describe("priceGovernmentBenefitBaseMonthlyCents", () => {
  it("returns 0 when the jurisdiction supplies no benefit seam", () => {
    expect(priceGovernmentBenefitBaseMonthlyCents(nullJurisdiction, claim)).toBe(0);
  });

  it("passes the claim through to the base seam", () => {
    expect(priceGovernmentBenefitBaseMonthlyCents(flatBase(250_000), claim)).toBe(250_000);
  });

  it("clamps a negative seam result to 0", () => {
    expect(priceGovernmentBenefitBaseMonthlyCents(flatBase(-1), claim)).toBe(0);
  });
});
