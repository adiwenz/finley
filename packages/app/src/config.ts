/** Simulation-wide constants shared by every UI surface. */

/**
 * Fallback horizon (30 years) for surfaces without a plan in hand. The live projection,
 * chart, and timeline span to life expectancy via the engine's `planHorizonMonths` instead —
 * a plan's span is the simulator's fact, not a presentation choice, so this package reads it
 * rather than deriving a second one that could disagree with the months it is handed.
 */
export const HORIZON_MONTHS = 12 * 30;
export const INFLATION = 0.03;
export const START_YEAR = 2026;
