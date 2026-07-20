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

/**
 * The two §5 retirement solver outputs, plus the derived latest-authored-work-stop age
 * — the single shape a caller reads to describe "when can this household retire?" Both
 * ages come off the SAME real §5 projection (#29 substrate); they differ only in which
 * jobs keep paying past the pinned age (§5):
 *
 *  - **`partialRetirementAge`** — the earliest age every **open-ended** (`null`-end) job
 *    can end while the authored **fixed-term** jobs + passive income + government benefit keep running.
 *    This is the subjective "stepped back" milestone; the on-track % pairs with it.
 *  - **`fullRetirementAge`** — the earliest age **ALL** jobs (career + supplemental) can
 *    cease and the plan still survive on passive income + government benefit + assets alone. Always
 *    ≥ `partialRetirementAge`: dropping the supplemental income can only make survival harder.
 *  - **`latestAuthoredWorkStopAge`** — the derived `max(job endYears)` as an age: the latest
 *    any authored job is scheduled to stop. `null` for a scalar (jobs-less) plan.
 *
 * Ages are `null` when even working to life expectancy cannot make that scenario survive.
 */
export interface RetirementSolution {
  /** Earliest partial retirement age (vary open-ended jobs' ends; keep fixed-term + passive). */
  readonly partialRetirementAge: number | null;
  /** Earliest full retirement age (cease ALL jobs; survive on passive + government benefit + assets). */
  readonly fullRetirementAge: number | null;
  /** Derived `max(job endYears)` as an age; `null` when the plan has no jobs. */
  readonly latestAuthoredWorkStopAge: number | null;
}
