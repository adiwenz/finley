/**
 * Test-only {@link Jurisdiction} factory over the {@link nullJurisdiction} baseline (zero
 * tax, no programs), so a test enables via `overrides` exactly the seam it exercises —
 * a fixed Social Security benefit, a `publicHealthCoverageAge` for the health step.
 *
 * Pure (satisfies `check-engine-purity`) and deliberately NOT barrel-exported — test
 * scaffolding, not public API. Tests import it by relative path.
 */
import type { Cents } from "../money/money";
import type { Jurisdiction, WageWithholdingRequest } from "../jurisdiction/jurisdiction";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";

export function mockJurisdiction(
  overrides: Partial<Jurisdiction> = {},
): Jurisdiction {
  return { ...nullJurisdiction, id: "mock", ...overrides };
}

/**
 * A withholding seam taking a flat `rate` out of every wage paycheck — the smallest thing that
 * behaves like real payroll: it sees one period's pay and nothing else, it answers zero for any
 * non-wage flow, and twelve level paycheques withhold exactly `rate` of the year's wages.
 *
 * Paired with a `computeTaxCents` charging the same flat rate on wages, a level wage year settles
 * to nothing in April — which is what lets a test tell "withheld correctly" apart from
 * "reconciled correctly" by looking at the April balance alone.
 *
 * Takes no jurisdiction context, so it satisfies the waterfall's one-argument seam as readily as
 * the jurisdiction's two-argument one.
 */
export function flatWageWithholding(rate: number): (request: WageWithholdingRequest) => Cents {
  return (request) =>
    request.taxCategory === "wages"
      ? Math.round((request.regularWagesCents + request.supplementalWagesCents) * rate)
      : 0;
}
