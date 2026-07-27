import type { Cents, ModelAssumption } from "@finley/engine";

/**
 * Legislated single-filer federal-tax tables and constants — the pinned
 * base-year facts behind {@link federalTax}. Every US constant lives HERE:
 * brackets, deduction, cap-gains tops, Social Security inclusion thresholds, and
 * the forward-indexing knobs. The core bracket math in `federalTax.ts` and the
 * attribution helpers in `federalTaxAttribution.ts` import these; the engine only ever
 * states neutral per-category gross.
 *
 * ⚠ Estimates, not advice. Dollar figures are the pinned {@link FEDERAL_TAX_BASE_YEAR}
 * base; later years are indexed forward, earlier years return the base unchanged.
 */

// ── Legislated base-year constants (one place, disclaimed) ─────────────────────
//
// Single-filer figures pinned to 2026 (projected inflation-adjusted brackets,
// standard deduction, and long-term capital-gains bracket tops). Sources are the
// published IRS inflation adjustments / Tax Foundation 2026 projections. Every
// dollar figure below is authoritative for {@link FEDERAL_TAX_BASE_YEAR} and
// indexed forward by {@link ASSUMED_ANNUAL_INDEXING_RATE} for later years.

/** The calendar year the pinned dollar figures below are authoritative for. */
export const FEDERAL_TAX_BASE_YEAR = 2026;

/** Single-filer standard deduction, 2026 base. */
const BASE_STANDARD_DEDUCTION_CENTS: Cents = 16_100_00;

/**
 * Single-filer ordinary-income brackets, 2026 base — each is the LOWER edge of the
 * band (cents) and the marginal `rate` that applies above it, ascending. The last
 * entry has no upper edge (top marginal rate). Rates are TCJA-era and legislation-
 * set; only the thresholds index forward.
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

/** Top of the 0% long-term capital-gains bracket (single), 2026 base. */
const BASE_LTCG_ZERO_TOP_CENTS: Cents = 49_450_00;
/** Top of the 15% long-term capital-gains bracket (single), 2026 base; above it is 20%. */
const BASE_LTCG_FIFTEEN_TOP_CENTS: Cents = 545_050_00;
/** Preferential long-term capital-gains rates for the two taxed bands. */
export const LTCG_RATE_15 = 0.15;
export const LTCG_RATE_20 = 0.2;

// ── Social Security inclusion thresholds (single) — NOT indexed by law ─────────
//
// The $25,000 / $34,000 provisional-income thresholds have been FIXED in statute
// since 1984/1993 (never inflation-adjusted), so — unlike the brackets — they are
// deliberately held flat across all years. The share caps (50% / 85%) are the two
// inclusion ceilings the formula steps between.

/** First provisional-income threshold: below it, no benefit is taxable (single). */
export const SS_TIER_1_THRESHOLD_CENTS: Cents = 25_000_00;
/** Second provisional-income threshold: above it, up to 85% is taxable (single). */
export const SS_TIER_2_THRESHOLD_CENTS: Cents = 34_000_00;
/** Lower inclusion share, applied in the first tier and to the tier gap. */
export const SS_TIER_1_SHARE = 0.5;
/** Upper inclusion ceiling — the most of a benefit that can ever be taxed. */
export const SS_MAX_SHARE = 0.85;

// ── Forward indexing (mirrors contributionLimits / healthCosts) ────────────────

/**
 * Assumed forward CPI indexing rate for the brackets, standard deduction, and
 * cap-gains tops. Real figures are indexed to inflation and rounded to a
 * legislated increment; the seam context has no year-by-year rate, so this rules-
 * side estimate stands in. ⚠ Estimate — actual indexing is published yearly.
 */
const ASSUMED_ANNUAL_INDEXING_RATE = 0.025;

/** IRS rounding increment for bracket thresholds, the deduction, and cap-gains tops. */
const ROUND_50_CENTS: Cents = 50_00;

/**
 * Index a base-year figure forward to `year`, rounded DOWN to `incrementCents`.
 * Years at or before the base year return the base UNCHANGED — no backward
 * indexing, so the pinned base-year anchors stay cent-exact. Rounding down keeps
 * the result monotonically non-decreasing as the year advances (mirrors
 * `contributionLimits.indexForward` / `healthCosts.indexForward`).
 */
function indexForward(baseCents: Cents, year: number, incrementCents: Cents): Cents {
  const years = year - FEDERAL_TAX_BASE_YEAR;
  if (years <= 0) return baseCents;
  const indexed = baseCents * Math.pow(1 + ASSUMED_ANNUAL_INDEXING_RATE, years);
  return Math.floor(indexed / incrementCents) * incrementCents;
}

/** A single ordinary-income bracket: the lower edge (cents) and its marginal rate. */
export interface OrdinaryBracket {
  readonly lowerCents: Cents;
  readonly rate: number;
}

/** The full structured single-filer tax tables for a year. */
export interface FederalTaxTables {
  readonly year: number;
  /** Standard deduction (single), indexed to `year`. */
  readonly standardDeductionCents: Cents;
  /** Ordinary brackets (single), lower-edge + marginal rate, ascending, indexed to `year`. */
  readonly ordinaryBrackets: readonly OrdinaryBracket[];
  /** Top of the 0% long-term capital-gains bracket, indexed to `year`. */
  readonly capitalGainsZeroTopCents: Cents;
  /** Top of the 15% long-term capital-gains bracket, indexed to `year`. */
  readonly capitalGainsFifteenTopCents: Cents;
}

/**
 * The single-filer tax tables for `year`: the pinned base-year figures
 * ({@link FEDERAL_TAX_BASE_YEAR}) indexed forward. Rates are held; only the
 * dollar thresholds move.
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
 * User-facing disclosures for the federal-tax simplifications this module makes — the
 * `rules` side of the engine's {@link import("@finley/engine").Jurisdiction.modelAssumptions}
 * seam, co-located by `id` with the code they describe ({@link indexForward} /
 * {@link taxableSocialSecurityCents}), exactly as the engine co-locates its own
 * {@link import("@finley/engine").MODEL_ASSUMPTIONS}. `usJurisdiction` hands these to the
 * report so the "assumptions & simplifications" surface explains why a threshold moves
 * (or doesn't) year to year. ⚠ Estimates, not advice.
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
