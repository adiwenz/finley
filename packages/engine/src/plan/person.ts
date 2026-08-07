/**
 * A household member as the user authors it — standing input, not a life event.
 *
 * Distinct from the compiled {@link import("../projection/simulate").SimPerson} the simulator
 * consumes (no jobs; just pre-computed `priorEarningsCents` plus
 * claiming inputs). {@link import("../compile/compilePerson")} is the seam, which keeps the authoring
 * surface out of the sim core.
 */

import type { Job, JobId, PersonId } from "../job/job";
import { withShiftedYears } from "../job/job";

export interface Person {
  readonly id: PersonId;
  readonly name: string;
  readonly birthYear: number;
  /**
   * The age this member is projected to live to — an input, never solved for.
   *
   * **It closes this member's own {@link import("../job/personActiveWindow").PersonActiveWindow},
   * and so bounds everything person-scoped about them**: their jobs end at `min(authored end,
   * death)`, a raise or bonus dated past it never lands, and their government benefit stops
   * there, exactly as a separation stops all three. One window, so no subsystem can be left
   * checking death on its own — a wage used to go on being paid to a household years after the
   * earner it belonged to had died, while their Social Security had already stopped.
   *
   * On an AUTHORED plan that `min` never binds for a job: authoring refuses one that ends past
   * its owner's death outright, since a plan whose stated end and worked end differ is two
   * answers to one question ({@link import("../authoring/reachability").assertPersonEventsStillReachable}).
   * The clamp stands for state this build did not author — a restored or imported file.
   *
   * Household spending is deliberately NOT bounded by it: it runs unchanged to the horizon,
   * funding the survivor at full cost, which is conservative rather than dangerous. That
   * asymmetry is the reason the window is per person rather than per household.
   *
   * The projection horizon is the MAX of every member's expectancy month, so a partner younger
   * than the primary but with the same expectancy *age* reaches it in a later calendar year and
   * extends the run to cover their tail — the gap this field exists to close.
   *
   * **Required, and every person carries their own.** It was once optional, meaning "inherit the
   * primary's", resolved on read at the sim boundary. That saved authoring one number and cost far
   * more: the field's type could not say what the projection actually ran to, every read site
   * needed the fallback threaded to it, five of them had invented DIFFERENT answers for an absent
   * one, and a plan whose primary also stated none projected zero months. A person the engine is
   * asked to carry to an age has that age.
   *
   * Nothing anywhere defaults it, and a partner does NOT fall back to the primary's:
   * `marry`/`startPartnered` require one too
   * ({@link import("../authoring/relationships").MarryInput.lifeExpectancy}). How long a person
   * lives is a fact about them, not about whoever they married — and a partner ten years younger
   * silently handed age 90 would extend the projection horizon by a decade nobody chose.
   */
  readonly lifeExpectancy: number;
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

/**
 * **This person, born in a different year — and their whole working life moved with them.**
 *
 * A birth year is not an ordinary field, because it is the origin every age on this person is
 * read against. Their jobs are authored in ages ("started at 18, ends at 65") and stored in
 * calendar years; moving the birth year without moving the jobs would leave the years where they
 * were and so silently restate every one of those ages. Someone correcting 1966 to 1965 would
 * find the job they said ends at 90 now ending at 91 — an edit they did not make, to a field they
 * were not looking at.
 *
 * So the jobs shift by the same delta, ages preserved, and the calendar follows the person. Their
 * death moves by that delta too (it is `birthYear + lifeExpectancy`), which is why this move
 * alone can never put a job past its owner's end: both sides of that comparison are ages, and
 * neither changed. An edit that ALSO moves the life expectancy is a different question, and the
 * one containment rule still answers it
 * ({@link import("../authoring/reachability").assertPersonEventsStillReachable}) — a job ending at
 * 90 under an expectancy lowered to 85 is refused, rebased or not.
 *
 * **Only what this person owns moves.** Their jobs are dated in their own ages; a wedding, a
 * child's arrival, a loan they took out are dated on the household's calendar, and nobody's
 * birthday is what put them there. Shifting those would move facts about other people.
 *
 * The single definition of the rule, shared by the two planes a person can be edited on — the
 * plan's primary ({@link import("./plan").withPlanPatch}) and a partner on their
 * `RelationshipEvent` ({@link import("../authoring/revise").reviseProjectionTransaction}) — so a
 * partner's correction cannot behave differently from the primary's.
 */
export function withBirthYear(person: Person, birthYear: number): Person {
  const deltaYears = birthYear - person.birthYear;
  if (deltaYears === 0) return person;
  return {
    ...person,
    birthYear,
    jobs: person.jobs.map((job) => withShiftedYears(job, deltaYears)),
  };
}
