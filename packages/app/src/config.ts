/** Simulation-wide constants shared by every UI surface. */

/**
 * Fallback horizon (30 years) for surfaces without a plan in hand. The live projection,
 * chart, and timeline span to life expectancy via {@link planHorizonMonths} instead.
 */
export const HORIZON_MONTHS = 12 * 30;
export const INFLATION = 0.03;
export const START_YEAR = 2026;

/**
 * "Now" to life expectancy, in months. Drives the net-worth chart, timeline axis, and
 * event year picker so all three span the whole life the retirement panel reasons about,
 * not a fixed 30 years. Clamped at 0 when life expectancy ≤ current age.
 */
export function planHorizonMonths(currentAge: number, lifeExpectancy: number): number {
  return Math.max(0, (lifeExpectancy - currentAge) * 12);
}
