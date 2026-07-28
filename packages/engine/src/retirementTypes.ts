/**
 * The retirement vocabulary shared across surfaces: the mode vocabulary and the per-age
 * evaluation result the UI speaks in. There is no standalone accumulation solver — the
 * panel reads its survival signal off the real projection. All monetary amounts are real
 * (inflation-adjusted) cents.
 */

/**
 * Which ages are pinned and which are searched — the ONLY thing "mode" means. The
 * vocabulary for per-person retirement once a second household member arrives; the
 * single-person panel needs only the group headline.
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
   * On-track fraction: 1.0 when the plan survives at this age, otherwise how far off it is.
   * Read from WHEN the plan first fails (insolvency / negative real net worth), never from
   * the magnitude of a net-worth dip — insolvency nulls that and phantom equity distorts it.
   * So: the fraction of the retirement-to-life-expectancy window the plan stays solvent —
   * failing the month after retiring is ~0, failing just short of life expectancy ~0.99.
   * Strictly < 1 for any infeasible plan; the reporting layer floors to 0.1%, caps at 100%.
   */
  readonly onTrackFraction: number;
  /**
   * The nearest feasible age when this one is unreachable ("this date isn't achievable; the
   * nearest is 58"). Null when no age is feasible; equals `retirementAge` when this age is.
   */
  readonly nearestFeasibleAge: number | null;
}

/**
 * The two solver outputs plus the derived latest-authored-work-stop age — the one shape
 * answering "when can this household retire?". Both ages come off the SAME real projection,
 * differing only in which jobs keep paying past the pinned age:
 *
 *  - **`partialRetirementAge`** — earliest age every **open-ended** (`null`-end) job can end
 *    while authored **fixed-term** jobs + passive income + government benefit keep running.
 *    The subjective "stepped back" milestone; the on-track % pairs with it.
 *  - **`fullRetirementAge`** — earliest age **ALL** jobs can cease and the plan still survive
 *    on passive income + government benefit + assets. Always ≥ `partialRetirementAge`:
 *    dropping still-running income can only make survival harder.
 *  - **`latestAuthoredWorkStopAge`** — `max(job endYears)` as an age. `null` for a scalar
 *    (jobs-less) plan.
 *
 * Ages are `null` when even working to life expectancy cannot make that scenario survive.
 */
export interface RetirementSolution {
  /** Earliest partial retirement age (vary open-ended jobs' ends; keep fixed-term + passive). */
  readonly partialRetirementAge: number | null;
  /** Earliest full retirement age (cease ALL jobs; survive on passive + government benefit + assets). */
  readonly fullRetirementAge: number | null;
  /** `max(job endYears)` as an age; `null` when the plan has no jobs. */
  readonly latestAuthoredWorkStopAge: number | null;
}
