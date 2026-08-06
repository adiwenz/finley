/**
 * A household member as the user authors it — standing input, not a life event.
 *
 * Distinct from the compiled {@link import("../projection/simulate").SimPerson} the simulator
 * consumes (no jobs; just pre-computed `priorEarningsCents` plus
 * claiming inputs). {@link import("../compile/compilePerson")} is the seam, which keeps the authoring
 * surface out of the sim core.
 */

import type { Job, JobId, PersonId } from "../job/job";

export interface Person {
  readonly id: PersonId;
  readonly name: string;
  readonly birthYear: number;
  /**
   * The age this member is projected to live to — an input, never solved for. Bounds only THIS
   * member's own government benefit: it stops at their expectancy the same way a separation window
   * stops it (see {@link import("../job/householdJob").membershipWindow}). A wage is NOT bounded —
   * a job ends where it was authored to, whatever the expectancy. Household spending never steps
   * down when a member's expectancy passes either — it runs unchanged to the horizon, funding the
   * survivor at full cost, which is conservative rather than dangerous.
   *
   * The projection horizon is the MAX of every member's expectancy month, so a partner younger
   * than the primary but with the same expectancy *age* reaches it in a later calendar year and
   * extends the run to cover their tail — the gap this field exists to close.
   *
   * `undefined` means **inherit the primary's own expectancy**
   * ({@link import("./plan").Plan.primary}`.lifeExpectancy`), resolved on read at the sim
   * boundary rather than frozen here — the same "not stated, so use the household default" shape
   * {@link continuationJobId} uses. The primary always states theirs; a partner may state their
   * own or leave it to the primary's.
   */
  readonly lifeExpectancy?: number;
  /** An input, never solved for. */
  readonly benefitClaimingAge: number;
  readonly jobs: readonly Job[];
  /**
   * **If this person's plan required working longer than expected, which job would continue?**
   *
   * The single job a what-if may run past its authored end — read by the retirement solver and
   * the stop-working preview, and by nothing else. The authored projection pays every job over
   * exactly the years it was given, whatever this holds. See
   * {@link import("../job/householdJob").continuationJobIdOf}, which is the only thing that reads it.
   *
   * Three states, all distinct:
   *
   *  - a {@link JobId} — that job, and only that job, is modelled as never having ended: its
   *    ONE authored span keeps its start and runs to the candidate boundary. Never a second
   *    stint starting later, which is why a job that finished years ago can be named — the
   *    scenario is that it did not finish.
   *  - `null` — **"do not assume I would work longer".** They have said there is no work to
   *    continue, so no candidate boundary ever pays them past the dates they authored. The
   *    solver reports such an age as unreachable rather than inventing employment nobody
   *    claimed.
   *  - `undefined` — **not chosen yet**, the state every person starts in and stays in until
   *    someone picks. Resolved on read by the initialization rule in `continuationJobIdOf`,
   *    never by writing a value here. Kept distinct from `null` because "I have not been asked"
   *    and "I answered none" are different facts, and collapsing them would either make every
   *    unasked household unable to work a day longer than it wrote down, or make an explicit
   *    "none" evaporate the next time anything re-derived a default.
   *
   * **Never inferred from the dates, and never re-derived once set.** A job's end year says
   * nothing about whether the work could go on, and adding, removing or reordering jobs does not
   * revisit a choice already made — see the initialization rule for the one moment dates are
   * consulted at all.
   */
  readonly continuationJobId?: JobId | null;
}
