import { describe, it, expect } from "vitest";
import type { DeferralLimitContext } from "@finley/engine";
import {
  CONTRIBUTION_LIMITS_BASE_YEAR,
  contributionLimits,
  retirementDeferralLimitCents,
  totalAdditionsLimitCents,
  CONTRIBUTION_LIMIT_ASSUMPTIONS,
} from "./contributionLimits";

/** DeferralLimitContext for a person of the given age in `year`. */
function ctx(year: number, age?: number): DeferralLimitContext {
  return { year, age };
}

describe("contributionLimits — the structured base-year cap set", () => {
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

describe("retirementDeferralLimitCents — the age-banded deferral seam", () => {
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

describe("totalAdditionsLimitCents — the age-banded 415(c) ceiling", () => {
  it("returns the base ceiling below 50 (or with no age supplied)", () => {
    expect(totalAdditionsLimitCents(ctx(2026, 40))).toBe(72_000_00);
    expect(totalAdditionsLimitCents(ctx(2026))).toBe(72_000_00);
    expect(totalAdditionsLimitCents(ctx(2026, 49))).toBe(72_000_00);
  });

  it("adds the standard catch-up from age 50 through 59", () => {
    expect(totalAdditionsLimitCents(ctx(2026, 50))).toBe(80_000_00);
    expect(totalAdditionsLimitCents(ctx(2026, 59))).toBe(80_000_00);
  });

  it("adds the larger SECURE 2.0 catch-up in the 60–63 band", () => {
    expect(totalAdditionsLimitCents(ctx(2026, 60))).toBe(83_250_00);
    expect(totalAdditionsLimitCents(ctx(2026, 63))).toBe(83_250_00);
  });

  it("reverts to the standard catch-up from 64 on", () => {
    expect(totalAdditionsLimitCents(ctx(2026, 64))).toBe(80_000_00);
    expect(totalAdditionsLimitCents(ctx(2026, 80))).toBe(80_000_00);
  });

  it("always leaves room above the elective limit — the match has somewhere to land", () => {
    for (const age of [undefined, 30, 49, 50, 59, 60, 63, 64, 80]) {
      expect(totalAdditionsLimitCents(ctx(2026, age))).toBeGreaterThan(
        retirementDeferralLimitCents(ctx(2026, age)),
      );
    }
  });

  it("is monotonic in year at a fixed age (indexed forward, never decreasing)", () => {
    let prev = -1;
    for (let year = CONTRIBUTION_LIMITS_BASE_YEAR; year <= CONTRIBUTION_LIMITS_BASE_YEAR + 40; year++) {
      const limit = totalAdditionsLimitCents(ctx(year, 61));
      expect(limit).toBeGreaterThanOrEqual(prev);
      prev = limit;
    }
  });
});

describe("CONTRIBUTION_LIMIT_ASSUMPTIONS — the user-facing disclosure", () => {
  const textFor = (id: string): string => {
    const found = CONTRIBUTION_LIMIT_ASSUMPTIONS.find((a) => a.id === id);
    if (found === undefined) throw new Error(`no assumption "${id}"`);
    return found.text;
  };

  /** `2_450_000` → `"$24,500"` — the form the prose quotes figures in. */
  const asDollars = (cents: number): string => `$${(cents / 100).toLocaleString("en-US")}`;

  // The prose restates the dollar figures, so it can silently drift from the constants when
  // the base year is re-pinned. Derive every quoted number from the functions themselves.
  it("quotes every figure the limit functions actually return in the base year", () => {
    const text = textFor("retirementContributionLimits");
    const y = CONTRIBUTION_LIMITS_BASE_YEAR;
    for (const age of [40, 55, 61]) {
      expect(text).toContain(asDollars(retirementDeferralLimitCents(ctx(y, age))));
      expect(text).toContain(asDollars(totalAdditionsLimitCents(ctx(y, age))));
    }
    // The catch-up amounts are quoted as the increments they are, not as totals.
    const l = contributionLimits(y);
    expect(text).toContain(asDollars(l.catchUp50Cents));
    expect(text).toContain(asDollars(l.catchUp60to63Cents));
  });

  it("states which cap the employer match does and does not touch", () => {
    const text = textFor("employerMatchOutsideEmployeeCap");
    expect(text).toMatch(/does not count against your personal contribution limit/i);
    expect(text).toMatch(/does count against the combined limit/i);
    // The differing reach of the two caps is spelled out, not left implicit.
    expect(text).toMatch(/shared across every job/i);
    expect(text).toMatch(/applies separately to each employer/i);
  });
});
