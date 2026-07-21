import type {
  Cents,
  EarningsRecord,
  GovernmentBenefitClaim,
  GovernmentBenefitContext,
  TaxCategory,
} from "@finley/engine";

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
 * {@link import("@finley/engine").Jurisdiction.governmentBenefitBaseMonthlyCents}
 * and {@link import("@finley/engine").Jurisdiction.colaAdjustedBenefitCents} seams.
 * The engine owns and accumulates the {@link EarningsRecord}; this module turns that
 * record into a base benefit at a pinned claiming age and grows it by COLA.
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
//
// Base years, indexing anchors & sources. The dollar constants below are SSA
// figures that change yearly, so each is pinned to the base year its dollar
// amount is exact for and indexed to other years by {@link AWI_ANNUAL_GROWTH}.
// Every figure here is taken from SSA's 2026 publications, so the base year is
// 2026 throughout — one provenance year, no cross-figure mismatch:
//
//   • {@link BEND_POINT_1_CENTS} / {@link BEND_POINT_2_CENTS} ($1,286 / $7,749)
//     — 2026 PIA bend points. {@link BEND_POINT_BASE_YEAR} = 2026; they re-index
//     to each cohort's age-60 year (see BEND_POINT_BASE_YEAR for why).
//     Source: https://www.ssa.gov/oact/cola/bendpoints.html
//   • {@link QUARTER_OF_COVERAGE_CENTS} ($1,890) — 2026 quarter-of-coverage
//     amount. {@link QUARTER_OF_COVERAGE_BASE_YEAR} = 2026; it re-indexes to each
//     EARNINGS year (a different target year than the bend points, same base).
//     Source: SSA COLA & other determinations for 2026 (Federal Register) —
//     https://www.federalregister.gov/documents/2025/11/03/2025-19763/cost-of-living-increase-and-other-determinations-for-2026
//   • {@link WAGE_BASE_CAP_CENTS} ($184,500) — 2026 contribution & benefit base.
//     Deliberately held FLAT across all years (a documented simplification — see
//     its own comment), so it carries a 2026 value but no indexing base year.
//     Source: https://www.ssa.gov/oact/cola/cbb.html
// The per-figure base years stay separate constants on purpose: each records the
// SSA-table year ITS amount came from, so a future refresh can move one figure to
// a new year without silently dragging the others — they coincide at 2026 only
// because every value here was sourced from the 2026 tables at once.
//
// Indexing is symmetric about each base year: earnings and thresholds in years
// BEFORE the base scale down (negative exponent in Math.pow), later years scale
// up. So a claimant who started benefits before the simulation start is handled
// the same way — the model is expressed in ages and each cohort's age-60 year,
// never relative to the simulation clock.
//
// {@link AWI_ANNUAL_GROWTH} (3.5%) is a single assumed rate standing in for the
// real per-year SSA Average Wage Index series — the biggest v1 approximation,
// not a figure sourced from any one year. All values are legislation-set and are
// disclaimed estimates once indexed forward (§5.4).

/** Full retirement age (FRA) for the cohorts v1 models. */
const FRA_AGE = 67;

/**
 * The default benefit claiming age the engine uses to time an unpinned person's
 * benefit — the full retirement age. A US legislative fact, exposed to the engine
 * via the jurisdiction's `defaultBenefitClaimingAge` seam so no US age lives in the
 * engine (§5.4). Single source: it *is* {@link FRA_AGE}.
 */
export const DEFAULT_BENEFIT_CLAIMING_AGE = FRA_AGE;

/**
 * Annual Social Security wage base (contribution & benefit base), SSA 2026:
 * $184,500. Real SSA caps vary per year; v1 applies this one cap to every year —
 * a documented simplification that under-indexes very old high earnings slightly.
 */
const WAGE_BASE_CAP_CENTS = 184_500_00;

/** PIA bend points (monthly, SSA 2026). PIA replaces 90% / 32% / 15% across them. */
const BEND_POINT_1_CENTS = 1_286_00;
const BEND_POINT_2_CENTS = 7_749_00;

/**
 * The age-60 wage-index year the bend-point constants above are expressed in —
 * 2026, the year SSA published these amounts (their provenance year).
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
 * in real terms. We mirror this by scaling the constants from this base year to
 * the worker's age-60 year by {@link AWI_ANNUAL_GROWTH}; the single flat AWI rate
 * means there is no distinct age-62 figure to track. A cohort whose age-60 year
 * is before 2026 scales the bend points DOWN (negative exponent); one after,
 * up — only a cohort turning 60 exactly in 2026 uses them unscaled.
 */
const BEND_POINT_BASE_YEAR = 2026;

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

/**
 * Credits (a.k.a. "quarters of coverage") required to be fully insured for the
 * retirement benefit — the eligibility gate. 40 credits ≈ 10 years of covered work.
 */
const FULLY_INSURED_CREDITS = 40;

/** Most credits a single calendar year can earn (US: annual-earnings-based since 1978). */
const MAX_CREDITS_PER_YEAR = 4;

/**
 * Covered earnings that buy one credit in {@link QUARTER_OF_COVERAGE_BASE_YEAR}
 * dollars (SSA 2026: $1,890). Like the bend points, this is AWI-indexed to each
 * earnings year via {@link AWI_ANNUAL_GROWTH} — a disclaimed estimate, consistent
 * with the other legislation-set constants here.
 */
const QUARTER_OF_COVERAGE_CENTS = 1_890_00;
const QUARTER_OF_COVERAGE_BASE_YEAR = 2026;

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
 * Total credits earned across the covered-earnings record. Each year buys
 * `min(4, floor(annual covered wages / quarter-of-coverage))` credits, where the
 * quarter-of-coverage dollar amount is AWI-indexed to that earnings year (same
 * mechanism as the bend points). US credits are annual-earnings-based (since 1978),
 * so no quarter/month granularity is modelled. Feeds the fully-insured gate.
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
 * Age of first Social Security eligibility (62 under US law) — the age the paid
 * benefit's COLA factor is measured from. This is a `rules` fact now: the engine
 * holds only the opaque base and asks {@link colaAdjustedBenefitCents} to grow it,
 * so it never sees this constant nor the formula.
 */
const SS_ELIGIBILITY_AGE = 62;

/**
 * Base Social Security benefit (nominal cents, eligibility-age dollars) for a
 * claiming person: `PIA(record) × claimingFactor(claimingAge)`. The engine calls
 * this at claim (and again only while the record keeps growing) with the accumulated
 * earnings record; it caches the result as an opaque base and grows it forward via
 * {@link colaAdjustedBenefitCents}. Returns 0 for an empty record.
 */
export function governmentBenefitBaseMonthlyCents(claim: GovernmentBenefitClaim): Cents {
  const { record, claimYear, claimingAge, currentAge } = claim;
  if (record.annualWagesCents.size === 0) return 0;
  // Eligibility gate lives INSIDE the base function (§5.4): a worker who is not
  // fully insured (< 40 credits) draws no retirement benefit, so return 0.
  if (totalCredits(record) < FULLY_INSURED_CREDITS) return 0;
  // Earnings are indexed to the year the worker turns 60: birthYear + 60, and
  // birthYear = claim year − age in that year (claimYear, currentAge).
  const indexingYear = claimYear - currentAge + 60;
  const { bend1, bend2 } = bendPointsCents(indexingYear);
  const pia = piaCents(aimeCents(record, indexingYear), bend1, bend2);
  return Math.round(pia * claimingFactor(claimingAge));
}

/**
 * Cost-of-living adjustment applied to a frozen base benefit (§5.4):
 * `baseCents × (1 + colaRate)^(currentAge − 62)`. COLAs accrue from age-62
 * eligibility whether or not the person has claimed, so a single factor measured
 * from 62 collapses BOTH the old eligibility bridge (62 → claim) AND the post-claim
 * forward COLA — they are algebraically the same geometric series. The engine holds
 * `baseCents` opaquely and never sees this formula. For the modelled 62–70 claiming
 * range the exponent is ≥ 0.
 */
export function colaAdjustedBenefitCents(baseCents: Cents, ctx: GovernmentBenefitContext): Cents {
  const colaYears = ctx.currentAge - SS_ELIGIBILITY_AGE;
  return Math.round(baseCents * Math.pow(1 + ctx.colaRate, colaYears));
}
