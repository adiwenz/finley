import type {
  Cents,
  EarningsRecord,
  GovernmentBenefitClaim,
  GovernmentBenefitContext,
  TaxCategory,
} from "@finley/engine";

/**
 * Which income flows are Social-Security-covered. The benefit itself would be circular;
 * capital gains and tax-exempt income are not covered. `rules`-side plug for
 * {@link import("@finley/engine").Jurisdiction.isCoveredEarnings}.
 */
export function isCoveredEarnings(taxCategory: TaxCategory): boolean {
  return taxCategory === "wages" || taxCategory === "ordinaryIncome";
}

/**
 * US Social Security retirement benefit — the AIME→PIA bend-point formula.
 *
 * `rules`-side plug for
 * {@link import("@finley/engine").Jurisdiction.governmentBenefitBaseMonthlyCents} and
 * {@link import("@finley/engine").Jurisdiction.colaAdjustedBenefitCents}: the engine
 * owns the {@link EarningsRecord}, this module turns it into a base benefit and grows
 * it by COLA.
 *
 * ⚠ Estimates, not advice. The formula is faithful, but the forward-looking inputs —
 * future Average Wage Index, bend-point indexing, COLA, the law itself — are
 * approximated and WILL drift from an official SSA statement.
 */

// Legislated constants, one place. Each dollar figure is pinned to the base year it is
// exact for and indexed to other years by {@link AWI_ANNUAL_GROWTH}. All come from SSA's
// 2026 tables, so every base year is 2026; they stay separate constants so a refresh can
// move one figure without dragging the others.
//
//   • Bend points — https://www.ssa.gov/oact/cola/bendpoints.html
//   • Quarter of coverage — SSA COLA & other determinations for 2026 (Federal Register)
//     https://www.federalregister.gov/documents/2025/11/03/2025-19763/cost-of-living-increase-and-other-determinations-for-2026
//   • Wage base cap (held flat across years, so no indexing base year) —
//     https://www.ssa.gov/oact/cola/cbb.html
//
// Indexing is symmetric about each base year: earlier years scale down, later years up.
// A benefit claimed before the simulation start therefore needs no special case — the
// model is expressed in ages and each cohort's age-60 year, never the simulation clock.

/** Full retirement age, for the cohorts v1 models. */
const FRA_AGE = 67;

/**
 * Claiming age used for an unpinned person. Reaches the engine via the jurisdiction's
 * `defaultBenefitClaimingAge` seam so no US age lives in the engine.
 */
export const DEFAULT_BENEFIT_CLAIMING_AGE = FRA_AGE;

/**
 * Annual wage base (contribution & benefit base), SSA 2026. Real caps vary per year;
 * v1 applies this one to every year, slightly under-indexing very old high earnings.
 */
const WAGE_BASE_CAP_CENTS = 184_500_00;

/** PIA bend points (monthly, SSA 2026). PIA replaces 90% / 32% / 15% across them. */
const BEND_POINT_1_CENTS = 1_286_00;
const BEND_POINT_2_CENTS = 7_749_00;

/**
 * The age-60 wage-index year the bend-point constants are expressed in — their SSA
 * publication year.
 *
 * Subtlety: SSA labels bend points by year of first *eligibility* (age 62), but their
 * dollar amounts are indexed off the Average Wage Index two years earlier — the age-60
 * year, the same wage level earnings are indexed to (see {@link aimeCents}), which is
 * what makes the tier split apples-to-apples. Unindexed, a future cohort's AIME would
 * be sliced by present-day bend points, dumping nearly all of it into the bottom 15%
 * tier. The flat AWI rate leaves no distinct age-62 figure to track.
 */
const BEND_POINT_BASE_YEAR = 2026;

/**
 * Average-wage-index growth: indexes past earnings to the year the worker turns 60
 * (earnings from 60 on are taken at face value) and re-indexes the bend points to that
 * same cohort year. One assumed rate stands in for the real per-year SSA AWI series —
 * the biggest v1 approximation.
 */
const AWI_ANNUAL_GROWTH = 0.035;

const AIME_YEARS = 35;
const AIME_MONTHS = AIME_YEARS * 12;

/** Credits ("quarters of coverage") to be fully insured; 40 ≈ 10 years of covered work. */
const FULLY_INSURED_CREDITS = 40;

/** Most credits a single calendar year can earn (US: annual-earnings-based since 1978). */
const MAX_CREDITS_PER_YEAR = 4;

/**
 * Covered earnings that buy one credit, in {@link QUARTER_OF_COVERAGE_BASE_YEAR}
 * dollars. AWI-indexed to each earnings year.
 */
const QUARTER_OF_COVERAGE_CENTS = 1_890_00;
const QUARTER_OF_COVERAGE_BASE_YEAR = 2026;

/** Index factor for `year`'s earnings, indexed up to `indexingYear` (1.0 at/after it). */
function indexFactor(year: number, indexingYear: number): number {
  if (year >= indexingYear) return 1;
  return Math.pow(1 + AWI_ANNUAL_GROWTH, indexingYear - year);
}

/**
 * Average Indexed Monthly Earnings: cap each year at the wage base, index it to the
 * age-60 year, take the highest 35 indexed years (missing years count as 0), divide by
 * 420 months. Truncated to a whole dollar, as SSA does.
 */
function aimeCents(record: EarningsRecord, indexingYear: number): Cents {
  const indexed: Cents[] = [];
  for (const [year, wageCents] of record.annualWagesCents) {
    const capped = Math.min(wageCents, WAGE_BASE_CAP_CENTS);
    indexed.push(Math.round(capped * indexFactor(year, indexingYear)));
  }
  indexed.sort((a, b) => b - a);
  let sum = 0;
  for (let i = 0; i < AIME_YEARS; i++) sum += indexed[i] ?? 0;
  const raw = sum / AIME_MONTHS;
  return Math.floor(raw / 100) * 100;
}

/**
 * Total credits across the record: each year buys
 * `min(4, floor(annual covered wages / quarter-of-coverage))`, the threshold
 * AWI-indexed to that earnings year.
 */
function totalCredits(record: EarningsRecord): number {
  let credits = 0;
  for (const [year, wageCents] of record.annualWagesCents) {
    const qocThreshold =
      QUARTER_OF_COVERAGE_CENTS *
      Math.pow(1 + AWI_ANNUAL_GROWTH, year - QUARTER_OF_COVERAGE_BASE_YEAR);
    credits += Math.min(MAX_CREDITS_PER_YEAR, Math.floor(wageCents / qocThreshold));
  }
  return credits;
}

/**
 * The two PIA bend points for a cohort whose earnings are indexed to `indexingYear`
 * (their age-60 year). Rounded to the whole dollar, as SSA publishes them.
 */
function bendPointsCents(indexingYear: number): { bend1: Cents; bend2: Cents } {
  const scale = Math.pow(1 + AWI_ANNUAL_GROWTH, indexingYear - BEND_POINT_BASE_YEAR);
  return {
    bend1: Math.round((BEND_POINT_1_CENTS * scale) / 100) * 100,
    bend2: Math.round((BEND_POINT_2_CENTS * scale) / 100) * 100,
  };
}

/** Primary Insurance Amount: the 90/32/15 bend-point sum of AIME, truncated to the dime. */
function piaCents(aime: Cents, bend1: Cents, bend2: Cents): Cents {
  const tier1 = 0.9 * Math.min(aime, bend1);
  const tier2 = 0.32 * Math.max(0, Math.min(aime, bend2) - bend1);
  const tier3 = 0.15 * Math.max(0, aime - bend2);
  const pia = tier1 + tier2 + tier3;
  return Math.floor(pia / 10) * 10; // truncate to next lower dime
}

/**
 * Claiming-age adjustment relative to FRA: reduced for early claiming (5/9% per
 * month for the first 36, 5/12% beyond) and credited for delayed claiming
 * (2/3% per month, i.e. 8%/yr). Claiming age is clamped to the legal 62–70 range.
 */
function claimingFactor(claimingAge: number): number {
  const age = Math.max(62, Math.min(70, claimingAge));
  const months = (age - FRA_AGE) * 12;
  if (months === 0) return 1;
  if (months < 0) {
    const early = -months;
    const first = Math.min(early, 36) * (5 / 9);
    const rest = Math.max(0, early - 36) * (5 / 12);
    return 1 - (first + rest) / 100;
  }
  return 1 + months * (2 / 3) / 100;
}

/**
 * Age of first eligibility under US law — the age the COLA factor is measured from. The
 * engine holds only the opaque base and asks {@link colaAdjustedBenefitCents} to grow
 * it, never seeing this constant.
 */
const SS_ELIGIBILITY_AGE = 62;

/**
 * Base benefit (nominal cents, eligibility-age dollars): `PIA × claimingFactor`. The
 * engine caches it as an opaque base and grows it via
 * {@link colaAdjustedBenefitCents}. Empty record → 0.
 */
export function governmentBenefitBaseMonthlyCents(claim: GovernmentBenefitClaim): Cents {
  const { record, claimYear, claimingAge, currentAge } = claim;
  if (record.annualWagesCents.size === 0) return 0;
  // Eligibility gate lives inside the base function: not fully insured, no benefit.
  if (totalCredits(record) < FULLY_INSURED_CREDITS) return 0;
  // Index to the age-60 year: birthYear + 60, birthYear = claimYear − currentAge.
  const indexingYear = claimYear - currentAge + 60;
  const { bend1, bend2 } = bendPointsCents(indexingYear);
  const pia = piaCents(aimeCents(record, indexingYear), bend1, bend2);
  return Math.round(pia * claimingFactor(claimingAge));
}

/**
 * COLA on a frozen base benefit: `baseCents × (1 + colaRate)^(currentAge − 62)`. COLAs
 * accrue from age-62 eligibility whether or not the person has claimed, so one factor
 * measured from 62 collapses both the 62→claim bridge and post-claim growth. Over the
 * modelled 62–70 claiming range the exponent is ≥ 0.
 */
export function colaAdjustedBenefitCents(baseCents: Cents, ctx: GovernmentBenefitContext): Cents {
  const colaYears = ctx.currentAge - SS_ELIGIBILITY_AGE;
  return Math.round(baseCents * Math.pow(1 + ctx.colaRate, colaYears));
}
