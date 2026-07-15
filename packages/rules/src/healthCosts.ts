import type { Cents, HealthCostContext } from "@finley/engine";

/**
 * US health-cost benchmarks — the attributed monthly figures behind the Medicare
 * step (§5.4, shape 2). Medicare is an eligibility age (65) that triggers a
 * DOWNWARD step in health cost: before it, an early retiree self-funds coverage
 * at an elevated rate; at/after it, Medicare replaces most of that but a residual
 * (premiums / Part B / supplements / out-of-pocket) remains — the step does not
 * go to zero.
 *
 * This is the `rules`-side plug for the engine's
 * {@link import("@finley/engine").Jurisdiction.healthCostBenchmarkMonthlyCents}
 * seam. The engine owns the pure early-retiree honesty flag
 * ({@link import("@finley/engine").assessEarlyRetireeHealthCost}); this module
 * owns the eligibility age and the two dollar figures, in one place, behind the
 * pluggable jurisdiction concept.
 *
 * These make the pre-65 vs. post-65 gap VISIBLE — the decade between an early
 * retirement (say 55) and Medicare at 65 is expensive self-funded insurance the
 * retirement solver must reflect (§5.4). The app pre-fills the attributed stepped
 * segment and the early-retirement nudge from these figures; it is NOT a silent
 * auto-step in the sim (health is an authored budget item).
 *
 * ⚠ Estimates, not advice. These are current US costs and change yearly; the
 * pre-65 figure is UNSUBSIDISED (v1 conservative — real ACA subsidies would lower
 * it). Forward years are INDEXED at a health-specific inflation rate (medical
 * inflation runs above CPI), not held flat (§5.4 "indexed forward").
 */

// ── Legislated / benchmark base-year constants (one place, disclaimed — §5.4) ──

/** The calendar year the pinned dollar figures below are authoritative for. */
export const HEALTH_COST_BASE_YEAR = 2026;

/** Medicare eligibility age: coverage steps down here (US law). */
export const MEDICARE_ELIGIBILITY_AGE = 65;

/** Pre-65 self-funded monthly health cost per person — elevated, unsubsidised (v1 conservative). */
const BASE_PRE65_SELF_FUNDED_MONTHLY_CENTS: Cents = 1_200_00;
/** Post-65 Medicare-residual monthly health cost per person (premiums/Part B/out-of-pocket, not zero). */
const BASE_MEDICARE_RESIDUAL_MONTHLY_CENTS: Cents = 500_00;

/**
 * Assumed forward medical-inflation rate for the benchmarks. Health costs
 * historically outpace CPI; the projection has no year-by-year rate in the seam
 * context, so this rules-side estimate stands in.
 * ⚠ Estimate — actual medical inflation varies and is published in arrears.
 */
const ASSUMED_ANNUAL_HEALTH_INFLATION_RATE = 0.05;

/** Round indexed figures down to whole dollars — keeps them clean and monotonic. */
const ROUND_DOLLAR_CENTS: Cents = 1_00;

/**
 * Index a base-year figure forward to `year`, rounded DOWN to `incrementCents`.
 * Years at or before the base year return the base unchanged — no backward
 * indexing. Rounding down keeps the result monotonically non-decreasing as the
 * year advances (mirrors `contributionLimits.indexForward`).
 */
function indexForward(baseCents: Cents, year: number, incrementCents: Cents): Cents {
  const years = year - HEALTH_COST_BASE_YEAR;
  if (years <= 0) return baseCents;
  const indexed = baseCents * Math.pow(1 + ASSUMED_ANNUAL_HEALTH_INFLATION_RATE, years);
  return Math.floor(indexed / incrementCents) * incrementCents;
}

/** The attributed monthly health-cost figures for `year`, base indexed forward. */
export interface HealthCostBenchmark {
  readonly year: number;
  /** Elevated self-funded cost per person before the Medicare-eligibility age. */
  readonly pre65SelfFundedMonthlyCents: Cents;
  /** Residual cost per person at/after the Medicare-eligibility age (not zero). */
  readonly medicareResidualMonthlyCents: Cents;
}

/**
 * The attributed health-cost benchmarks for `year`: the pinned base-year figures
 * ({@link HEALTH_COST_BASE_YEAR}) indexed forward to `year`.
 */
export function healthCostBenchmark(year: number): HealthCostBenchmark {
  return {
    year,
    pre65SelfFundedMonthlyCents: indexForward(
      BASE_PRE65_SELF_FUNDED_MONTHLY_CENTS,
      year,
      ROUND_DOLLAR_CENTS,
    ),
    medicareResidualMonthlyCents: indexForward(
      BASE_MEDICARE_RESIDUAL_MONTHLY_CENTS,
      year,
      ROUND_DOLLAR_CENTS,
    ),
  };
}

/**
 * The engine's health-cost benchmark seam: the attributed monthly health cost for
 * a person of `ctx.age` in `ctx.year` — the elevated self-funded figure below the
 * Medicare-eligibility age, the lower residual at/after it (§5.4). This is the
 * "visible attributed step" (down at 65) and the benchmark the early-retiree
 * honesty flag compares an authored health expense against.
 */
export function healthCostBenchmarkMonthlyCents(ctx: HealthCostContext): Cents {
  const benchmark = healthCostBenchmark(ctx.year);
  return ctx.age >= MEDICARE_ELIGIBILITY_AGE
    ? benchmark.medicareResidualMonthlyCents
    : benchmark.pre65SelfFundedMonthlyCents;
}
