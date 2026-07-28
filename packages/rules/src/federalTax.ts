import type { Cents, TaxCategory } from "@finley/engine";
import { federalTaxParts, annualizeByCategory } from "./federalTaxCore";

// Legislated tables and constants live in ./federalTaxTables; re-exported so the `rules`
// barrel keeps resolving them through ./federalTax.
export {
  federalTaxTables,
  FEDERAL_TAX_BASE_YEAR,
  FEDERAL_TAX_ASSUMPTIONS,
  type FederalTaxTables,
  type OrdinaryBracket,
} from "./federalTaxTables";
// The shared rate core (Social Security inclusion, the federalTaxParts intermediate) lives
// in ./federalTaxCore; re-exported so it keeps resolving through ./federalTax.
export {
  taxableSocialSecurityCents,
  federalTaxParts,
  type FederalTaxParts,
} from "./federalTaxCore";
// Per-category attribution seams live in ./federalTaxAttribution (which reads the core
// federalTaxParts); re-exported so they keep resolving through ./federalTax.
export {
  federalAnnualTaxByCategoryCents,
  computeFederalTaxByCategoryCents,
} from "./federalTaxAttribution";

/**
 * US federal income tax for a SINGLE FILER (seam 1) — the policy behind the engine's
 * {@link import("@finley/engine").Jurisdiction.computeTaxCents} seam. The `rules`-side plug
 * the engine calls once per person to turn per-{@link TaxCategory} taxable amounts into tax
 * owed. Four things make it not-a-flat-rate:
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
 * The engine hands MONTHLY per-category slices; brackets are ANNUAL, so
 * {@link computeFederalTaxCents} annualizes (×12), runs the annual math, and returns the
 * month's 1/12 share — the steady-state withholding approximation. Pure annual math is
 * {@link federalAnnualTaxCents}; the shared rate core is ./federalTaxCore. The monthly seam
 * is the only thing `index.ts` wires into the jurisdiction.
 *
 * NEUTRALITY: every US constant — brackets, deduction, cap-gains tops, inclusion thresholds
 * — lives in ./federalTaxTables, never in `packages/engine/src`. The engine states neutral
 * per-category gross; this module owns the consequence.
 *
 * Filing status is fixed to SINGLE. Tax-unit grouping and MFJ/MFS/HoH tables are future work
 * layering a status parameter on top.
 *
 * ⚠ Estimates, not advice. The FORMULA is faithful so the cent-pinned base-year anchors
 * hold, but forward-indexed figures (and the law) WILL drift. All dollar figures are the
 * pinned {@link FEDERAL_TAX_BASE_YEAR} base; later years index forward, earlier years return
 * the base unchanged.
 */

/**
 * Pure ANNUAL single-filer federal income tax over per-category annual cents. Orders the
 * four pieces: benefit inclusion → ordinary brackets (after the standard deduction) →
 * capital-gains preference (deduction remainder stacked down onto gains, gains stacked up
 * onto ordinary). Monthly seam: {@link computeFederalTaxCents}.
 */
export function federalAnnualTaxCents(
  annualByCategory: Partial<Record<TaxCategory, Cents>>,
  year: number,
): Cents {
  return federalTaxParts(annualByCategory, year).totalCents;
}

/**
 * The engine's tax seam for the US single filer: MONTHLY per-category taxable amounts in →
 * this month's tax in cents out. Brackets are annual, so the slice is annualized (×12),
 * taxed, and its 1/12 share returned — the steady-state withholding approximation. The only
 * entry point `index.ts` wires into {@link usJurisdiction}.
 */
export function computeFederalTaxCents(
  monthlyByCategory: Partial<Record<TaxCategory, Cents>>,
  year: number,
): Cents {
  return Math.round(federalAnnualTaxCents(annualizeByCategory(monthlyByCategory), year) / 12);
}
