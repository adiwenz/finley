import type { Cents, TaxCategory } from "@finley/engine";

/**
 * US federal income tax for a SINGLE FILER (§5.3 seam 1) — the real policy behind
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
 * {@link federalAnnualTaxCents}; the monthly seam is the only thing `index.ts`
 * wires into the jurisdiction.
 *
 * NEUTRALITY (§5.0, from #50): every US constant — brackets, deduction, cap-gains
 * tops, inclusion thresholds — lives HERE, never in `packages/engine/src`. The
 * engine only states neutral per-category gross; this module owns the consequence.
 *
 * Filing status is fixed to SINGLE here (#53). The tax-unit grouping and the
 * MFJ/MFS/HoH tables are #52, which builds a status parameter on top of this.
 *
 * ⚠ Estimates, not advice. The FORMULA is modelled faithfully so the cent-pinned
 * base-year anchors hold, but the forward-indexed figures (and the law itself)
 * WILL drift. All dollar figures are the pinned {@link FEDERAL_TAX_BASE_YEAR}
 * base; later years are indexed forward, earlier years return the base unchanged.
 */

// ── Legislated base-year constants (one place, disclaimed — §5.4) ──────────────
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
const LTCG_RATE_15 = 0.15;
const LTCG_RATE_20 = 0.2;

// ── Social Security inclusion thresholds (single) — NOT indexed by law ─────────
//
// The $25,000 / $34,000 provisional-income thresholds have been FIXED in statute
// since 1984/1993 (never inflation-adjusted), so — unlike the brackets — they are
// deliberately held flat across all years. The share caps (50% / 85%) are the two
// inclusion ceilings the formula steps between.

/** First provisional-income threshold: below it, no benefit is taxable (single). */
const SS_TIER_1_THRESHOLD_CENTS: Cents = 25_000_00;
/** Second provisional-income threshold: above it, up to 85% is taxable (single). */
const SS_TIER_2_THRESHOLD_CENTS: Cents = 34_000_00;
/** Lower inclusion share, applied in the first tier and to the tier gap. */
const SS_TIER_1_SHARE = 0.5;
/** Upper inclusion ceiling — the most of a benefit that can ever be taxed. */
const SS_MAX_SHARE = 0.85;

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

/** The full structured single-filer tax tables for a year (§5.4 pattern). */
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
 * The taxable portion of a US government retirement benefit (Social Security) for a
 * SINGLE filer, from the provisional-income formula. `benefitCents` is the annual
 * benefit; `otherProvisionalIncomeCents` is everything else that counts toward
 * provisional income (ordinary income + capital gains + tax-exempt income), NOT
 * including the benefit itself. Half the benefit is added here to form provisional
 * income, then:
 *
 *   • below $25,000  → 0 taxable
 *   • $25,000–$34,000 → min(50% of benefit, 50% of the excess over $25,000)
 *   • above $34,000  → min(85% of benefit, 85% of the excess over $34,000 + the
 *                          tier-1 amount, itself capped at 50% of the $9,000 gap)
 *
 * The thresholds are fixed in statute (not indexed) — see the constants above.
 */
export function taxableSocialSecurityCents(
  benefitCents: Cents,
  otherProvisionalIncomeCents: Cents,
): Cents {
  const benefit = Math.max(0, benefitCents);
  if (benefit === 0) return 0;
  const provisional = Math.max(0, otherProvisionalIncomeCents) + benefit * SS_TIER_1_SHARE;

  if (provisional <= SS_TIER_1_THRESHOLD_CENTS) return 0;

  if (provisional <= SS_TIER_2_THRESHOLD_CENTS) {
    return Math.round(
      Math.min(benefit * SS_TIER_1_SHARE, (provisional - SS_TIER_1_THRESHOLD_CENTS) * SS_TIER_1_SHARE),
    );
  }

  // Above the second threshold: 85% of the excess over $34,000, plus the smaller of
  // the tier-1 fill (½ of the $9,000 gap → $4,500) or 50% of the benefit.
  const tierGapFill = Math.min(
    benefit * SS_TIER_1_SHARE,
    (SS_TIER_2_THRESHOLD_CENTS - SS_TIER_1_THRESHOLD_CENTS) * SS_TIER_1_SHARE,
  );
  const taxable = (provisional - SS_TIER_2_THRESHOLD_CENTS) * SS_MAX_SHARE + tierGapFill;
  return Math.round(Math.min(benefit * SS_MAX_SHARE, taxable));
}

/** Progressive tax on `taxableCents` through the ascending marginal `brackets`. */
function ordinaryTaxCents(taxableCents: Cents, brackets: readonly OrdinaryBracket[]): Cents {
  const taxable = Math.max(0, taxableCents);
  let tax = 0;
  for (let i = 0; i < brackets.length; i++) {
    const lower = brackets[i].lowerCents;
    if (taxable <= lower) break;
    const upper = i + 1 < brackets.length ? brackets[i + 1].lowerCents : Infinity;
    const bandTop = Math.min(taxable, upper);
    tax += (bandTop - lower) * brackets[i].rate;
  }
  return tax;
}

/**
 * Preferential long-term capital-gains tax on `gainsTaxableCents`, STACKED on top
 * of `ordinaryTaxableCents`: the gains fill the 0/15/20% bands that remain ABOVE
 * ordinary taxable income, so a high ordinary income pushes gains into the 15/20%
 * bands even when the gains alone would sit in the 0% band.
 */
function capitalGainsTaxCents(
  ordinaryTaxableCents: Cents,
  gainsTaxableCents: Cents,
  zeroTopCents: Cents,
  fifteenTopCents: Cents,
): Cents {
  const ordinary = Math.max(0, ordinaryTaxableCents);
  const gains = Math.max(0, gainsTaxableCents);
  if (gains === 0) return 0;
  const top = ordinary + gains;

  // Gains sitting below the 0% top pay nothing; the 15% band runs to its top; the
  // rest is 20%. Each band is the slice of [ordinary, top] inside that band.
  const zeroBand = Math.max(0, Math.min(top, zeroTopCents) - ordinary);
  const fifteenBand = Math.max(0, Math.min(top, fifteenTopCents) - Math.max(ordinary, zeroTopCents));
  const twentyBand = gains - zeroBand - fifteenBand;
  return fifteenBand * LTCG_RATE_15 + twentyBand * LTCG_RATE_20;
}

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
  const tables = federalTaxTables(year);
  const wages = Math.max(0, annualByCategory.wages ?? 0);
  const ordinaryOther = Math.max(0, annualByCategory.ordinaryIncome ?? 0);
  const gains = Math.max(0, annualByCategory.capitalGains ?? 0);
  const benefit = Math.max(0, annualByCategory.governmentRetirementBenefit ?? 0);
  const taxExempt = Math.max(0, annualByCategory.taxExempt ?? 0);

  const ordinaryNonBenefit = wages + ordinaryOther;

  // 1. Government-benefit inclusion. Provisional income is all other income that
  //    reaches AGI (ordinary + capital gains) plus tax-exempt interest — the last
  //    is never taxed itself but still counts toward the benefit test (§5.4).
  const taxableBenefit = taxableSocialSecurityCents(benefit, ordinaryNonBenefit + gains + taxExempt);

  // 2. Standard deduction: off ordinary income first, remainder off capital gains.
  const ordinaryTaxableGross = ordinaryNonBenefit + taxableBenefit;
  const deduction = tables.standardDeductionCents;
  const ordinaryTaxable = Math.max(0, ordinaryTaxableGross - deduction);
  const deductionRemainder = Math.max(0, deduction - ordinaryTaxableGross);
  const gainsTaxable = Math.max(0, gains - deductionRemainder);

  // 3. Ordinary brackets on ordinary taxable; 4. preferential rates on the gains,
  //    stacked on top of ordinary taxable income.
  const ordinaryTax = ordinaryTaxCents(ordinaryTaxable, tables.ordinaryBrackets);
  const gainsTax = capitalGainsTaxCents(
    ordinaryTaxable,
    gainsTaxable,
    tables.capitalGainsZeroTopCents,
    tables.capitalGainsFifteenTopCents,
  );

  return Math.round(ordinaryTax + gainsTax);
}

/**
 * The engine's §5.3 tax seam for the US single filer: MONTHLY per-category taxable
 * amounts in → this month's tax in cents out. Brackets are annual, so the monthly
 * slice is annualized (×12), taxed, and the month's 1/12 share returned — the
 * steady-state withholding approximation the projection runs each month. This is
 * the only entry point `index.ts` wires into {@link usJurisdiction}.
 */
export function computeFederalTaxCents(
  monthlyByCategory: Partial<Record<TaxCategory, Cents>>,
  year: number,
): Cents {
  const annualByCategory: Partial<Record<TaxCategory, Cents>> = {};
  for (const [category, cents] of Object.entries(monthlyByCategory)) {
    annualByCategory[category as TaxCategory] = (cents ?? 0) * 12;
  }
  return Math.round(federalAnnualTaxCents(annualByCategory, year) / 12);
}
