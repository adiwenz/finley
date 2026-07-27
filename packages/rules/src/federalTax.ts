import type { Cents, TaxCategory } from "@finley/engine";
import { federalTaxParts, annualizeByCategory } from "./federalTaxCore";

// The legislated tables and constants live in ./federalTaxTables; re-exported here
// so the `rules` barrel (index.ts) keeps resolving them through ./federalTax unchanged.
export {
  federalTaxTables,
  FEDERAL_TAX_BASE_YEAR,
  FEDERAL_TAX_ASSUMPTIONS,
  type FederalTaxTables,
  type OrdinaryBracket,
} from "./federalTaxTables";
// The shared rate core (Social Security inclusion, the federalTaxParts intermediate)
// lives in ./federalTaxCore; re-exported here so taxableSocialSecurityCents,
// federalTaxParts, and FederalTaxParts keep resolving through ./federalTax unchanged.
export {
  taxableSocialSecurityCents,
  federalTaxParts,
  type FederalTaxParts,
} from "./federalTaxCore";
// The per-category attribution seams live in ./federalTaxAttribution (which reads the
// core federalTaxParts). Re-exported here so the `rules` barrel and federalTax.test.ts
// keep resolving them through ./federalTax unchanged.
export {
  federalAnnualTaxByCategoryCents,
  computeFederalTaxByCategoryCents,
} from "./federalTaxAttribution";

/**
 * US federal income tax for a SINGLE FILER (seam 1) — the real policy behind
 * the engine's {@link import("@finley/engine").Jurisdiction.computeTaxCents} seam.
 *
 * This is the `rules`-side plug the engine calls once per person to turn a map of
 * per-{@link TaxCategory} taxable amounts into tax owed. It models the four things
 * that make US federal tax not-a-flat-rate for a single filer:
 *
 *   1. **Progressive ordinary brackets** — `wages` and `ordinaryIncome` (plus the
 *      taxable slice of the government benefit) climb the 10→37% bracket stack.
 *   2. **Standard deduction** — a flat exclusion off ordinary income first, then
 *      any unused remainder off capital gains (the deduction "stacks down").
 *   3. **Capital-gains preference** — `capitalGains` is taxed at the preferential
 *      0/15/20% rates, STACKED on top of ordinary taxable income (the gains fill
 *      the brackets left above ordinary income, not from zero).
 *   4. **Government-benefit inclusion** — only a portion of a `governmentRetire-
 *      mentBenefit` (US: Social Security) is taxable, set by the provisional-income
 *      formula (0 / up-to-50% / up-to-85%). `taxExempt` income is never taxed but
 *      DOES count toward provisional income, so it can pull the benefit into range.
 *
 * The engine hands MONTHLY per-category slices (it calls the seam each month). Tax
 * brackets are ANNUAL, so {@link computeFederalTaxCents} annualizes the slice
 * (×12), runs the annual math, and returns the month's 1/12 share — the standard
 * steady-state withholding approximation. The pure annual math is
 * {@link federalAnnualTaxCents}; the shared rate core (Social Security inclusion,
 * the {@link import("./federalTaxCore").federalTaxParts} intermediate) lives in
 * ./federalTaxCore; the monthly seam is the only thing `index.ts` wires into the
 * jurisdiction.
 *
 * NEUTRALITY: every US constant — brackets, deduction, cap-gains
 * tops, inclusion thresholds — lives in ./federalTaxTables, never in
 * `packages/engine/src`. The engine only states neutral per-category gross; this
 * module and its core own the consequence.
 *
 * Filing status is fixed to SINGLE here. The tax-unit grouping and the
 * MFJ/MFS/HoH tables are future work that would build a status parameter on top of this.
 *
 * ⚠ Estimates, not advice. The FORMULA is modelled faithfully so the cent-pinned
 * base-year anchors hold, but the forward-indexed figures (and the law itself)
 * WILL drift. All dollar figures are the pinned {@link FEDERAL_TAX_BASE_YEAR}
 * base; later years are indexed forward, earlier years return the base unchanged.
 */

/**
 * The pure ANNUAL single-filer federal income tax for a map of per-category taxable
 * amounts (annual cents). Orchestrates the four pieces: government-benefit
 * inclusion → ordinary brackets (after the standard deduction) → capital-gains
 * preference (deduction remainder stacked down onto gains, gains stacked up onto
 * ordinary). The monthly engine seam is {@link computeFederalTaxCents}.
 */
export function federalAnnualTaxCents(
  annualByCategory: Partial<Record<TaxCategory, Cents>>,
  year: number,
): Cents {
  return federalTaxParts(annualByCategory, year).totalCents;
}

/**
 * The engine's tax seam for the US single filer: MONTHLY per-category taxable
 * amounts in → this month's tax in cents out. Brackets are annual, so the monthly
 * slice is annualized (×12), taxed, and the month's 1/12 share returned — the
 * steady-state withholding approximation the projection runs each month. This is
 * the only entry point `index.ts` wires into {@link usJurisdiction}.
 */
export function computeFederalTaxCents(
  monthlyByCategory: Partial<Record<TaxCategory, Cents>>,
  year: number,
): Cents {
  return Math.round(federalAnnualTaxCents(annualizeByCategory(monthlyByCategory), year) / 12);
}
