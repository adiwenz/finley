import type { Cents } from "./money";
import type { Jurisdiction, GovernmentBenefitClaim } from "./jurisdiction";

// The canonical seam input {@link GovernmentBenefitClaim} lives with the seam it feeds
// (jurisdiction.ts); re-exported so importers of the pricing helper keep one import site.
export type { GovernmentBenefitClaim } from "./jurisdiction";

/**
 * The frozen base government retirement benefit at claim, via the jurisdiction seam.
 * Clamped ≥ 0; 0 when the jurisdiction supplies no benefit seam (v1 null) or its
 * eligibility gate is unmet. The engine's single call site for the base seam, so the record
 * prices identically wherever it is read. The COLA that grows this base forward is a
 * separate seam ({@link Jurisdiction.colaAdjustedBenefitCents}), applied per year.
 */
export function priceGovernmentBenefitBaseMonthlyCents(
  jurisdiction: Jurisdiction,
  claim: GovernmentBenefitClaim,
): Cents {
  return Math.max(0, jurisdiction.governmentBenefitBaseMonthlyCents?.(claim) ?? 0);
}
