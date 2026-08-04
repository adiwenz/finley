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
 * One job the solve **ran past its authored end** to reach the age it reported — the assumption
 * behind the answer, named so it can be disclosed rather than left implicit.
 *
 * Read back off the resolved household rather than re-derived from the selection, so this can
 * only ever name a job the projection actually paid for those extra years. A household whose
 * answer needed no extra work discloses nothing, because nothing was assumed.
 */
export interface ContinuedJob {
  readonly jobId: string;
  /**
   * What to call the job, through the same rule the income legend uses
   * ({@link import("./compilePerson").jobDisplayNames}): its own name, or its owner's ("Alex's
   * job") for one that has none. Never the minted id, which means nothing to a reader.
   */
  readonly jobLabel: string;
  readonly ownerId: string;
  readonly ownerName: string;
}

/**
 * What the default retirement query reports, read off the SAME real projection the net-worth
 * graph draws. An age is `null` when even working to life expectancy cannot make that scenario
 * survive.
 *
 * "Working to life expectancy" is itself bounded by what the household said it could work:
 * carrying the plan past its authored end needs a member to have named a job they would continue
 * (see {@link import("./person").Person.continuationJobId}), so a household where everyone
 * answered "none" can report `null` even where a later age would have paid for itself. That is
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
  /**
   * The jobs {@link fullRetirementAge} assumed would carry on past their authored end — empty
   * when the answer needed none, and empty when there is no answer.
   *
   * Here rather than left for a caller to work out, because it is part of what the age MEANS: "you
   * could stop working at 71" is a different claim depending on whether it assumed five more years
   * of consulting, and a household that never opened the picker has not knowingly agreed to that
   * assumption. Reporting the age without it states a conclusion and hides its premise.
   */
  readonly continuedJobs: readonly ContinuedJob[];
}
