import type { Cents, EarningsRecord, GovernmentBenefitContext, TaxCategory } from "@finley/engine";

/**
 * Which income flows count as US Social-Security-covered earnings (§5.4). Wages and
 * self-employment (`ordinaryIncome`) are covered; the benefit itself would be
 * circular, and capital gains and tax-exempt income are not covered. This is the
 * `rules`-side plug for {@link import("@finley/engine").Jurisdiction.isCoveredEarnings}
 * — the fact of what counts is a jurisdiction one, not an engine one.
 */
export function isCoveredEarnings(taxCategory: TaxCategory): boolean {
  return taxCategory === "wages" || taxCategory === "ordinaryIncome";
}

/**
 * US Social Security retirement benefit — the AIME→PIA bend-point formula (§5.4).
 *
 * This is the `rules`-side plug for the engine's
 * {@link import("@finley/engine").Jurisdiction.socialSecurityMonthlyBenefitCents}
 * seam. The engine owns and accumulates the {@link EarningsRecord}; this module
 * turns that record into a monthly benefit at a pinned claiming age.
 *
 * ⚠ Estimates, not advice. The FORMULA (bend points, 35-year indexing, claiming
 * adjustment) is modelled faithfully so the cent-pinned anchor holds, but the
 * FORWARD-looking figures it feeds on — future Average Wage Index, bend-point
 * indexing, COLA, and the law itself — are approximated with the constants below
 * and WILL drift from an official SSA statement. All values are legislation-set
 * and change yearly; they live here, in one place, behind the pluggable
 * jurisdiction concept (never hardcoded in the engine).
 */

// ── Legislated constants (one place, disclaimed — §5.4 open decision) ──────────

/** Full retirement age (FRA) for the cohorts v1 models. */
const FRA_AGE = 67;

/**
 * Annual Social Security wage base (contribution & benefit base). Real SSA caps
 * vary per year; v1 applies the current cap to every year — a documented
 * simplification that under-indexes very old high earnings slightly.
 */
const WAGE_BASE_CAP_CENTS = 168_600_00;

/** PIA bend points (monthly, current formula). PIA replaces 90% / 32% / 15% across them. */
const BEND_POINT_1_CENTS = 1_174_00;
const BEND_POINT_2_CENTS = 7_078_00;

/**
 * The age-60 wage-index year the bend-point constants above are calibrated to.
 *
 * Subtlety: SSA ties your PIA formula to your year of first *eligibility* (age
 * 62), so the bend points are conventionally labelled by that year. But their
 * dollar amounts are indexed off the national Average Wage Index from two years
 * earlier — the year you turn 60 — which is the SAME wage level your earnings are
 * indexed to (see {@link aimeCents}). So the AIME and the bend points that carve
 * it into tiers both live in age-60-year dollars; that shared era is what makes
 * the split apples-to-apples. Without re-indexing, a future cohort's AIME (scaled
 * forward to their age-60 year) would be sliced by present-day bend points,
 * dumping almost all of it into the bottom 15% tier and understating the benefit
 * in real terms. We mirror this by scaling the constants to the worker's age-60
 * year by {@link AWI_ANNUAL_GROWTH}; the single flat AWI rate means there is no
 * distinct age-62 figure to track. Chosen so the cent-pinned anchor below
 * (age-60 year 2019) uses the constants unscaled.
 */
const BEND_POINT_BASE_YEAR = 2019;

/**
 * Average-wage-index growth used to index past earnings to the year the worker
 * turns 60 (earnings from age 60 on are taken at face value), and to re-index the
 * bend points to that same cohort year. A single assumed rate stands in for the
 * real per-year AWI series — the biggest v1 approximation.
 */
const AWI_ANNUAL_GROWTH = 0.035;

/** Highest N indexed years enter AIME; the divisor is N years × 12 months. */
const AIME_YEARS = 35;
const AIME_MONTHS = AIME_YEARS * 12;

// ── Formula ────────────────────────────────────────────────────────────────

/** Index factor for `year`'s earnings, indexed up to `indexingYear` (1.0 at/after it). */
function indexFactor(year: number, indexingYear: number): number {
  if (year >= indexingYear) return 1;
  return Math.pow(1 + AWI_ANNUAL_GROWTH, indexingYear - year);
}

/**
 * Average Indexed Monthly Earnings: cap each year at the wage base, index it to
 * the age-60 year, take the highest 35 indexed years (missing years count as 0),
 * and divide the sum by 420 months. Truncated to a whole dollar, as SSA does.
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
  return Math.floor(raw / 100) * 100; // truncate to whole dollar
}

/**
 * The two PIA bend points (monthly cents) for a cohort whose earnings are indexed
 * to `indexingYear` (their age-60 year), scaled from the base-year constants by
 * the assumed AWI growth. Rounded to the whole dollar, as SSA publishes them.
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
 * Monthly Social Security benefit (nominal cents) for a claiming person. The
 * engine calls this once, at claiming age, with the accumulated earnings record.
 */
export function socialSecurityMonthlyBenefitCents(
  record: EarningsRecord,
  ctx: GovernmentBenefitContext,
): Cents {
  if (record.annualWagesCents.size === 0) return 0;
  // Earnings are indexed to the year the worker turns 60: birthYear + 60, and
  // birthYear = benefit year − age in that year (ctx.year, ctx.currentAge).
  const indexingYear = ctx.year - ctx.currentAge + 60;
  const { bend1, bend2 } = bendPointsCents(indexingYear);
  const pia = piaCents(aimeCents(record, indexingYear), bend1, bend2);
  return Math.round(pia * claimingFactor(ctx.claimingAge));
}
