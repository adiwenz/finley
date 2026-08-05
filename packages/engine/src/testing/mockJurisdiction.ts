/**
 * Test-only {@link Jurisdiction} factory over the {@link nullJurisdiction} baseline (zero
 * tax, no programs), so a test enables via `overrides` exactly the seam it exercises —
 * a fixed Social Security benefit, a `publicHealthCoverageAge` for the health step.
 *
 * Pure (satisfies `check-engine-purity`) and deliberately NOT barrel-exported — test
 * scaffolding, not public API. Tests import it by relative path.
 */
import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";

export function mockJurisdiction(
  overrides: Partial<Jurisdiction> = {},
): Jurisdiction {
  return { ...nullJurisdiction, id: "mock", ...overrides };
}
