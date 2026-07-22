import type { Jurisdiction } from "@finley/engine";
import {
  governmentBenefitBaseMonthlyCents,
  colaAdjustedBenefitCents,
  isCoveredEarnings,
  DEFAULT_BENEFIT_CLAIMING_AGE,
} from "./socialSecurity";
import { requiredMinimumDistributionCents } from "./rmd";
import { retirementDeferralLimitCents } from "./contributionLimits";
import { healthCostBenchmarkMonthlyCents } from "./healthCosts";
import { computeFederalTaxCents } from "./federalTax";

export {
  governmentBenefitBaseMonthlyCents,
  colaAdjustedBenefitCents,
  isCoveredEarnings,
  DEFAULT_BENEFIT_CLAIMING_AGE,
} from "./socialSecurity";
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
export {
  federalTaxTables,
  federalAnnualTaxCents,
  computeFederalTaxCents,
  taxableSocialSecurityCents,
  FEDERAL_TAX_BASE_YEAR,
  type FederalTaxTables,
  type OrdinaryBracket,
} from "./federalTax";

/**
 * @finley/rules — jurisdiction implementations of the engine's interface.
 *
 * Depends only on `@finley/engine` (to implement its interface); never the
 * reverse. This one-way dependency is the open-core boundary (ARCHITECTURE.md).
 *
 * `US-2026` implements the interface with real single-filer facts: the tax seam
 * runs actual federal brackets, the standard deduction, the capital-gains
 * preference, and the Social-Security inclusion formula ({@link
 * import("./federalTax").computeFederalTaxCents}, #53); contribution limits,
 * government benefit, RMDs, and health-cost benchmarks fill their own seams. The
 * app → rules → engine dependency direction is proven end to end.
 *
 * ⚠ Estimates, not advice. Figures change yearly and are jurisdiction-specific.
 */

export const usJurisdiction: Jurisdiction = {
  id: "US-2026",
  computeTaxCents: (taxableByCategory, ctx) => computeFederalTaxCents(taxableByCategory, ctx.year),
  publicHealthCoverageAge: MEDICARE_ELIGIBILITY_AGE,
  isCoveredEarnings,
  defaultBenefitClaimingAge: DEFAULT_BENEFIT_CLAIMING_AGE,
  governmentBenefitBaseMonthlyCents,
  colaAdjustedBenefitCents,
  requiredMinimumDistributionCents,
  retirementDeferralLimitCents,
  healthCostBenchmarkMonthlyCents,
};
