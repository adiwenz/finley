/**
 * **Does everything this state says a person does happen while that person is alive?**
 *
 * One rule, stated once: **every person-scoped artifact is contained within the active window of
 * each person it is scoped to.** A marriage, a separation, a loan somebody takes out, a house
 * somebody buys, a job somebody works — each names its people through the ownership it already
 * carries, and each is bounded by them.
 *
 * Containment means the whole artifact, not just its beginning. A point event has one month, and
 * that month must fall inside the window. An interval has two, and BOTH must: a job starts inside
 * the window and ends inside it, so `startMonth < endMonthExclusive <= deathMonth`. The window's
 * closing bound is the death month, exclusive — the first month the person is gone — which is why
 * an end AT it is contained (the last month worked is the last month lived) and a start at it is
 * not (there is no month left to do the thing in).
 *
 * There are two directions to guard, and this is the second one. The moment a person-scoped thing
 * is WRITTEN it is checked against the expectancies in force then ({@link
 * import("./relationships").applyMarriage} refuses a posthumous wedding outright, with a message
 * about weddings). The other direction has no second write to catch it: an edit that moves a death
 * EARLIER can strand something that was perfectly legal when it was authored. Lower the primary's
 * life expectancy under a separation booked for 2085, or under a mortgage they take out in 2090,
 * and it becomes an event nobody lives to see.
 *
 * So both planes run this over the state they WOULD produce, and the edit is refused rather than
 * the event left unreachable — see {@link import("./state").withStatePlan} and
 * {@link import("./eventWrite").appendEvent}. Checking the whole state rather than only what an
 * edit obviously touches is deliberate: one lowered expectancy is the primary's, and the primary
 * is a participant in every couple event and an owner besides.
 *
 * **Not run on restore.** A state arriving from outside is checked for what makes it loadable at
 * all (`./restore`), and refusing a whole imported file over one unreachable event would leave the
 * user nothing to open and no way to fix it — which is why the simulation keeps its own clamps
 * ({@link import("../job/personActiveWindow").personActiveWindow} clips a job's employment at the
 * death, {@link import("../job/personActiveWindow").memberHorizonReach} bounds the run) and models
 * such a household sensibly instead of relying on this. Those clamps are defensive, not the rule:
 * nothing this validator sees can reach them, and a state that does reach them is one this build
 * did not author.
 */

import type { PersonId } from "../job/job";
import type { LifeEvent } from "../ledger/eventTypes";
import type { Person } from "../plan/person";
import { lifeExpectancyEndMonthExclusive } from "../job/personActiveWindow";
import type { ProjectionState } from "./state";

/** The calendar year a plan month falls in — what a refusal quotes back, since nobody authors months. */
export function yearOfMonth(startYear: number, month: number): number {
  return startYear + Math.floor(month / 12);
}

/**
 * A person as a death is reckoned from, plus what to call them when they are nameless.
 *
 * The role is carried rather than looked up because a partner is not always in the state yet:
 * {@link import("./relationships").applyMarriage} asks about the very person it is about to mint.
 */
export interface Mortal {
  readonly name: string;
  readonly birthYear: number;
  readonly lifeExpectancy: number;
  /** Stands in for a blank name — a plan can be authored without one. */
  readonly role: "the primary" | "the partner";
}

/** Whose death bounds a thing, when: the exclusive month they are gone, and the year they reached. */
export interface Death {
  readonly who: string;
  /** First month they are no longer here — so a thing dated AT it is already too late. */
  readonly month: number;
  readonly year: number;
}

/**
 * The one who goes first among `people` — the death that bounds anything all of them take part in.
 *
 * Ties keep the earlier entry, so a caller that lists the primary first names the primary on a tie.
 * The single definition of "who goes first", shared by the write-time refusals in `./relationships`
 * and by {@link assertPersonEventsStillReachable} below, so the two cannot pick different people.
 */
export function earliestDeath(people: readonly Mortal[], startYear: number): Death {
  const deaths = people.map((p) => ({
    who: p.name.trim() || p.role,
    month: lifeExpectancyEndMonthExclusive(p, startYear),
    year: p.birthYear + p.lifeExpectancy,
  }));
  return deaths.reduce((first, d) => (d.month < first.month ? d : first));
}

/**
 * A thing that only exists while somebody is alive for it: what a refusal calls it, the span of
 * their life it occupies, and every person it takes.
 *
 * **The span is what makes this general.** A point event states `month` alone and is contained
 * when that month is inside the window. An interval states `endMonthExclusive` as well and is
 * contained when its whole span is. A future person-scoped interval — a lease somebody signs, a
 * caregiving stretch, a second kind of employment — becomes bounded by adding a case to
 * {@link personScopeOf} (or a second collection to {@link personScopedThings}) that states its
 * end; it does not need a rule of its own, and it must not grow one.
 */
interface PersonScoped {
  /** Singular noun, as a refusal says it — "marriage", "separation", "loan", "job". */
  readonly noun: string;
  /** The month it happens, or — for an interval — the month it starts. */
  readonly month: number;
  /**
   * First month AFTER it, for a thing that occupies a stretch rather than an instant. Absent on a
   * point event, which is the difference between the two: there is nothing else to bound.
   */
  readonly endMonthExclusive?: number;
  /** Everyone who must be alive for it, primary first where they are one of them. */
  readonly participants: readonly PersonId[];
}

/**
 * How a {@link PersonScoped} thing fails containment — which end of it fell outside the window,
 * and the month that did. The month is what orders one failure against another, so a household
 * with several is told about the earliest thing to go wrong rather than about whichever collection
 * happened to be walked first.
 */
interface Escape {
  readonly end: "start" | "finish";
  readonly month: number;
}

/**
 * Where `thing` leaves the window that closes at `death`, or `null` when it is contained.
 *
 * **The single containment rule.** The start must fall strictly inside the window; the finish, for
 * an interval, must fall at or inside its closing bound — the asymmetry is the bound's
 * exclusivity, not a second opinion about what death means. The start is reported in preference to
 * the finish because it is the earlier of the two and the more fundamental failure: a job nobody
 * lives to take up is not a job whose end needs discussing.
 */
function escapeOf(thing: PersonScoped, death: Death): Escape | null {
  if (thing.month >= death.month) return { end: "start", month: thing.month };
  if (thing.endMonthExclusive !== undefined && thing.endMonthExclusive > death.month) {
    return { end: "finish", month: thing.endMonthExclusive };
  }
  return null;
}

/**
 * **Who an event needs alive — read off the ownership the event already carries, never off a
 * judgement about what the event means.**
 *
 * The couple events name two people, because that is what they are: a marriage and a separation
 * are things a pair does, so the primary is a participant in both alongside whoever the event
 * names. The owned events name one, through the `ownerId` every consumer already resolves them by.
 *
 * `null` is the household answer, and it is an answer rather than a gap: a child's arrival and a
 * lump-sum debt payoff name no person in the model, so no person's death bounds them. That is the
 * line the issue draws — "household events that do not require that person to be alive should
 * remain valid" — and it is drawn by the event's own fields rather than by an opinion recorded
 * here. Give `DebtPayoffEvent` an owner one day and it becomes owner-bounded by adding a case, not
 * by re-litigating what a payoff means.
 */
function personScopeOf(event: LifeEvent, primaryId: PersonId): PersonScoped | null {
  switch (event.type) {
    case "RelationshipEvent":
      return {
        noun: "marriage",
        month: event.month,
        participants: [primaryId, event.person.id as PersonId],
      };
    case "SeparationEvent":
      return {
        noun: "separation",
        month: event.month,
        participants: [primaryId, event.partnerPersonId as PersonId],
      };
    case "LoanEvent":
      return { noun: "loan", month: event.month, participants: [event.ownerId as PersonId] };
    case "HomePurchaseEvent":
      return { noun: "home purchase", month: event.month, participants: [event.ownerId as PersonId] };
    case "ChildEvent":
    case "DebtPayoffEvent":
      return null;
  }
}

/**
 * Everyone the state can date a thing against: the primary on the plan, and each partner on the
 * `RelationshipEvent` that brought them in. The same two places
 * {@link import("../job/householdJob").householdJobContexts} rosters members from, so nothing here
 * can reach a person the projection does not.
 */
function householdPeople(state: ProjectionState): readonly Person[] {
  const partners = state.scenario.ledger.events.flatMap((e) =>
    e.type === "RelationshipEvent" ? [e.person] : [],
  );
  return [state.scenario.plan.primary, ...partners];
}

/**
 * Every person-scoped thing in the state, events and jobs alike, in the order a refusal should
 * consider them.
 *
 * **A job is an interval, so it states both months.** Employment is the one person-scoped artifact
 * that occupies a stretch of a life rather than an instant, and containment applies to the whole
 * stretch: nobody takes up work after they die, and nobody works past it either. Its `endYear` is
 * already exclusive — worked in `[startYear, endYear)` — so it converts to `endMonthExclusive`
 * directly and needs no off-by-one of its own.
 */
function personScopedThings(state: ProjectionState): readonly PersonScoped[] {
  const primaryId = state.scenario.plan.primary.id;
  const fromEvents = state.scenario.ledger.events.flatMap((e) => {
    const scoped = personScopeOf(e, primaryId);
    return scoped ? [scoped] : [];
  });
  const fromJobs = householdPeople(state).flatMap((person) =>
    person.jobs.map((job) => ({
      noun: "job",
      month: (job.startYear - state.startYear) * 12,
      endMonthExclusive: (job.endYear - state.startYear) * 12,
      participants: [person.id],
    })),
  );
  return [...fromEvents, ...fromJobs];
}

/**
 * Every person-scoped artifact in `state` is contained in the active window of everyone it is
 * scoped to, or a refusal naming the FIRST one that is not — first in time by the month that
 * ESCAPED, so a household with several failures is told about the earliest thing to go wrong
 * rather than about whichever collection happened to be walked first.
 *
 * The name is historical: this is no longer only about events, and no longer only about their
 * start. See {@link refusalFor} for what a refusal says and why.
 */
export function assertPersonEventsStillReachable(state: ProjectionState): void {
  const people = new Map(householdPeople(state).map((p) => [p.id as string, p]));
  const primaryId = state.scenario.plan.primary.id;

  let worst: {
    readonly thing: PersonScoped;
    readonly death: Death;
    readonly escape: Escape;
  } | null = null;
  for (const thing of personScopedThings(state)) {
    assertSpanRunsForwards(state, thing);
    const mortals = thing.participants.flatMap((id): Mortal[] => {
      const person = people.get(id);
      // A thing pointing at somebody who is not in the household is a different problem, and the
      // ledger's own gate owns it. Nothing to compare a death against here.
      return person === undefined
        ? []
        : [{ ...person, role: person.id === primaryId ? "the primary" : "the partner" }];
    });
    if (mortals.length === 0) continue;
    const death = earliestDeath(mortals, state.startYear);
    const escape = escapeOf(thing, death);
    if (escape === null) continue;
    if (worst === null || escape.month < worst.escape.month) worst = { thing, death, escape };
  }
  if (worst === null) return;
  throw new Error(refusalFor(state, worst.thing, worst.death, worst.escape));
}

/**
 * The refusal for one escaped artifact, in the reader's own vocabulary: calendar years, the person
 * whose death is the bound, and what the artifact needed of them.
 *
 * Everything the reader needs sits AFTER the em-dash: the app strips the `Projection: cannot X —`
 * prefix before showing this (see `useProjection`'s `conflictOf`), so a reason that leaned on the
 * prefix for the date would reach them without one.
 *
 * The message names the EDIT's consequence rather than blaming the older artifact, and it names
 * which END escaped, because the two are fixed by different edits: a stranded start moves by
 * re-dating the thing, a stranded end by shortening it.
 */
function refusalFor(
  state: ProjectionState,
  thing: PersonScoped,
  death: Death,
  escape: Escape,
): string {
  const couple = thing.participants.length > 1;
  const needs = couple ? "both partners alive" : "its owner alive";
  const ends = couple ? "while both partners are alive" : "while its owner is alive";
  const startYear = yearOfMonth(state.startYear, thing.month);
  const said =
    escape.end === "start"
      ? `it would strand the ${startYear} ${thing.noun}: ${death.who} is projected to live only ` +
        `to ${death.year}, and a ${thing.noun} needs ${needs}`
      : `it would run the ${startYear} ${thing.noun} on to ` +
        `${yearOfMonth(state.startYear, escape.month)}: ${death.who} is projected to live only ` +
        `to ${death.year}, and a ${thing.noun} must end ${ends}`;
  return `Projection: cannot apply this change — ${said}`;
}

/**
 * An interval's end comes after its start, or a refusal — the half of containment that needs no
 * person, since a span that runs backwards describes nothing whoever holds it does.
 *
 * Separate from {@link escapeOf} because it is not about a window: it would be wrong under any
 * expectancy, and the reader fixes it by moving a date rather than by living longer. Checked here
 * rather than beside each write for the reason the whole module exists — one rule, one place, and
 * every plane already routes through it.
 */
function assertSpanRunsForwards(state: ProjectionState, thing: PersonScoped): void {
  if (thing.endMonthExclusive === undefined || thing.endMonthExclusive > thing.month) return;
  throw new Error(
    `Projection: cannot apply this change — the ${yearOfMonth(state.startYear, thing.month)} ` +
      `${thing.noun} would end in ${yearOfMonth(state.startYear, thing.endMonthExclusive)}, and a ` +
      `${thing.noun} must end after it starts`,
  );
}
