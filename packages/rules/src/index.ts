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
import {
  computeFederalTaxCents,
  computeFederalTaxByCategoryCents,
  FEDERAL_TAX_ASSUMPTIONS,
} from "./federalTax";
import { taxableWithdrawalCents, returnTaxTreatment } from "./investmentTax";
import { RMD_ASSUMPTIONS } from "./rmd";
import { payrollTaxCents, PAYROLL_TAX_ASSUMPTIONS } from "./payrollTax";

export {
  governmentBenefitBaseMonthlyCents,
  colaAdjustedBenefitCents,
  isCoveredEarnings,
  DEFAULT_BENEFIT_CLAIMING_AGE,
} from "./socialSecurity";
export { requiredMinimumDistributionCents, RMD_ASSUMPTIONS } from "./rmd";
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
  federalAnnualTaxByCategoryCents,
  computeFederalTaxCents,
  computeFederalTaxByCategoryCents,
  taxableSocialSecurityCents,
  FEDERAL_TAX_BASE_YEAR,
  FEDERAL_TAX_ASSUMPTIONS,
  type FederalTaxTables,
  type OrdinaryBracket,
} from "./federalTax";
export { taxableWithdrawalCents, returnTaxTreatment } from "./investmentTax";
export {
  payrollTaxTables,
  payrollTaxParts,
  payrollTaxCents,
  PAYROLL_TAX_BASE_YEAR,
  PAYROLL_TAX_ASSUMPTIONS,
  OASDI_RATE,
  MEDICARE_RATE,
  ADDITIONAL_MEDICARE_RATE,
  ADDITIONAL_MEDICARE_THRESHOLD_CENTS,
  type PayrollTaxTables,
  type PayrollTaxParts,
} from "./payrollTax";

/**
 * @finley/rules — jurisdiction implementations of the engine's interface.
 *
 * Depends only on `@finley/engine`, to implement its interface, never the reverse — this
 * one-way dependency is the open-core boundary.
 *
 * `US-2026` implements the interface with real single-filer facts: the tax seam runs actual
 * federal brackets, the standard deduction, the capital-gains preference, and the
 * Social-Security inclusion formula ({@link import("./federalTax").computeFederalTaxCents});
 * contribution limits, government benefit, RMDs, and health-cost benchmarks fill their own
 * seams.
 *
 * ⚠ Estimates, not advice. Figures change yearly and are jurisdiction-specific.
 */

export const usJurisdiction: Jurisdiction = {
  id: "US-2026",
  computeTaxCents: (taxableByCategory, ctx) => computeFederalTaxCents(taxableByCategory, ctx.year),
  computeTaxByCategoryCents: (taxableByCategory, ctx) =>
    computeFederalTaxByCategoryCents(taxableByCategory, ctx.year),
  // Employee FICA on EARNED income only: `wages`, never the `ordinaryIncome` a retirement
  // withdrawal books, so a 401(k)/IRA draw is never payroll-taxed. The engine feeds the
  // year-to-date total and charges the difference, so the wage-base cap binds cumulatively.
  computePayrollTaxCents: (earnedByCategory, ctx) =>
    payrollTaxCents(earnedByCategory.wages ?? 0, ctx.year),
  taxableWithdrawalCents: (basis) => taxableWithdrawalCents(basis),
  returnTaxTreatment: (returnKind) => returnTaxTreatment(returnKind),
  publicHealthCoverageAge: MEDICARE_ELIGIBILITY_AGE,
  isCoveredEarnings,
  defaultBenefitClaimingAge: DEFAULT_BENEFIT_CLAIMING_AGE,
  governmentBenefitBaseMonthlyCents,
  colaAdjustedBenefitCents,
  requiredMinimumDistributionCents,
  retirementDeferralLimitCents,
  healthCostBenchmarkMonthlyCents,
  modelAssumptions: [...FEDERAL_TAX_ASSUMPTIONS, ...RMD_ASSUMPTIONS, ...PAYROLL_TAX_ASSUMPTIONS],
};
