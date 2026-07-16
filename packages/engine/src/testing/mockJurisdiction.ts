/**
 * Test-only jurisdiction factory. Builds a {@link Jurisdiction} on top of the
 * {@link nullJurisdiction} baseline (zero tax, no programs) so a test can enable
 * exactly the one seam it exercises via `overrides` — e.g. a fixed Social
 * Security benefit, or a `publicHealthCoverageAge` to assert the health step.
 *
 * Pure (satisfies `check-engine-purity`) and deliberately NOT barrel-exported:
 * it is engine test scaffolding, not public API. Tests import it by relative
 * path (`../testing/mockJurisdiction`).
 */
import type { Jurisdiction } from "../jurisdiction";
import { nullJurisdiction } from "../jurisdiction";

export function mockJurisdiction(
  overrides: Partial<Jurisdiction> = {},
): Jurisdiction {
  return { ...nullJurisdiction, id: "mock", ...overrides };
}
