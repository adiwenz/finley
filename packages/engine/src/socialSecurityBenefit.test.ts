import { describe, expect, it } from "vitest";
import {
  priceSocialSecurityMonthlyCents,
  priceSocialSecurityAnnualRealCents,
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

describe("priceSocialSecurityAnnualRealCents", () => {
  it("annualizes with no deflation when the claim is in the base year", () => {
    const juris = flatBenefit(250_000);
    const inBaseYear = { ...claim, claimYear: 2026 };
    expect(priceSocialSecurityAnnualRealCents(juris, inBaseYear, 2026, 0.02)).toBe(250_000 * 12);
  });

  it("deflates a future claim back to base-year dollars at CPI", () => {
    const juris = flatBenefit(250_000);
    // Claim 20 years out at 2% CPI: annual nominal / 1.02^20.
    const real = priceSocialSecurityAnnualRealCents(
      juris,
      { ...claim, claimYear: 2046 },
      2026,
      0.02,
    );
    expect(real).toBe(Math.round((250_000 * 12) / Math.pow(1.02, 20)));
    expect(real).toBeLessThan(250_000 * 12);
  });

  it("is 0 when the benefit is 0 regardless of deflation", () => {
    expect(priceSocialSecurityAnnualRealCents(nullJurisdiction, claim, 2026, 0.02)).toBe(0);
  });
});
