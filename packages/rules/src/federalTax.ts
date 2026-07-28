import type { Cents, TaxCategory } from "@finley/engine";
import { federalTaxParts, annualizeByCategory } from "./federalTaxCore";

// Re-exported so the `rules` barrel keeps resolving these through ./federalTax.
export {
  federalTaxTables,
  FEDERAL_TAX_BASE_YEAR,
  FEDERAL_TAX_ASSUMPTIONS,
  type FederalTaxTables,
  type OrdinaryBracket,
} from "./federalTaxTables";
export {
  taxableSocialSecurityCents,
  federalTaxParts,
  type FederalTaxParts,
} from "./federalTaxCore";
export {
  federalAnnualTaxByCategoryCents,
  computeFederalTaxByCategoryCents,
} from "./federalTaxAttribution";

/**
 * US federal income tax for a SINGLE FILER (seam 1) — the `rules`-side plug behind the
 * engine's {@link import("@finley/engine").Jurisdiction.computeTaxCents} seam, called once
 * per person. Four things make it not-a-flat-rate:
 *
 *   1. **Progressive ordinary brackets** — `wages` and `ordinaryIncome` (plus the taxable
 *      slice of the government benefit) climb the 10→37% stack.
 *   2. **Standard deduction** — off ordinary income first, then any unused remainder off
 *      capital gains (it "stacks down").
 *   3. **Capital-gains preference** — `capitalGains` taxed at 0/15/20%, STACKED on top of
 *      ordinary taxable income (gains fill the brackets left above it, not from zero).
 *   4. **Government-benefit inclusion** — only a portion of a `governmentRetirementBenefit`
 *      (US: Social Security) is taxable, set by the provisional-income formula (0 /
 *      up-to-50% / up-to-85%). `taxExempt` income is never taxed but DOES count toward
 *      provisional income, so it can pull the benefit into range.
 *
 * {@link computeFederalTaxCents} is the only thing `index.ts` wires into the jurisdiction.
 *
 * NEUTRALITY: every US constant — brackets, deduction, cap-gains tops, inclusion
 * thresholds — lives in ./federalTaxTables, never in `packages/engine/src`.
 *
 * Filing status is fixed to SINGLE; MFJ/MFS/HoH tables would layer a status parameter on
 * top.
 *
 * ⚠ Estimates, not advice. All dollar figures are the pinned
 * {@link FEDERAL_TAX_BASE_YEAR} base; later years index forward, earlier years return the
 * base unchanged.
 */

/**
 * Orders the four pieces: benefit inclusion → ordinary brackets (after the standard
 * deduction) → capital-gains preference (deduction remainder stacked down onto gains, gains
 * stacked up onto ordinary).
 */
export function federalAnnualTaxCents(
  annualByCategory: Partial<Record<TaxCategory, Cents>>,
  year: number,
): Cents {
  return federalTaxParts(annualByCategory, year).totalCents;
}

/**
 * MONTHLY per-category taxable amounts in → this month's tax out. The slice is annualized
 * (×12), taxed, and its 1/12 share returned — the steady-state withholding approximation.
 */
export function computeFederalTaxCents(
  monthlyByCategory: Partial<Record<TaxCategory, Cents>>,
  year: number,
): Cents {
  return Math.round(federalAnnualTaxCents(annualizeByCategory(monthlyByCategory), year) / 12);
}
