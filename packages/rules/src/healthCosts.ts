import type { Cents, HealthCostContext } from "@finley/engine";

/**
 * US health-cost benchmarks — the monthly figures behind the Medicare step (shape 2).
 * Medicare eligibility at 65 steps health cost DOWNWARD: before it an early retiree
 * self-funds coverage at an elevated rate; at/after it a residual (premiums / Part B /
 * supplements / out-of-pocket) remains — the step does not go to zero.
 *
 * The `rules`-side plug for the engine's
 * {@link import("@finley/engine").Jurisdiction.healthCostBenchmarkMonthlyCents} seam. The
 * engine owns the pure early-retiree honesty flag
 * ({@link import("@finley/engine").assessEarlyRetireeHealthCost}); this module owns the
 * eligibility age and the two dollar figures.
 *
 * The app pre-fills the stepped segment and the early-retirement nudge from these; the sim
 * never steps silently, since health is an authored budget item.
 *
 * ⚠ Estimates, not advice. The pre-65 figure is UNSUBSIDISED (v1 conservative — real ACA
 * subsidies would lower it). Forward years are indexed at a health-specific rate, since
 * medical inflation runs above CPI.
 */

/** The calendar year the pinned dollar figures below are authoritative for. */
export const HEALTH_COST_BASE_YEAR = 2026;

/** US law. */
export const MEDICARE_ELIGIBILITY_AGE = 65;

/** Per person, unsubsidised. */
const BASE_PRE65_SELF_FUNDED_MONTHLY_CENTS: Cents = 1_200_00;
/** Per person: premiums, Part B, out-of-pocket. */
const BASE_MEDICARE_RESIDUAL_MONTHLY_CENTS: Cents = 500_00;

/**
 * Health costs historically outpace CPI, and the seam context carries no year-by-year rate,
 * so this rules-side estimate stands in.
 */
const ASSUMED_ANNUAL_HEALTH_INFLATION_RATE = 0.05;

const ROUND_DOLLAR_CENTS: Cents = 1_00;

/**
 * Rounded DOWN to `incrementCents`, which keeps the result monotonically non-decreasing
 * (mirrors `contributionLimits.indexForward`). Years at or before the base year return the
 * base unchanged — no backward indexing.
 */
function indexForward(baseCents: Cents, year: number, incrementCents: Cents): Cents {
  const years = year - HEALTH_COST_BASE_YEAR;
  if (years <= 0) return baseCents;
  const indexed = baseCents * Math.pow(1 + ASSUMED_ANNUAL_HEALTH_INFLATION_RATE, years);
  return Math.floor(indexed / incrementCents) * incrementCents;
}

export interface HealthCostBenchmark {
  readonly year: number;
  /** Per person, before the Medicare-eligibility age. */
  readonly pre65SelfFundedMonthlyCents: Cents;
  /** Per person, at/after the Medicare-eligibility age. Never zero. */
  readonly medicareResidualMonthlyCents: Cents;
}

/** The pinned {@link HEALTH_COST_BASE_YEAR} figures indexed forward to `year`. */
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
 * The engine's health-cost benchmark seam, and the figure the early-retiree honesty flag
 * compares an authored health expense against.
 */
export function healthCostBenchmarkMonthlyCents(ctx: HealthCostContext): Cents {
  const benchmark = healthCostBenchmark(ctx.year);
  return ctx.age >= MEDICARE_ELIGIBILITY_AGE
    ? benchmark.medicareResidualMonthlyCents
    : benchmark.pre65SelfFundedMonthlyCents;
}
