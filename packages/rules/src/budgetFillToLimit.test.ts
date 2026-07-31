/**
 * The US contribution-cap seam a `fill-to-limit` budget line fills: the jurisdiction's
 * {@link import("@finley/engine").Jurisdiction.retirementDeferralLimitCents} plug tracks the
 * legislated 401(k) elective-deferral limit AND its age-banded catch-up bumps.
 *
 * This is the `rules` half of the seam. The engine half — a `fill-to-limit` budget line
 * reading this cap and spreading it across the year (`resolveBudgetLineMonthlyCents`,
 * `fillToLimitSeamFor`) — is engine budget-compilation and is covered by the engine's own
 * `budgetLine`/`compileBudget` tests; only the jurisdiction's annual cap values and age bands
 * are asserted here, directly on the public interface.
 */
import { describe, it, expect } from "vitest";
import type { DeferralLimitContext } from "@finley/engine";
import { usJurisdiction } from "./index";
import { contributionLimits } from "./contributionLimits";

describe("fill-to-limit against the real US contribution caps", () => {
  const capAt = (year: number, age?: number): number =>
    usJurisdiction.retirementDeferralLimitCents!({ year, age } as DeferralLimitContext);

  it("exposes a deferral-limit cap seam from the US jurisdiction", () => {
    expect(usJurisdiction.retirementDeferralLimitCents).toBeDefined();
  });

  it("returns the legislated base elective-deferral limit (under 50)", () => {
    expect(capAt(2026, 40)).toBe(contributionLimits(2026).elective401kCents);
  });

  it("adds the age-50 catch-up bump with no authoring change", () => {
    const l = contributionLimits(2026);
    const under50 = capAt(2026, 49);
    const at50 = capAt(2026, 50);
    expect(under50).toBe(l.elective401kCents);
    expect(at50).toBe(l.elective401kCents + l.catchUp50Cents);
    expect(at50).toBeGreaterThan(under50);
  });

  it("applies the larger SECURE 2.0 catch-up in the 60–63 band", () => {
    const l = contributionLimits(2026);
    expect(capAt(2026, 61)).toBe(l.elective401kCents + l.catchUp60to63Cents);
  });
});
