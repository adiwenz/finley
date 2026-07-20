import type { Cents } from "./money";
import type { Jurisdiction, GovernmentBenefitClaim } from "./jurisdiction";

// The canonical seam input {@link GovernmentBenefitClaim} lives with the seam it
// feeds (jurisdiction.ts); re-exported here so existing importers of the pricing
// helper keep a single import site.
export type { GovernmentBenefitClaim } from "./jurisdiction";

/**
 * The frozen base government retirement benefit at claim, via the jurisdiction seam
 * (§5.4). Clamped ≥ 0; 0 when the jurisdiction supplies no benefit seam (v1 null)
 * or the eligibility gate (inside the seam) is unmet. This is the single place the
 * engine invokes the base seam, so the record is priced identically wherever it is
 * read. The COLA that grows this base forward is a separate seam
 * ({@link Jurisdiction.colaAdjustedBenefitCents}) the engine applies per year.
 */
export function priceGovernmentBenefitBaseMonthlyCents(
  jurisdiction: Jurisdiction,
  claim: GovernmentBenefitClaim,
): Cents {
  return Math.max(0, jurisdiction.governmentBenefitBaseMonthlyCents?.(claim) ?? 0);
}
