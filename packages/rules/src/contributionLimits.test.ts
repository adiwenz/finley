import { describe, it, expect } from "vitest";
import type { DeferralLimitContext } from "@finley/engine";
import {
  CONTRIBUTION_LIMITS_BASE_YEAR,
  contributionLimits,
  retirementDeferralLimitCents,
} from "./contributionLimits";

/** DeferralLimitContext for a person of the given age in `year`. */
function ctx(year: number, age?: number): DeferralLimitContext {
  return { year, age };
}

describe("contributionLimits — the structured base-year cap set (§5.4)", () => {
  it("cent-pins the 2026 base-year figures", () => {
    const l = contributionLimits(2026);
    expect(l.year).toBe(2026);
    expect(l.elective401kCents).toBe(24_500_00);
    expect(l.catchUp50Cents).toBe(8_000_00);
    expect(l.catchUp60to63Cents).toBe(11_250_00);
    expect(l.iraCents).toBe(7_500_00);
    expect(l.iraCatchUp50Cents).toBe(1_100_00);
    expect(l.totalAdditionsCents).toBe(72_000_00);
  });

  it("indexes every figure forward, never below the base year", () => {
    const base = contributionLimits(CONTRIBUTION_LIMITS_BASE_YEAR);
    const later = contributionLimits(CONTRIBUTION_LIMITS_BASE_YEAR + 10);
    expect(later.elective401kCents).toBeGreaterThan(base.elective401kCents);
    expect(later.iraCents).toBeGreaterThan(base.iraCents);
    expect(later.totalAdditionsCents).toBeGreaterThan(base.totalAdditionsCents);
  });

  it("holds figures flat for years before the base year (no backward indexing)", () => {
    const past = contributionLimits(CONTRIBUTION_LIMITS_BASE_YEAR - 5);
    const base = contributionLimits(CONTRIBUTION_LIMITS_BASE_YEAR);
    expect(past.elective401kCents).toBe(base.elective401kCents);
  });

  it("is monotonic forward: the elective limit never decreases year over year", () => {
    let prev = -1;
    for (let year = CONTRIBUTION_LIMITS_BASE_YEAR; year <= CONTRIBUTION_LIMITS_BASE_YEAR + 40; year++) {
      const limit = contributionLimits(year).elective401kCents;
      expect(limit).toBeGreaterThanOrEqual(prev);
      prev = limit;
    }
  });

  it("indexes the elective limit in whole $500 IRS increments", () => {
    for (let year = CONTRIBUTION_LIMITS_BASE_YEAR; year <= CONTRIBUTION_LIMITS_BASE_YEAR + 40; year++) {
      expect(contributionLimits(year).elective401kCents % 500_00).toBe(0);
    }
  });
});

describe("retirementDeferralLimitCents — the age-banded deferral seam (§5.4)", () => {
  it("returns the base elective limit below 50 (or with no age supplied)", () => {
    expect(retirementDeferralLimitCents(ctx(2026, 40))).toBe(24_500_00);
    expect(retirementDeferralLimitCents(ctx(2026))).toBe(24_500_00);
    expect(retirementDeferralLimitCents(ctx(2026, 49))).toBe(24_500_00);
  });

  it("adds the standard catch-up from age 50 through 59", () => {
    expect(retirementDeferralLimitCents(ctx(2026, 50))).toBe(24_500_00 + 8_000_00);
    expect(retirementDeferralLimitCents(ctx(2026, 59))).toBe(24_500_00 + 8_000_00);
  });

  it("adds the larger SECURE 2.0 catch-up in the 60–63 band", () => {
    expect(retirementDeferralLimitCents(ctx(2026, 60))).toBe(24_500_00 + 11_250_00);
    expect(retirementDeferralLimitCents(ctx(2026, 63))).toBe(24_500_00 + 11_250_00);
  });

  it("reverts to the standard catch-up from 64 on", () => {
    expect(retirementDeferralLimitCents(ctx(2026, 64))).toBe(24_500_00 + 8_000_00);
    expect(retirementDeferralLimitCents(ctx(2026, 80))).toBe(24_500_00 + 8_000_00);
  });

  it("is monotonic in year at a fixed age (indexed forward, never decreasing)", () => {
    let prev = -1;
    for (let year = CONTRIBUTION_LIMITS_BASE_YEAR; year <= CONTRIBUTION_LIMITS_BASE_YEAR + 40; year++) {
      const limit = retirementDeferralLimitCents(ctx(year, 61));
      expect(limit).toBeGreaterThanOrEqual(prev);
      prev = limit;
    }
  });
});
