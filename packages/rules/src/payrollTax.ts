import type { Cents, ModelAssumption } from "@finley/engine";

/**
 * US federal PAYROLL tax, SINGLE FILER — the FICA rate-and-threshold tables plus the pure
 * annual computation. This is the `rules`-side data behind an engine payroll seam that
 * charges tax on EARNED income (wages / self-employment), distinct from the income-tax seam
 * in {@link federalTax}.
 *
 * Three components, employee side only (the plan models the worker's own withholding):
 *   • OASDI (Social Security) — 6.2% up to an annual per-person taxable maximum; nothing above.
 *   • Medicare — 1.45% on ALL earned income, no cap.
 *   • Additional Medicare — 0.9% surtax on earned income over a fixed statutory threshold;
 *     employee-only, with no employer match.
 *
 * NEUTRALITY: every US constant lives HERE, never in `packages/engine/src`.
 *
 * ⚠ Estimates, not advice. Dollar figures are the pinned {@link PAYROLL_TAX_BASE_YEAR} base;
 * later years index forward (the wage base by WAGE growth, see {@link AWI_ANNUAL_INDEXING_RATE}),
 * earlier years return the base unchanged.
 */

export const PAYROLL_TAX_BASE_YEAR = 2026;

/**
 * Employee-share statutory rates. The employer matches OASDI and Medicare, but the plan
 * charges only the worker's own withholding, so the employer half is never added here.
 * Rates are legislation-set and held constant across years — only the wage base moves.
 */
export const OASDI_RATE = 0.062;
export const MEDICARE_RATE = 0.0145;
/** No employer match on the surtax, so this is the whole rate the worker bears. */
export const ADDITIONAL_MEDICARE_RATE = 0.009;

/** SSA 2026 OASDI taxable maximum (a multiple of the $300 statutory rounding increment). */
const BASE_OASDI_WAGE_BASE_CENTS: Cents = 184_500_00;

/**
 * The OASDI taxable maximum indexes to the national Average Wage Index, NOT CPI. AWI has
 * historically outrun CPI by the economy's real wage growth, so reusing the income-tax
 * side's CPI proxy would let the cap drift progressively too low and over-tax high earners
 * further into a decades-long projection — a compounding error, not a rounding one. This
 * rate is the wage-growth stand-in, deliberately higher than {@link federalTax}'s CPI proxy.
 * ⚠ Actual AWI is a published per-year series and will differ.
 */
const AWI_ANNUAL_INDEXING_RATE = 0.035;

/**
 * Additional Medicare threshold (single), fixed in statute since 2013 and — unlike the wage
 * base — NEVER indexed. Held flat across every year, mirroring the Social-Security
 * benefit-inclusion thresholds in {@link federalTaxTables}. As earned income grows, more of
 * it crosses this frozen line over time.
 */
export const ADDITIONAL_MEDICARE_THRESHOLD_CENTS: Cents = 200_000_00;

/** SSA rounds the wage base to a multiple of $300. */
const ROUND_300_CENTS: Cents = 300_00;

/**
 * Index the wage base forward to `year` at the AWI rate, rounded DOWN to `incrementCents`.
 * Years at or before the base year return it UNCHANGED — no backward indexing, so the pinned
 * anchor stays cent-exact. Rounding down keeps the cap monotonically non-decreasing as the
 * year advances (statute rounds to the NEAREST $300; rounding down instead trades that for
 * monotonicity, matching {@link federalTaxTables}'s forward indexing).
 */
function indexWageBaseForward(baseCents: Cents, year: number, incrementCents: Cents): Cents {
  const years = year - PAYROLL_TAX_BASE_YEAR;
  if (years <= 0) return baseCents;
  const indexed = baseCents * Math.pow(1 + AWI_ANNUAL_INDEXING_RATE, years);
  return Math.floor(indexed / incrementCents) * incrementCents;
}

/** Single-filer payroll-tax tables for one year; only the wage base is indexed. */
export interface PayrollTaxTables {
  readonly year: number;
  readonly oasdiWageBaseCents: Cents;
  readonly oasdiRate: number;
  readonly medicareRate: number;
  readonly additionalMedicareRate: number;
  readonly additionalMedicareThresholdCents: Cents;
}

/**
 * {@link PAYROLL_TAX_BASE_YEAR} figures resolved for `year`. The wage base grows by AWI; the
 * rates and the Additional Medicare threshold are held flat.
 */
export function payrollTaxTables(year: number): PayrollTaxTables {
  return {
    year,
    oasdiWageBaseCents: indexWageBaseForward(BASE_OASDI_WAGE_BASE_CENTS, year, ROUND_300_CENTS),
    oasdiRate: OASDI_RATE,
    medicareRate: MEDICARE_RATE,
    additionalMedicareRate: ADDITIONAL_MEDICARE_RATE,
    additionalMedicareThresholdCents: ADDITIONAL_MEDICARE_THRESHOLD_CENTS,
  };
}

/** The three employee-side payroll components for a year, plus their sum. */
export interface PayrollTaxParts {
  readonly oasdiCents: Cents;
  readonly medicareCents: Cents;
  readonly additionalMedicareCents: Cents;
  readonly totalCents: Cents;
}

/**
 * Employee-side payroll tax on a person's COMBINED annual earned income for `year`.
 *
 * Multi-job choice: the argument is the person's total earned income across ALL jobs, so the
 * wage base and surtax threshold each apply ONCE to the combined figure. This models the true
 * single-cap the worker owes on their return, not the per-employer over-withhold-then-refund
 * cash-flow — simpler and more accurate for planning, at the cost of the intra-year timing of
 * a refund.
 *
 * Annual, per person, per calendar year: OASDI stops once cumulative earnings reach the wage
 * base, so a mid-year seam must ACCUMULATE rather than annualize each month's slice (a level
 * earner is unaffected, a lumpy one would be mis-capped every month). Accumulation is the
 * engine's job; this function states the correct WHOLE-YEAR answer the accumulator settles to.
 */
export function payrollTaxParts(annualEarnedCents: Cents, year: number): PayrollTaxParts {
  const t = payrollTaxTables(year);
  const oasdiCents = Math.round(Math.min(annualEarnedCents, t.oasdiWageBaseCents) * t.oasdiRate);
  const medicareCents = Math.round(annualEarnedCents * t.medicareRate);
  const surtaxBase = Math.max(0, annualEarnedCents - t.additionalMedicareThresholdCents);
  const additionalMedicareCents = Math.round(surtaxBase * t.additionalMedicareRate);
  return {
    oasdiCents,
    medicareCents,
    additionalMedicareCents,
    totalCents: oasdiCents + medicareCents + additionalMedicareCents,
  };
}

/** Scalar total behind {@link payrollTaxParts} — the whole-year employee payroll tax. */
export function payrollTaxCents(annualEarnedCents: Cents, year: number): Cents {
  return payrollTaxParts(annualEarnedCents, year).totalCents;
}

/**
 * User-facing disclosures for this module's payroll-tax simplifications — the `rules` side of
 * {@link import("@finley/engine").Jurisdiction.modelAssumptions}, co-located by `id` with the
 * code they describe. Exported for the engine payroll seam to concatenate onto the jurisdiction
 * once it charges FICA; kept out of the live `usJurisdiction` set until then so the report never
 * discloses a tax the model is not yet applying.
 */
export const PAYROLL_TAX_ASSUMPTIONS: readonly ModelAssumption[] = [
  {
    id: "oasdiWageBaseWageIndexed",
    text:
      "The Social-Security wage cap — the ceiling above which the 6.2% Social-Security tax " +
      "stops (Medicare's 1.45% continues) — is grown forward at an assumed 3.5%/yr. That is " +
      "faster than the rate used for the income-tax brackets, because this cap by law tracks " +
      "average WAGES, which tend to rise faster than prices. Using the slower price rate would " +
      "let the cap fall behind over a long plan and overstate the Social-Security tax on higher " +
      "earners. The actual cap is announced each year and will differ.",
  },
  {
    id: "additionalMedicareThresholdUnindexed",
    text:
      "The $200,000 income level where the extra 0.9% Additional Medicare Tax kicks in is " +
      "frozen — held flat in every year — because it is fixed in statute and has never been " +
      "adjusted for inflation. As earnings grow, more of them fall above this line over time.",
  },
];
