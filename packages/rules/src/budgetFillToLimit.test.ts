/**
 * Integration test for the slice-4 `fill-to-limit` amount source (issue #67, AC3)
 * against the REAL rules-side contribution caps (issue #33's set). It proves the
 * end-to-end seam: a `fill-to-limit` budget line, resolved through the engine's
 * jurisdiction seam, tracks the legislated 401(k) elective-deferral limit AND
 * auto-follows the age-50 catch-up bump — with no authoring change to the line.
 *
 * The engine ships the resolver + the seam bridge (`fillToLimitSeamFor`); `rules`
 * supplies the actual `retirementDeferralLimitCents` plug. Wiring them here is the
 * one place the two halves meet, which is exactly the boundary AC3 cares about.
 */
import { describe, it, expect } from "vitest";
import {
  type BudgetLine,
  resolveBudgetLineMonthlyCents,
  fillToLimitSeamFor,
} from "@finley/engine";
import { usJurisdiction } from "./index";
import { contributionLimits } from "./contributionLimits";

const maxOut401k: BudgetLine = {
  id: "max-401k",
  label: "Max out 401(k)",
  target: { kind: "account", accountId: "retirement", taxTreatment: "preTax" },
  category: "savings",
  amountSource: { kind: "fillToLimit" },
};

describe("fill-to-limit against the real US contribution caps (§19, AC3)", () => {
  const annualLimitCents = fillToLimitSeamFor(usJurisdiction);
  const resolveAt = (year: number, age?: number): number =>
    resolveBudgetLineMonthlyCents(maxOut401k, { month: 0, year, age, annualLimitCents });

  it("exposes a cap seam from the US jurisdiction", () => {
    expect(annualLimitCents).toBeDefined();
  });

  it("spreads the legislated base elective-deferral limit across the year (under 50)", () => {
    const cap = contributionLimits(2026).elective401kCents;
    expect(resolveAt(2026, 40)).toBe(Math.round(cap / 12));
  });

  it("auto-follows the age-50 catch-up bump with no authoring change", () => {
    const l = contributionLimits(2026);
    const under50 = resolveAt(2026, 49);
    const at50 = resolveAt(2026, 50);
    expect(under50).toBe(Math.round(l.elective401kCents / 12));
    expect(at50).toBe(Math.round((l.elective401kCents + l.catchUp50Cents) / 12));
    expect(at50).toBeGreaterThan(under50);
  });

  it("applies the larger SECURE 2.0 catch-up in the 60–63 band", () => {
    const l = contributionLimits(2026);
    expect(resolveAt(2026, 61)).toBe(Math.round((l.elective401kCents + l.catchUp60to63Cents) / 12));
  });
});
