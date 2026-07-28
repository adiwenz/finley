/**
 * The standing `Person` authoring model — a household member as the *user authors it*:
 * identity, the person-level retirement/benefit inputs, and the jobs they hold.
 * Source-of-truth input, not a life event.
 *
 * Deliberately distinct from the lower-level, *compiled*
 * {@link import("./projection/simulate").SimPerson} the numerical simulator consumes (no
 * jobs, no `retirementTargetAge`; just pre-computed `priorEarningsCents` + claiming inputs).
 * The seam is {@link import("./compilePerson")}: a `Person` compiles into a `SimPerson`
 * plus income series. Two types is what keeps the authoring surface out of the sim core.
 */

import type { Job, PersonId } from "./job";

/**
 * A household member — standing data, not a life event. Holds ≥0 jobs with
 * spans plus the person-level retirement/benefit inputs the compilation reads.
 */
export interface Person {
  readonly id: PersonId;
  readonly name: string;
  readonly birthYear: number;
  /**
   * The default stop age for this person's **open-ended** jobs: a job with a `null` endYear
   * stops the year they turn this age. The retirement solver varies it to answer "when can
   * they retire?". Fixed-term jobs ignore it.
   */
  readonly retirementTargetAge: number;
  /** Pinned government-benefit claiming age (an input, never solved). */
  readonly benefitClaimingAge: number;
  readonly jobs: readonly Job[];
}
