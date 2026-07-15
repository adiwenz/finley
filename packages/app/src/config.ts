/** Simulation-wide constants shared by every UI surface. */

/**
 * Fallback projection horizon (30 years) for surfaces without a plan in hand.
 * The live projection, chart, and timeline instead span to life expectancy via
 * {@link planHorizonMonths} — this is only the default when no ages are available.
 */
export const HORIZON_MONTHS = 12 * 30;
export const INFLATION = 0.03;
export const START_YEAR = 2026;

/**
 * The plan's projection horizon: from "now" to life expectancy (§7), in months.
 * Drives the net-worth chart, the timeline axis, and the event year picker so all
 * three span the whole life the retirement panel reasons about — not a fixed 30
 * years. Clamped at 0 for a degenerate age ordering (life expectancy ≤ current age).
 */
export function planHorizonMonths(currentAge: number, lifeExpectancy: number): number {
  return Math.max(0, (lifeExpectancy - currentAge) * 12);
}
