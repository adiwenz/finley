/**
 * The standing `Person` authoring model (§8 of JOBS_HOUSEHOLD_REDESIGN, issue
 * #64) — a household member as the *user authors it*: identity, the person-level
 * retirement/SS inputs, and the jobs they hold. This is source-of-truth input,
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
 * spans plus the person-level retirement/SS inputs the compilation reads.
 */
export interface Person {
  readonly id: PersonId;
  readonly name: string;
  readonly birthYear: number;
  /** Career-exit age (§5): the null-end job ends here. */
  readonly retirementTargetAge: number;
  /** Pinned Social Security claiming age (an input, never solved). */
  readonly ssClaimingAge: number;
  readonly jobs: readonly Job[];
}

/**
 * The person's career job (the ≤1 `null`-end job, §4), or `undefined` if they
 * have none. Throws if a person holds more than one — the "≤1 null-end job per
 * person" invariant is a hard model constraint, refused where it is authored.
 */
export function careerJobOf(person: Person): Job | undefined {
  const career = person.jobs.filter((j) => j.endYear === null);
  if (career.length > 1) {
    throw new Error(
      `Person "${person.id}" has ${career.length} career (null-end) jobs; at most one is allowed.`,
    );
  }
  return career[0];
}
