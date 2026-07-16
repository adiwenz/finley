/**
 * The retirement vocabulary (§7) shared across surfaces. The standalone
 * accumulation solver that used to live alongside this file was retired (#37): the
 * retirement panel now reads its survival signal off the real §5 projection, so the
 * only shapes that remain are the mode vocabulary and the per-age evaluation result
 * the UI speaks in. All monetary amounts are real (inflation-adjusted, §0.5) cents.
 */

/**
 * Which ages are pinned and which are searched — the ONLY thing "mode" means (§7).
 * Kept as the vocabulary for per-person retirement (Mode 2) once a second household
 * member arrives; the single-person panel today only needs the group headline.
 */
export type RetirementSearch =
  | { readonly mode: "group" }
  | { readonly mode: "person"; readonly personId: string };

export interface RetirementEvaluation {
  /** The retirement age this evaluation is for (a search candidate, or the user's pin). */
  readonly retirementAge: number;
  /** Does the plan's real net worth survive to life expectancy at this age? */
  readonly feasible: boolean;
  /**
   * On-track fraction (§7.1): the real nest egg the plan has *at* this retirement age
   * ÷ the nest egg it would have needed there to last to life expectancy. 1.0 = fully
   * funded (the plan survives); 0.78 = "78% of the way to a feasible age-55
   * retirement". Raw (not capped) — the reporting layer caps at 100%.
   */
  readonly onTrackFraction: number;
  /**
   * The honest nearest-feasible age when this age is unreachable (§7.1 / §8.2): the
   * truthful "this date isn't achievable; the nearest feasible is 58". Null when no
   * age is feasible. Equals `retirementAge` when this age itself is feasible.
   */
  readonly nearestFeasibleAge: number | null;
}
