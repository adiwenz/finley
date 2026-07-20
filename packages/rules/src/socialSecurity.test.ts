import { describe, it, expect } from "vitest";
import type {
  Cents,
  EarningsRecord,
  GovernmentBenefitClaim,
  GovernmentBenefitContext,
} from "@finley/engine";
import {
  governmentBenefitBaseMonthlyCents,
  colaAdjustedBenefitCents,
  isCoveredEarnings,
} from "./socialSecurity";

/** Build an EarningsRecord with `wageCents` in each of `count` consecutive years from `startYear`. */
function levelRecord(startYear: number, count: number, wageCents: Cents): EarningsRecord {
  const map = new Map<number, Cents>();
  for (let i = 0; i < count; i++) map.set(startYear + i, wageCents);
  return { annualWagesCents: map };
}

/** A claim at full retirement age (67) priced in `year`. */
const claimAtFRA = (record: EarningsRecord, year: number): GovernmentBenefitClaim => ({
  record,
  claimYear: year,
  claimingAge: 67,
  currentAge: 67,
});

describe("governmentBenefitBaseMonthlyCents — AIME→PIA formula (§5.4)", () => {
  it("cent-pinned anchor: 35 years at the wage-base cap, claimed at FRA", () => {
    // Age-60 indexing year is 2019 (claimYear 2026, currentAge 67 ⇒ 2026−67+60).
    // All 35 earnings years fall on/after 2019, so every EARNINGS index factor is
    // 1.0; the bend points, based in 2026, scale DOWN to 2019. Still hand-derivable
    // to the cent:
    //   AIME  = 35 × $184,500 / 420 = $15,375.00
    //   scale = 1.035^(2019−2026) = 1.035^-7 = 0.785991
    //   bend1 = $1,286 × 0.785991 → whole $ = $1,011.00
    //   bend2 = $7,749 × 0.785991 → whole $ = $6,091.00
    //   PIA   = 0.90·$1,011 + 0.32·($6,091−$1,011) + 0.15·($15,375−$6,091)
    //         = $909.90 + $1,625.60 + $1,392.60 = $3,928.10 → dime → $3,928.10
    //   claim = FRA ⇒ ×1.0 ⇒ $3,928.10
    const record = levelRecord(2019, 35, 184_500_00);
    expect(governmentBenefitBaseMonthlyCents(claimAtFRA(record, 2026))).toBe(392_810);
  });

  it("cent-pinned: bend points are re-indexed to a future cohort's age-60 year", () => {
    // A worker turning 67 in 2054 (age-60 year = 2054−67+60 = 2047). Their earnings
    // are indexed forward to 2047, so the bend points must move to that same era or
    // the AIME would be sliced by present-day bend points and understate the benefit.
    //   bend-point scale = 1.035^(2047−2026) = 1.035^21 = 2.059431
    //   bend1 = $1,286 × 2.059431 → whole $ = $2,648.00
    //   bend2 = $7,749 × 2.059431 → whole $ = $15,959.00
    // 35 level years at $100,000, all on/after 2047 ⇒ every earnings index factor
    // is 1.0, so AIME = 35 × $100,000 / 420 = $8,333.33 → whole $ = $8,333.00.
    // AIME sits in the middle (32%) tier, between the two indexed bend points:
    //   PIA = 0.90·$2,648 + 0.32·($8,333−$2,648)
    //       = $2,383.20 + $1,819.20 = $4,202.40 → dime → $4,202.40
    //   claim = FRA ⇒ ×1.0 ⇒ $4,202.40
    const record = levelRecord(2047, 35, 100_000_00);
    const claim: GovernmentBenefitClaim = {
      record,
      claimYear: 2054,
      claimingAge: 67,
      currentAge: 67,
    };
    expect(governmentBenefitBaseMonthlyCents(claim)).toBe(420_240);
  });

  it("returns 0 for an empty record", () => {
    expect(
      governmentBenefitBaseMonthlyCents(claimAtFRA({ annualWagesCents: new Map() }, 2026)),
    ).toBe(0);
  });

  it("eligibility gate: fewer than 40 credits (< 10 full-credit years) → 0", () => {
    // Credits come from ANNUAL covered totals (max 4/yr); the fully-insured gate is
    // 40. Nine years of solidly-above-threshold earnings earn 9 × 4 = 36 credits —
    // under the gate — so the base benefit is 0 even though the AIME would be positive.
    const record = levelRecord(2015, 9, 50_000_00);
    expect(governmentBenefitBaseMonthlyCents(claimAtFRA(record, 2026))).toBe(0);
  });

  it("eligibility gate: exactly 40 credits (10 full-credit years) → a benefit", () => {
    // Ten full-credit years reach 40 credits — fully insured — so the same formula
    // now returns a positive benefit.
    const record = levelRecord(2015, 10, 50_000_00);
    expect(governmentBenefitBaseMonthlyCents(claimAtFRA(record, 2026))).toBeGreaterThan(0);
  });

  it("eligibility gate: a low-earning year yields partial credits, not a free 4", () => {
    // Credits are min(4, floor(wages / quarter-of-coverage)). One year barely over a
    // single quarter of coverage earns 1 credit, not 4 — so nine strong years plus
    // one weak year is 36 + 1 = 37 credits, still under the gate → 0.
    const map = new Map<number, Cents>();
    for (let i = 0; i < 9; i++) map.set(2015 + i, 50_000_00);
    map.set(2024, 2_000_00); // ~1 quarter of coverage in 2024 dollars → 1 credit
    expect(governmentBenefitBaseMonthlyCents(claimAtFRA({ annualWagesCents: map }, 2026))).toBe(0);
  });

  it("is monotonic in earnings: more covered wages never lowers the benefit", () => {
    const low = levelRecord(2019, 35, 60_000_00);
    const high = levelRecord(2019, 35, 90_000_00);
    const extraYear = levelRecord(2019, 36, 60_000_00); // one additional earning year
    const lowBenefit = governmentBenefitBaseMonthlyCents(claimAtFRA(low, 2026));
    expect(governmentBenefitBaseMonthlyCents(claimAtFRA(high, 2026))).toBeGreaterThan(lowBenefit);
    expect(
      governmentBenefitBaseMonthlyCents(claimAtFRA(extraYear, 2026)),
    ).toBeGreaterThanOrEqual(lowBenefit);
  });

  it("is monotonic in claiming age: earlier claims are reduced, later are credited", () => {
    const record = levelRecord(2019, 35, 80_000_00);
    // Hold claimYear + currentAge fixed (same indexing year ⇒ same PIA base) and vary
    // only the claiming age, to isolate the claiming-adjustment factor.
    const at = (claimingAge: number): GovernmentBenefitClaim => ({
      record,
      claimYear: 2026,
      claimingAge,
      currentAge: 67,
    });
    const early = governmentBenefitBaseMonthlyCents(at(62));
    const fra = governmentBenefitBaseMonthlyCents(at(67));
    const late = governmentBenefitBaseMonthlyCents(at(70));
    expect(early).toBeLessThan(fra);
    expect(late).toBeGreaterThan(fra);
    // Claiming at 62 pays 70% of the FRA PIA; at 70, 124% (8%/yr delayed credit).
    expect(early).toBe(Math.round(fra * 0.7));
    expect(late).toBe(Math.round(fra * 1.24));
  });

  it("clamps claiming age to the legal 62–70 window", () => {
    const record = levelRecord(2019, 35, 80_000_00);
    const below = governmentBenefitBaseMonthlyCents({
      record,
      claimYear: 2026,
      claimingAge: 55,
      currentAge: 67,
    });
    const at62 = governmentBenefitBaseMonthlyCents({
      record,
      claimYear: 2026,
      claimingAge: 62,
      currentAge: 67,
    });
    expect(below).toBe(at62);
  });
});

describe("colaAdjustedBenefitCents — single COLA factor from age-62 (§5.4)", () => {
  const ctx = (currentAge: number, colaRate: number): GovernmentBenefitContext => ({
    year: 2026,
    currentAge,
    colaRate,
  });

  it("is the identity at age 62 (exponent 0)", () => {
    expect(colaAdjustedBenefitCents(100_000, ctx(62, 0.03))).toBe(100_000);
  });

  it("bridges a delayed claim: age 67 at 10% CPI → base × 1.1^5", () => {
    // The single (1+cola)^(currentAge−62) factor folds in the old eligibility
    // bridge; claiming at 67 carries five years of COLA off the age-62 base.
    expect(colaAdjustedBenefitCents(100_000, ctx(67, 0.1))).toBe(
      Math.round(100_000 * Math.pow(1.1, 5)),
    );
  });

  it("grows forward one further year at a time (age 68 → six years of COLA)", () => {
    expect(colaAdjustedBenefitCents(100_000, ctx(68, 0.1))).toBe(
      Math.round(100_000 * Math.pow(1.1, 6)),
    );
  });

  it("is a no-op at a zero COLA rate regardless of age", () => {
    expect(colaAdjustedBenefitCents(123_456, ctx(70, 0))).toBe(123_456);
  });

  it("parity: the single COLA factor matches the old bridge+forward split to ≤1¢ (§5.4 Phase 3)", () => {
    // Guardrail for the Option-B collapse (resolved #2): the pre-change engine grew
    // the benefit in TWO rounded steps — an age-62→claim eligibility bridge then a
    // post-claim forward COLA — whereas the new seam applies ONE factor measured from
    // age 62. Algebraically identical; the only difference is an intermediate
    // rounding, so every figure must stay within 1¢. Any drift > 1¢ is a real
    // regression — do not blindly accept it.
    const record = levelRecord(2019, 35, 85_000_00);
    const colaRate = 0.028;
    let maxDrift = 0;
    for (let claimingAge = 62; claimingAge <= 70; claimingAge++) {
      const base = governmentBenefitBaseMonthlyCents({
        record,
        claimYear: 2026,
        claimingAge,
        currentAge: claimingAge,
      });
      // Old path: round the eligibility bridge, then round the forward COLA on top.
      const bridged = Math.round(base * Math.pow(1 + colaRate, claimingAge - 62));
      for (let yearsSinceClaim = 0; yearsSinceClaim <= 25; yearsSinceClaim++) {
        const currentAge = claimingAge + yearsSinceClaim;
        const paidOld = Math.round(bridged * Math.pow(1 + colaRate, yearsSinceClaim));
        const paidNew = colaAdjustedBenefitCents(base, ctx(currentAge, colaRate));
        maxDrift = Math.max(maxDrift, Math.abs(paidNew - paidOld));
      }
    }
    expect(maxDrift).toBeLessThanOrEqual(1);
  });
});

describe("isCoveredEarnings — US covered-earnings predicate (§5.4)", () => {
  it("covers wages and self-employment ordinary income", () => {
    expect(isCoveredEarnings("wages")).toBe(true);
    expect(isCoveredEarnings("ordinaryIncome")).toBe(true);
  });

  it("excludes the benefit itself (circular), capital gains, and tax-exempt income", () => {
    expect(isCoveredEarnings("governmentRetirementBenefit")).toBe(false);
    expect(isCoveredEarnings("capitalGains")).toBe(false);
    expect(isCoveredEarnings("taxExempt")).toBe(false);
  });
});
