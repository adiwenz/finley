import type { Jurisdiction } from "@finley/engine";
import {
  governmentBenefitBaseMonthlyCents,
  colaAdjustedBenefitCents,
  isCoveredEarnings,
  DEFAULT_BENEFIT_CLAIMING_AGE,
} from "./socialSecurity";
import { requiredMinimumDistributionCents } from "./rmd";
import {
  retirementDeferralLimitCents,
  combinedPlanDepositLimitCents,
  CONTRIBUTION_LIMIT_ASSUMPTIONS,
} from "./contributionLimits";
import { healthCostBenchmarkMonthlyCents } from "./healthCosts";
import {
  federalAnnualTaxCents,
  federalAnnualTaxByCategoryCents,
  FEDERAL_TAX_ASSUMPTIONS,
} from "./federalTax";
import { taxableWithdrawalCents, returnTaxTreatment } from "./investmentTax";
import { RMD_ASSUMPTIONS } from "./rmd";
import {
  payrollWithholdingCents,
  payrollTaxReconciliationCents,
  PAYROLL_TAX_ASSUMPTIONS,
} from "./payrollTax";
import { wageWithholdingCents, WAGE_WITHHOLDING_ASSUMPTIONS } from "./wageWithholding";

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
  combinedPlanDepositLimitCents,
  CONTRIBUTION_LIMIT_ASSUMPTIONS,
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
  taxableSocialSecurityCents,
  FEDERAL_TAX_BASE_YEAR,
  FEDERAL_TAX_ASSUMPTIONS,
  type FederalTaxTables,
  type OrdinaryBracket,
} from "./federalTax";
export { taxableWithdrawalCents, returnTaxTreatment } from "./investmentTax";
export {
  payrollTaxTables,
  payrollWithholdingParts,
  payrollWithholdingCents,
  payrollTaxReconciliationCents,
  PAYROLL_TAX_BASE_YEAR,
  PAYROLL_TAX_ASSUMPTIONS,
  OASDI_RATE,
  MEDICARE_RATE,
  ADDITIONAL_MEDICARE_RATE,
  ADDITIONAL_MEDICARE_THRESHOLD_CENTS,
  type PayrollTaxTables,
  type PayrollTaxParts,
} from "./payrollTax";
export {
  wageWithholdingCents,
  regularWageWithholdingCents,
  supplementalWageWithholdingCents,
  withholdingRateSchedules,
  defaultW4Configuration,
  SUPPLEMENTAL_WAGE_RATE,
  SUPPLEMENTAL_WAGE_EXCESS_RATE,
  SUPPLEMENTAL_WAGE_EXCESS_THRESHOLD_CENTS,
  WAGE_WITHHOLDING_ASSUMPTIONS,
  type W4Configuration,
  type WithholdingBracket,
  type WithholdingRateSchedules,
} from "./wageWithholding";

/**
 * @finley/rules — jurisdiction implementations of the engine's interface.
 *
 * Depends only on `@finley/engine`, to implement its interface, never the reverse — this
 * one-way dependency is the open-core boundary.
 *
 * `US-2026` implements the interface with real single-filer facts: the tax seam runs actual
 * federal brackets, the standard deduction, the capital-gains preference, and the
 * Social-Security inclusion formula ({@link import("./federalTax").federalAnnualTaxCents});
 * contribution limits, government benefit, RMDs, and health-cost benchmarks fill their own
 * seams.
 *
 * ⚠ Estimates, not advice. Figures change yearly and are jurisdiction-specific.
 */

export const usJurisdiction: Jurisdiction = {
  id: "US-2026",
  // ANNUAL in, ANNUAL out, and AUTHORITATIVE: the engine calls this once, at the year's close, on
  // the income that actually arrived. What payroll withheld against it during the year is a
  // separate and deliberately cruder figure; the difference is the refund or balance due.
  computeTaxCents: (annualByCategory, ctx) => federalAnnualTaxCents(annualByCategory, ctx.year),
  computeTaxByCategoryCents: (annualByCategory, ctx) =>
    federalAnnualTaxByCategoryCents(annualByCategory, ctx.year),
  // Paycheck-level income-tax withholding, Publication 15-T. WAGES ONLY: a pension draw, an RMD
  // or a realized gain reaches the engine through this seam like anything else and is answered
  // with zero, because no payroll system withholds against them — their tax lands in April.
  computeWageWithholdingCents: (request, ctx) =>
    request.taxCategory === "wages" ? wageWithholdingCents(request, ctx.year) : 0,
  // Employee FICA on EARNED income only: `wages`, never the `ordinaryIncome` a retirement
  // withdrawal books, so a 401(k)/IRA draw is never payroll-taxed. Fed one WAGE SOURCE's
  // year-to-date total, because that is the boundary a real employer withholds at — the wage base
  // and the Additional Medicare threshold apply to the wages this job paid and no others.
  computePayrollWithholdingCents: (earnedByCategory, ctx) =>
    payrollWithholdingCents(earnedByCategory.wages ?? 0, ctx.year),
  // Single earned category (`wages`), so the breakdown is trivial — but still required so
  // the waterfall can attribute FICA back to the job that generated it.
  computePayrollWithholdingByCategoryCents: (earnedByCategory, ctx) => {
    const charge = payrollWithholdingCents(earnedByCategory.wages ?? 0, ctx.year);
    return charge > 0 ? { wages: charge } : {};
  },
  // What the return squares up over a year of per-employer withholding: excess Social Security
  // back as a credit, Additional Medicare owed on combined wages. Exactly zero for the ordinary
  // single-job year, which is what keeps this from moving cash it has no business moving.
  reconcilePayrollTaxCents: (annualEarnedPerSource, ctx) =>
    payrollTaxReconciliationCents(
      annualEarnedPerSource.map((earned) => earned.wages ?? 0),
      ctx.year,
    ),
  taxableWithdrawalCents: (basis) => taxableWithdrawalCents(basis),
  returnTaxTreatment: (returnKind) => returnTaxTreatment(returnKind),
  publicHealthCoverageAge: MEDICARE_ELIGIBILITY_AGE,
  isCoveredEarnings,
  defaultBenefitClaimingAge: DEFAULT_BENEFIT_CLAIMING_AGE,
  governmentBenefitBaseMonthlyCents,
  colaAdjustedBenefitCents,
  requiredMinimumDistributionCents,
  retirementDeferralLimitCents,
  combinedPlanDepositLimitCents,
  healthCostBenchmarkMonthlyCents,
  modelAssumptions: [
    ...FEDERAL_TAX_ASSUMPTIONS,
    ...CONTRIBUTION_LIMIT_ASSUMPTIONS,
    ...RMD_ASSUMPTIONS,
    ...PAYROLL_TAX_ASSUMPTIONS,
    ...WAGE_WITHHOLDING_ASSUMPTIONS,
  ],
};
