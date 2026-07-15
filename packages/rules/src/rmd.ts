import type { Cents, RmdContext } from "@finley/engine";

/**
 * US Required Minimum Distributions — the age-triggered forced withdrawal from
 * pre-tax retirement accounts (§5.4).
 *
 * This is the `rules`-side plug for the engine's
 * {@link import("@finley/engine").Jurisdiction.requiredMinimumDistributionCents}
 * seam. The engine owns and aggregates the pre-tax balance (pure bookkeeping);
 * this module decides the start age (birth-year-dependent) and the required
 * withdrawal = balance ÷ life-expectancy divisor at/after that age.
 *
 * ⚠ Estimates, not advice. The start ages and the Uniform Lifetime Table below
 * are current US law and change with legislation; they live here, in one place,
 * behind the pluggable jurisdiction concept (never hardcoded in the engine). The
 * IRS mechanic uses the PRIOR-year-end balance; the engine supplies the balance
 * at RMD time — a documented forward-projection simplification.
 */

// ── Legislated constants (one place, disclaimed — §5.4 open decision) ──────────

/**
 * SECURE 2.0 RMD start age by birth year: 73 for 1951–1959, 75 for 1960 and
 * later. Cohorts born before 1951 (start age 72/70½) are out of v1 scope — their
 * RMDs have already begun by "now" for any realistic projection horizon.
 */
function rmdStartAge(birthYear: number): number {
  return birthYear >= 1960 ? 75 : 73;
}

/**
 * IRS Uniform Lifetime Table (2022+), the distribution period (divisor) by age
 * for an account holder whose sole beneficiary is not a >10-years-younger spouse
 * — the standard case. Keyed from the earliest possible start age (73) upward;
 * ages beyond the table clamp to the final (oldest) divisor.
 */
const UNIFORM_LIFETIME_DIVISOR: Readonly<Record<number, number>> = {
  73: 26.5,
  74: 25.5,
  75: 24.6,
  76: 23.7,
  77: 22.9,
  78: 22.0,
  79: 21.1,
  80: 20.2,
  81: 19.4,
  82: 18.5,
  83: 17.7,
  84: 16.8,
  85: 16.0,
  86: 15.2,
  87: 14.4,
  88: 13.7,
  89: 12.9,
  90: 12.2,
  91: 11.5,
  92: 10.8,
  93: 10.1,
  94: 9.5,
  95: 8.9,
  96: 8.4,
  97: 7.8,
  98: 7.3,
  99: 6.8,
  100: 6.4,
  101: 6.0,
  102: 5.6,
  103: 5.2,
  104: 4.9,
  105: 4.6,
  106: 4.3,
  107: 4.1,
  108: 3.9,
  109: 3.7,
  110: 3.5,
  111: 3.4,
  112: 3.3,
  113: 3.1,
  114: 3.0,
  115: 2.9,
  116: 2.8,
  117: 2.7,
  118: 2.5,
  119: 2.3,
  120: 2.0,
};

const OLDEST_TABLE_AGE = 120;

/** Distribution-period divisor for `age`, clamped to the oldest tabulated age. */
function uniformLifetimeDivisor(age: number): number {
  return UNIFORM_LIFETIME_DIVISOR[Math.min(age, OLDEST_TABLE_AGE)];
}

/**
 * The required minimum distribution (nominal cents) for the year. Returns 0
 * before the birth-year-dependent start age or for an empty balance; otherwise
 * the pre-tax balance divided by the Uniform Lifetime divisor for the holder's
 * age, rounded to the cent. Monotonic in both age and balance, and never exceeds
 * the balance (the smallest divisor is 2.0).
 */
export function requiredMinimumDistributionCents(
  preTaxBalanceCents: Cents,
  ctx: RmdContext,
): Cents {
  if (preTaxBalanceCents <= 0) return 0;
  if (ctx.age < rmdStartAge(ctx.birthYear)) return 0;
  return Math.round(preTaxBalanceCents / uniformLifetimeDivisor(ctx.age));
}
