/**
 * The standing `Person` authoring model (§8 of JOBS_HOUSEHOLD_REDESIGN, issue
 * #64) — a household member as the *user authors it*: identity, the person-level
 * retirement/benefit inputs, and the jobs they hold. This is source-of-truth input,
 * not a life event.
 *
 * This is deliberately distinct from the lower-level {@link
 * import("./projection/simulate").SimPerson} that the numerical simulator
 * consumes. `SimPerson` is a *compiled* shape (no jobs, no `retirementTargetAge`;
 * just the pre-computed `priorEarningsCents` + claiming inputs the month-by-month
 * sim needs). The seam between them is {@link import("./compilePerson")} — a
 * standing `Person` compiles into a `SimPerson` plus income series. Keeping the two
 * as separate types is what keeps the authoring surface out of the pure sim core.
 */

import type { Job, PersonId } from "./job";

/**
 * A household member (§8) — standing data, not a life event. Holds ≥0 jobs with
 * spans plus the person-level retirement/benefit inputs the compilation reads.
 */
export interface Person {
  readonly id: PersonId;
  readonly name: string;
  readonly birthYear: number;
  /**
   * The default stop age (§5) for this person's **open-ended** jobs: any job with a
   * `null` endYear stops the year the person turns this age. The retirement solver
   * varies it to answer "when can they retire?". Fixed-term jobs ignore it.
   */
  readonly retirementTargetAge: number;
  /** Pinned government-benefit claiming age (an input, never solved). */
  readonly benefitClaimingAge: number;
  readonly jobs: readonly Job[];
}
