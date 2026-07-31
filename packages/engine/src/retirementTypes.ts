/**
 * There is no standalone accumulation solver — the panel reads its survival signal off the
 * real projection.
 */

/**
 * Which ages are pinned and which are searched — the only thing "mode" means. `person` is
 * for a second household member; the single-person panel needs only the group headline.
 */
export type RetirementSearch =
  | { readonly mode: "group" }
  | { readonly mode: "person"; readonly personId: string };

export interface RetirementEvaluation {
  /** The age evaluated — a search candidate, or the user's pin. */
  readonly retirementAge: number;
  /** Does the plan's real net worth survive to life expectancy at this age? */
  readonly feasible: boolean;
  /**
   * Fraction of the retirement-to-life-expectancy window the plan stays solvent; 1.0 when
   * it survives. Read from WHEN the plan first fails (insolvency / negative real net
   * worth), never from the magnitude of a net-worth dip — insolvency nulls that and
   * phantom equity distorts it. Strictly < 1 for any infeasible plan; the reporting layer
   * floors to 0.1%, caps at 100%.
   */
  readonly onTrackFraction: number;
  /** Null when no age is feasible; equals `retirementAge` when this age is. */
  readonly nearestFeasibleAge: number | null;
}

/**
 * What the default retirement query reports, read off the SAME real projection the net-worth
 * graph draws. An age is `null` when even working to life expectancy cannot make that scenario
 * survive.
 *
 * **Partial** retirement — ending only the open-ended (`null`-end) jobs while authored
 * fixed-term jobs + passive income + government benefit keep paying — is deliberately NOT here.
 * It is a separate, opt-in solve (`earliestPartialRetirementAge`), so the default query runs a
 * single search rather than paying for a second one the panel does not currently show.
 */
export interface RetirementSolution {
  /** Earliest age **ALL** jobs can cease, surviving on passive + government benefit + assets. */
  readonly fullRetirementAge: number | null;
  /** `max(job endYears)` as an age; `null` when the plan has no jobs. */
  readonly latestAuthoredWorkStopAge: number | null;
}
