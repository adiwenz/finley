import type { Cents, ModelAssumption } from "@finley/engine";

/**
 * Legislated single-filer federal-tax tables behind {@link federalTax}. Every US constant
 * lives HERE: brackets, deduction, cap-gains tops, Social Security inclusion thresholds,
 * and the forward-indexing knobs; the engine only ever states neutral per-category gross.
 *
 * ⚠ Estimates, not advice. Dollar figures are the pinned {@link FEDERAL_TAX_BASE_YEAR}
 * base; later years are indexed forward, earlier years return the base unchanged.
 */

// Single-filer dollar figures below come from the published IRS inflation adjustments and
// Tax Foundation 2026 projections.

export const FEDERAL_TAX_BASE_YEAR = 2026;

const BASE_STANDARD_DEDUCTION_CENTS: Cents = 16_100_00;

/**
 * LOWER edge (cents) plus the marginal `rate` above it, ascending; the last entry has no
 * upper edge. Rates are TCJA-era and legislation-set — only the thresholds index forward.
 */
const BASE_ORDINARY_BRACKETS: readonly OrdinaryBracket[] = [
  { lowerCents: 0, rate: 0.1 },
  { lowerCents: 12_400_00, rate: 0.12 },
  { lowerCents: 50_400_00, rate: 0.22 },
  { lowerCents: 105_700_00, rate: 0.24 },
  { lowerCents: 201_775_00, rate: 0.32 },
  { lowerCents: 256_225_00, rate: 0.35 },
  { lowerCents: 640_600_00, rate: 0.37 },
];

const BASE_LTCG_ZERO_TOP_CENTS: Cents = 49_450_00;
/** Above this top, the 20% rate. */
const BASE_LTCG_FIFTEEN_TOP_CENTS: Cents = 545_050_00;
export const LTCG_RATE_15 = 0.15;
export const LTCG_RATE_20 = 0.2;

// Social Security inclusion thresholds (single) are NOT indexed by law: the $25,000 /
// $34,000 provisional-income thresholds have been fixed in statute since 1984/1993, so
// unlike the brackets they are held flat across all years.

/** Below it, no benefit is taxable. */
export const SS_TIER_1_THRESHOLD_CENTS: Cents = 25_000_00;
/** Above it, up to 85% is taxable. */
export const SS_TIER_2_THRESHOLD_CENTS: Cents = 34_000_00;
/** Applied in the first tier and to the tier gap. */
export const SS_TIER_1_SHARE = 0.5;
/** The most of a benefit that can ever be taxed. */
export const SS_MAX_SHARE = 0.85;

// Forward indexing (mirrors contributionLimits / healthCosts).

/**
 * Assumed forward CPI indexing rate. Real figures index to inflation and round to a
 * legislated increment; the seam context has no year-by-year rate, so this stands in.
 * ⚠ Actual indexing is published yearly.
 */
const ASSUMED_ANNUAL_INDEXING_RATE = 0.025;

/** IRS rounding increment for bracket thresholds, the deduction, and cap-gains tops. */
const ROUND_50_CENTS: Cents = 50_00;

/**
 * Index a base-year figure forward to `year`, rounded DOWN to `incrementCents`. Years at
 * or before the base year return it UNCHANGED — no backward indexing, so the pinned
 * anchors stay cent-exact. Rounding down keeps the result monotonically non-decreasing as
 * the year advances.
 */
function indexForward(baseCents: Cents, year: number, incrementCents: Cents): Cents {
  const years = year - FEDERAL_TAX_BASE_YEAR;
  if (years <= 0) return baseCents;
  const indexed = baseCents * Math.pow(1 + ASSUMED_ANNUAL_INDEXING_RATE, years);
  return Math.floor(indexed / incrementCents) * incrementCents;
}

export interface OrdinaryBracket {
  readonly lowerCents: Cents;
  readonly rate: number;
}

/** Single-filer tables for one year; every dollar figure below is indexed to `year`. */
export interface FederalTaxTables {
  readonly year: number;
  readonly standardDeductionCents: Cents;
  readonly ordinaryBrackets: readonly OrdinaryBracket[];
  readonly capitalGainsZeroTopCents: Cents;
  readonly capitalGainsFifteenTopCents: Cents;
}

/**
 * {@link FEDERAL_TAX_BASE_YEAR} figures indexed forward to `year`. Rates are held; only
 * the dollar thresholds move.
 */
export function federalTaxTables(year: number): FederalTaxTables {
  return {
    year,
    standardDeductionCents: indexForward(BASE_STANDARD_DEDUCTION_CENTS, year, ROUND_50_CENTS),
    ordinaryBrackets: BASE_ORDINARY_BRACKETS.map((b) => ({
      lowerCents: indexForward(b.lowerCents, year, ROUND_50_CENTS),
      rate: b.rate,
    })),
    capitalGainsZeroTopCents: indexForward(BASE_LTCG_ZERO_TOP_CENTS, year, ROUND_50_CENTS),
    capitalGainsFifteenTopCents: indexForward(BASE_LTCG_FIFTEEN_TOP_CENTS, year, ROUND_50_CENTS),
  };
}

/**
 * User-facing disclosures for this module's federal-tax simplifications — the `rules` side
 * of {@link import("@finley/engine").Jurisdiction.modelAssumptions}, co-located by `id`
 * with the code they describe ({@link indexForward} /
 * {@link taxableSocialSecurityCents}). `usJurisdiction` hands these to the report's
 * "assumptions & simplifications" surface. ⚠ Estimates, not advice.
 */
export const FEDERAL_TAX_ASSUMPTIONS: readonly ModelAssumption[] = [
  {
    id: "taxThresholdForwardIndexing",
    text:
      "Federal tax figures — the income-tax brackets, the standard deduction, and the " +
      "0%/15% capital-gains thresholds — are grown forward at an assumed 2.5%/yr (a flat " +
      "stand-in for the IRS's yearly inflation adjustment), not the plan's own inflation " +
      "rate, and then rounded down to the nearest $50 to mirror the way the tax code " +
      "publishes these figures. The tax rates themselves are held constant. Actual figures " +
      "are legislated and published each year and will differ.",
  },
  {
    id: "socialSecurityThresholdsUnindexed",
    text:
      "The income levels that decide how much of your Social Security is taxable " +
      "($25,000 / $34,000 for a single filer) are frozen — held flat in every year — " +
      "because they are fixed in statute and, unlike the tax brackets, have never been " +
      "adjusted for inflation. As other income grows, this means more of your benefit " +
      "becomes taxable over time.",
  },
  {
    id: "capitalGainsAllLongTerm",
    text:
      "Every investment sale is taxed at the long-term capital-gains rates (0%/15%/20%), " +
      "however recently the money was invested. Real tax law charges the higher ordinary " +
      "income rates on a gain from anything held a year or less. The plan does not track " +
      "when each dollar went in, so a sale from an account you have been paying into " +
      "month after month — a savings goal funding a house, say — is treated as entirely " +
      "long-term. Wherever part of it would really be short-term, the tax shown is too " +
      "low and the money left over too high.",
  },
  {
    id: "taxAttributionProportional",
    text:
      "When the tax bill is broken out — by income type, or by individual job — each " +
      "slice is assigned in proportion to how much taxable income it contributed, not by " +
      "tracing which specific dollars fell in which bracket. Because the brackets are " +
      "progressive, an added source of income (a second job, say) is really taxed at a " +
      "higher rate than your average, so this breakdown shows each source's average share " +
      "of the tax rather than the extra tax that source alone caused. The whole bill is " +
      "exact; only the split between sources is an estimate.",
  },
];
