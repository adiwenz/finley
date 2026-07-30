/**
 * The rules half of `fill-to-limit`: US-2026 supplies the legislated 401(k) elective-deferral
 * cap and its age catch-up bumps through the jurisdiction interface.
 *
 * `fillToLimitSeamFor(jurisdiction)` — the engine's bridge — is exactly
 * {@link import("@finley/engine").Jurisdiction.retirementDeferralLimitCents}, so this reads that
 * public seam directly. The engine half (a `fillToLimit` budget line spreads the returned cap
 * across the year and auto-follows the age band with no authoring change) is proven against the
 * resolver in `@finley/engine`'s `budgetLine.test.ts`; here is where the real caps live.
 */
import { describe, it, expect } from "vitest";
import type { DeferralLimitContext } from "@finley/engine";
import { usJurisdiction } from "./index";
import { contributionLimits } from "./contributionLimits";

const capAt = (year: number, age?: number): number => {
  const seam = usJurisdiction.retirementDeferralLimitCents;
  if (seam === undefined) throw new Error("US-2026 must expose retirementDeferralLimitCents");
  return seam({ year, age } satisfies DeferralLimitContext);
};

describe("US-2026 retirement deferral cap — the fill-to-limit plug", () => {
  it("exposes the deferral-limit seam from the jurisdiction", () => {
    expect(usJurisdiction.retirementDeferralLimitCents).toBeDefined();
  });

  it("returns the legislated base elective-deferral limit (under 50)", () => {
    expect(capAt(2026, 40)).toBe(contributionLimits(2026).elective401kCents);
  });

  it("adds the age-50 catch-up with no authoring change", () => {
    const l = contributionLimits(2026);
    expect(capAt(2026, 49)).toBe(l.elective401kCents);
    expect(capAt(2026, 50)).toBe(l.elective401kCents + l.catchUp50Cents);
    expect(capAt(2026, 50)).toBeGreaterThan(capAt(2026, 49));
  });

  it("applies the larger SECURE 2.0 catch-up in the 60–63 band", () => {
    const l = contributionLimits(2026);
    expect(capAt(2026, 61)).toBe(l.elective401kCents + l.catchUp60to63Cents);
  });
});
