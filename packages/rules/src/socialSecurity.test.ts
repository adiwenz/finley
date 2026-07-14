import { describe, it, expect } from "vitest";
import type { Cents, EarningsRecord, SocialSecurityContext } from "@finley/engine";
import { socialSecurityMonthlyBenefitCents } from "./socialSecurity";

/** Build an EarningsRecord with `wageCents` in each of `count` consecutive years from `startYear`. */
function levelRecord(startYear: number, count: number, wageCents: Cents): EarningsRecord {
  const map = new Map<number, Cents>();
  for (let i = 0; i < count; i++) map.set(startYear + i, wageCents);
  return { annualWagesCents: map };
}

const atFRA = (year: number): SocialSecurityContext => ({ year, claimingAge: 67, currentAge: 67 });

describe("socialSecurityMonthlyBenefitCents — AIME→PIA formula (§5.4)", () => {
  it("cent-pinned anchor: 35 years at the wage-base cap, claimed at FRA", () => {
    // All 35 years fall on/after the age-60 indexing year (2019), so every index
    // factor is 1.0 and the benefit is hand-derivable to the cent:
    //   AIME  = 35 × $168,600 / 420 = $14,050.00
    //   PIA   = 0.90·$1,174 + 0.32·($7,078−$1,174) + 0.15·($14,050−$7,078)
    //         = $1,056.60 + $1,889.28 + $1,045.80 = $3,991.68 → dime → $3,991.60
    //   claim = FRA ⇒ ×1.0 ⇒ $3,991.60
    const record = levelRecord(2019, 35, 168_600_00);
    expect(socialSecurityMonthlyBenefitCents(record, atFRA(2026))).toBe(399_160);
  });

  it("returns 0 for an empty record", () => {
    expect(
      socialSecurityMonthlyBenefitCents({ annualWagesCents: new Map() }, atFRA(2026)),
    ).toBe(0);
  });

  it("is monotonic in earnings: more covered wages never lowers the benefit", () => {
    const low = levelRecord(2019, 35, 60_000_00);
    const high = levelRecord(2019, 35, 90_000_00);
    const extraYear = levelRecord(2019, 36, 60_000_00); // one additional earning year
    const lowBenefit = socialSecurityMonthlyBenefitCents(low, atFRA(2026));
    expect(socialSecurityMonthlyBenefitCents(high, atFRA(2026))).toBeGreaterThan(lowBenefit);
    expect(
      socialSecurityMonthlyBenefitCents(extraYear, atFRA(2026)),
    ).toBeGreaterThanOrEqual(lowBenefit);
  });

  it("is monotonic in claiming age: earlier claims are reduced, later are credited", () => {
    const record = levelRecord(2019, 35, 80_000_00);
    // Hold year + currentAge fixed (same indexing year ⇒ same PIA base) and vary
    // only the claiming age, to isolate the claiming-adjustment factor.
    const at = (claimingAge: number): SocialSecurityContext => ({
      year: 2026,
      claimingAge,
      currentAge: 67,
    });
    const early = socialSecurityMonthlyBenefitCents(record, at(62));
    const fra = socialSecurityMonthlyBenefitCents(record, at(67));
    const late = socialSecurityMonthlyBenefitCents(record, at(70));
    expect(early).toBeLessThan(fra);
    expect(late).toBeGreaterThan(fra);
    // Claiming at 62 pays 70% of the FRA PIA; at 70, 124% (8%/yr delayed credit).
    expect(early).toBe(Math.round(fra * 0.7));
    expect(late).toBe(Math.round(fra * 1.24));
  });

  it("clamps claiming age to the legal 62–70 window", () => {
    const record = levelRecord(2019, 35, 80_000_00);
    const below = socialSecurityMonthlyBenefitCents(record, { year: 2026, claimingAge: 55, currentAge: 67 });
    const at62 = socialSecurityMonthlyBenefitCents(record, { year: 2026, claimingAge: 62, currentAge: 67 });
    expect(below).toBe(at62);
  });
});
