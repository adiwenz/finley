import { describe, expect, it } from "vitest";
import {
  priceSocialSecurityMonthlyCents,
  type GovernmentBenefitClaim,
} from "./socialSecurityBenefit";
import { nullJurisdiction, type Jurisdiction } from "./jurisdiction";

const claim: GovernmentBenefitClaim = {
  record: { annualWagesCents: new Map([[2020, 6_000_000]]) },
  claimYear: 2046,
  claimingAge: 67,
  currentAge: 67,
};

/** A stub that pays a fixed nominal monthly benefit, ignoring the record. */
const flatBenefit = (monthlyCents: number): Jurisdiction => ({
  ...nullJurisdiction,
  socialSecurityMonthlyBenefitCents: () => monthlyCents,
});

describe("priceSocialSecurityMonthlyCents", () => {
  it("returns 0 when the jurisdiction supplies no benefit seam", () => {
    expect(priceSocialSecurityMonthlyCents(nullJurisdiction, claim)).toBe(0);
  });

  it("passes the claim through to the seam", () => {
    expect(priceSocialSecurityMonthlyCents(flatBenefit(250_000), claim)).toBe(250_000);
  });

  it("clamps a negative seam result to 0", () => {
    expect(priceSocialSecurityMonthlyCents(flatBenefit(-1), claim)).toBe(0);
  });
});
