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
 * "Working to life expectancy" is itself bounded by what the household said it could work:
 * carrying the plan past its authored end needs a job marked
 * {@link import("./job").RetirementStrategy} `"extendable"`, so a household that marked
 * everything fixed can report `null` even where a later age would have paid for itself. That is
 * the intended answer — the alternative is income nobody said they could earn.
 */
export interface RetirementSolution {
  /**
   * SOLVED: earliest age ALL jobs (the primary's and every partner's) can cease, surviving on
   * passive + government benefit + assets — "can this household afford to stop working."
   */
  readonly fullRetirementAge: number | null;
  /**
   * READ, not solved: the age, in the primary's own timeline, at which every authored job
   * anywhere in the household (the primary's plan jobs and every partner's) stops paying on
   * its own — the household-wide `max` of each job's authored `endYear`. `null` when the
   * household has no jobs. Says nothing about whether the plan survives to that point;
   * {@link fullRetirementAge} does.
   */
  readonly plannedWorkStopAge: number | null;
}
