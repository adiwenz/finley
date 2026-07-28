/**
 * A household member as the user authors it — standing input, not a life event.
 *
 * Distinct from the compiled {@link import("./projection/simulate").SimPerson} the simulator
 * consumes (no jobs, no `retirementTargetAge`; just pre-computed `priorEarningsCents` plus
 * claiming inputs). {@link import("./compilePerson")} is the seam, which keeps the authoring
 * surface out of the sim core.
 */

import type { Job, PersonId } from "./job";

export interface Person {
  readonly id: PersonId;
  readonly name: string;
  readonly birthYear: number;
  /**
   * Stop age for this person's **open-ended** jobs (`endYear: null`); fixed-term jobs ignore
   * it. The retirement solver varies it.
   */
  readonly retirementTargetAge: number;
  /** An input, never solved for. */
  readonly benefitClaimingAge: number;
  readonly jobs: readonly Job[];
}
