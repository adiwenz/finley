import type { Cents, Jurisdiction, TaxCategory } from "@finley/engine";
import { socialSecurityMonthlyBenefitCents, isCoveredEarnings } from "./socialSecurity";
import { requiredMinimumDistributionCents } from "./rmd";
import { retirementDeferralLimitCents } from "./contributionLimits";
import { healthCostBenchmarkMonthlyCents } from "./healthCosts";

export { socialSecurityMonthlyBenefitCents, isCoveredEarnings } from "./socialSecurity";
export { requiredMinimumDistributionCents } from "./rmd";
export {
  contributionLimits,
  retirementDeferralLimitCents,
  CONTRIBUTION_LIMITS_BASE_YEAR,
  type ContributionLimits,
} from "./contributionLimits";
export {
  healthCostBenchmark,
  healthCostBenchmarkMonthlyCents,
  HEALTH_COST_BASE_YEAR,
  MEDICARE_ELIGIBILITY_AGE,
  type HealthCostBenchmark,
} from "./healthCosts";
import { MEDICARE_ELIGIBILITY_AGE } from "./healthCosts";

/**
 * @finley/rules — jurisdiction implementations of the engine's interface.
 *
 * Depends only on `@finley/engine` (to implement its interface); never the
 * reverse. This one-way dependency is the open-core boundary (ARCHITECTURE.md).
 *
 * Slice 0 ships a placeholder `US-2026` that implements the interface but
 * carries no real facts yet — its `computeTax` returns 0. It exists to prove
 * the app → rules → engine dependency direction end to end before real tax
 * brackets, contribution limits, and programs land in later slices.
 *
 * ⚠ Estimates, not advice. Figures change yearly and are jurisdiction-specific.
 */

/**
 * v1 US tax (§5.3 seam 1): the engine now hands per-{@link TaxCategory} taxable
 * amounts, so this is where real US policy will differentiate rates — ordinary
 * brackets on `wages`/`ordinaryIncome`, preferential rates on `capitalGains`, the
 * ≤85% inclusion on `governmentRetirementBenefit`, and 0 on `taxExempt`. v1 pins
 * every category to 0 (all-zero tax outputs preserved) while keeping the per-
 * category structure so those rates can land without touching the engine.
 */
function computeUsTaxCents(taxableByCategory: Partial<Record<TaxCategory, Cents>>): Cents {
  let total = 0;
  for (const cents of Object.values(taxableByCategory)) total += cents ?? 0;
  return total * 0; // v1 placeholder: structured per-category, but no brackets yet.
}

export const usJurisdiction: Jurisdiction = {
  id: "US-2026",
  computeTaxCents: (taxableByCategory) => computeUsTaxCents(taxableByCategory),
  publicHealthCoverageAge: MEDICARE_ELIGIBILITY_AGE,
  isCoveredEarnings,
  socialSecurityMonthlyBenefitCents,
  requiredMinimumDistributionCents,
  retirementDeferralLimitCents,
  healthCostBenchmarkMonthlyCents,
};
