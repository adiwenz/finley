import { describe, it, expect } from "vitest";
import { dollarsToCents } from "@finley/engine";
import { usJurisdiction } from "./index";

// Proves rules can consume the engine (app → rules → engine) and that US-2026 implements the
// interface. The engine-side proof that these seams drive a full simulation to the right
// numbers lives where the simulator does — `@finley/engine`'s projection tests — and end to
// end under this jurisdiction in the app's projection tests; here we pin the interface itself.
describe("usJurisdiction (US-2026)", () => {
  it("implements the jurisdiction interface", () => {
    expect(usJurisdiction.id).toBe("US-2026");
    // The seam takes MONTHLY slices: $1,000/mo annualizes to $12k, below the standard
    // deduction → no tax.
    expect(
      usJurisdiction.computeTaxCents({ wages: dollarsToCents(1000) }, { year: 2026 }),
    ).toBe(0);
  });

  it("exposes its federal-tax simplifications through the modelAssumptions seam", () => {
    // The disclosures ride the jurisdiction, so the report surfaces them without the
    // engine holding a US fact. Stable ids let a consumer key and style each.
    const ids = (usJurisdiction.modelAssumptions ?? []).map((a) => a.id);
    expect(ids).toContain("taxThresholdForwardIndexing");
    expect(ids).toContain("socialSecurityThresholdsUnindexed");
    expect(ids).toContain("taxAttributionProportional");
    expect(ids).toContain("rmdStartAge");
    // Gains take LONG-TERM rates with no holding period tracked, so a sale from a
    // recently-funded account is under-taxed. Disclosed, not silently assumed.
    expect(ids).toContain("capitalGainsAllLongTerm");
    for (const a of usJurisdiction.modelAssumptions ?? []) {
      expect(a.text.length).toBeGreaterThan(0);
    }
  });

  it("reports tax per category, summing to the scalar total", () => {
    // A mixed month of wages + capital gains: the per-category split's Σ must equal the
    // scalar `computeTaxCents` for the same slice.
    const slice = {
      wages: Math.round(dollarsToCents(60_000) / 12),
      capitalGains: Math.round(dollarsToCents(20_000) / 12),
    };
    const total = usJurisdiction.computeTaxCents(slice, { year: 2026 });
    const byCategory = usJurisdiction.computeTaxByCategoryCents!(slice, { year: 2026 });
    const sum = Object.values(byCategory).reduce((s: number, c) => s + (c ?? 0), 0);
    expect(sum).toBe(total);
    // Gains bear preferential-rate tax on their own band, not a blend.
    expect(byCategory.capitalGains).toBeGreaterThan(0);
    expect(byCategory.wages).toBeGreaterThan(0);
  });

  it("runs real single-filer federal tax through the seam", () => {
    // $100k/yr of wages → annual tax $13,170 (brackets + standard deduction, single
    // filer) → the month's 1/12 share.
    const monthly = usJurisdiction.computeTaxCents(
      { wages: Math.round(dollarsToCents(100_000) / 12) },
      { year: 2026 },
    );
    expect(monthly).toBe(Math.round(dollarsToCents(13_170) / 12));
  });
});
