/**
 * **Does everything this state says a person does happen while that person is alive?**
 *
 * One rule, stated once: a thing scoped to a person cannot be dated at or after the month that
 * person dies. A marriage, a separation, a loan somebody takes out, a house somebody buys, a job
 * somebody starts — each names its people through the ownership it already carries, and each is
 * bounded by them.
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
 * ({@link import("../job/householdJob").memberHorizonReach}) and models such a household sensibly
 * instead of relying on this.
 */

import type { PersonId } from "../job/job";
import type { LifeEvent } from "../ledger/eventTypes";
import type { Person } from "../plan/person";
import { lifeExpectancyEndMonthExclusive } from "../job/householdJob";
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
 * A thing that only happens if somebody is alive for it: what a refusal calls it, when it happens,
 * and every person it takes.
 */
interface PersonScoped {
  /** Singular noun, as a refusal says it — "marriage", "separation", "loan", "job". */
  readonly noun: string;
  /** The month it happens. A job's is its authored START; see {@link personScopedThings}. */
  readonly month: number;
  /** Everyone who must be alive then, primary first where they are one of them. */
  readonly participants: readonly PersonId[];
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
 * **A job's month is its START, and only its start.** A job is as person-scoped as any event —
 * nobody takes up work after they die — but its END is deliberately not bounded here, because
 * an expectancy does not end a wage: a job ends where it was authored to end, whatever the
 * expectancy, and that is the standing rule {@link import("../plan/person").Person.lifeExpectancy}
 * states. What cannot survive a death is beginning the job at all.
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
      participants: [person.id],
    })),
  );
  return [...fromEvents, ...fromJobs];
}

/**
 * Every person-scoped thing in `state` still happens while the people it takes are alive, or a
 * refusal naming the FIRST one that does not — first in time, so a household with several stranded
 * events is told about the earliest rather than about whichever the ledger happened to list first.
 *
 * The message names the EDIT's consequence rather than blaming the older event: that event is
 * already written, and was legal when it was.
 */
export function assertPersonEventsStillReachable(state: ProjectionState): void {
  const people = new Map(householdPeople(state).map((p) => [p.id as string, p]));
  const primaryId = state.scenario.plan.primary.id;

  let worst: { readonly thing: PersonScoped; readonly death: Death } | null = null;
  for (const thing of personScopedThings(state)) {
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
    if (thing.month < death.month) continue;
    if (worst === null || thing.month < worst.thing.month) worst = { thing, death };
  }
  if (worst === null) return;

  const { thing, death } = worst;
  // Everything the reader needs sits AFTER the em-dash: the app strips the `Projection: cannot X —`
  // prefix before showing this (see `useProjection`'s `conflictOf`), so a reason that leaned on the
  // prefix for the date would reach them without one.
  const needs = thing.participants.length > 1 ? "both partners alive" : "its owner alive";
  throw new Error(
    `Projection: cannot apply this change — it would strand the ` +
      `${yearOfMonth(state.startYear, thing.month)} ${thing.noun}: ${death.who} is projected to ` +
      `live only to ${death.year}, and a ${thing.noun} needs ${needs}`,
  );
}
