import type { Cents, TaxCategory } from "@finley/engine";
import { federalTaxParts } from "./federalTaxCore";

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
export { federalAnnualTaxByCategoryCents } from "./federalTaxAttribution";

/**
 * US federal income tax, SINGLE FILER (seam 1): {@link federalAnnualTaxCents} is the
 * `rules`-side plug behind the engine's
 * {@link import("@finley/engine").Jurisdiction.computeTaxCents} seam, called once per person
 * with a full calendar year's taxable-by-category (or the engine's YTD estimate of it) — the
 * engine, not this module, turns a month's flows into that annual figure and reconciles the
 * liability back down to a monthly charge.
 *
 * Ordinary brackets 10→37%; the standard deduction off ordinary income first, its
 * remainder stacking down onto gains; `capitalGains` at 0/15/20% stacked ON TOP of
 * ordinary taxable income; only part of a `governmentRetirementBenefit` (US: Social Security)
 * taxable, by provisional income (0 / up-to-50% / up-to-85%). `taxExempt` income is untaxed
 * but raises provisional income, pulling the benefit into range.
 *
 * NEUTRALITY: every US constant lives in ./federalTaxTables, never in `packages/engine/src`.
 *
 * ⚠ Estimates, not advice. Dollar figures are the pinned {@link FEDERAL_TAX_BASE_YEAR} base;
 * later years index forward, earlier years return the base unchanged.
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
