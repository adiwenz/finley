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
  /**
   * The job's own authored name, or `null` for one that has none — {@link jobLabel} before the
   * fallback is applied.
   *
   * Both are here because a sentence needs them differently. "your **Software Engineer** job"
   * needs the bare title; a job with no title has no such phrasing and falls back to the whole
   * label ("Alex's job"), which is already a noun phrase. A caller cannot tell the two apart
   * from {@link jobLabel} alone without inspecting the string.
   */
  readonly jobName: string | null;
  readonly ownerId: string;
  readonly ownerName: string;
  /**
   * Where this job's extension runs **alongside** another of the same person's jobs, in the
   * primary's timeline ages.
   *
   * A consequence of the model, disclosed rather than hidden: continuing a job means it never
   * ended, so a job authored to finish before a later one begins now runs through it, and both
   * pay. That is the intended reading — "what if this had carried on?" — but it is also the one
   * thing about a continued job a reader would not predict, and it inflates income for exactly
   * the years it covers.
   *
   * Same OWNER only. A partner earning at the same time is not a consequence of this person's
   * extension, and reporting it as one would make every two-earner household look surprising.
   *
   * Empty for the ordinary case, where the continued job was already the last one running.
   */
  readonly overlaps: readonly JobOverlap[];
}

/** One window where a continued job pays alongside another of its owner's — see {@link ContinuedJob.overlaps}. */
export interface JobOverlap {
  readonly jobId: string;
  /** Named the same way {@link ContinuedJob.jobLabel} is. */
  readonly jobLabel: string;
  /** The job's own authored name, or `null` — see {@link ContinuedJob.jobName}. */
  readonly jobName: string | null;
  /** Primary-timeline age the overlap opens at. */
  readonly fromAge: number;
  /** Primary-timeline age it closes at, exclusive — "from 65 to 70" is five years of both. */
  readonly toAge: number;
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
