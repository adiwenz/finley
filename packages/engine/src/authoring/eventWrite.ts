/**
 * The ledger-plane write primitives every timeline edit routes through — append, replace, drop
 * — plus the replay context they all validate against.
 *
 * They exist as one module because they share the thing that makes a ledger write different
 * from a plan write: the plan compiled under the *validation* jurisdiction, so a
 * jurisdiction-gated authoring check (the down-payment gate netting funds after capital-gains
 * tax) sees the same numbers the app does rather than the tax-free answer. A module that
 * appends an event does not get to decide that separately.
 *
 * Each refuses by throwing with no state derived, so a rejected write consumes no id and the
 * caller's state is untouched.
 */

import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import type { LedgerBaseConfig } from "../ledger/ledgerBase";
import type { NewLifeEvent } from "../ledger/eventTypes";
import { addEvent, fundingLookup, fundingLookupExcludingEvent } from "../ledger/addEvent";
import type { FundingLookup } from "../ledger/addEvent";
import { removeEvent } from "../ledger/removeEvent";
import { updateEvent } from "../ledger/updateEvent";
import { validateLedger } from "../ledger/validateLedger";
import { createProjectionBase } from "../compile/projectionBase";
import type { ProjectionState } from "./state";
import { withStateLedger } from "./state";
import { assertPersonEventsStillReachable } from "./reachability";

/**
 * The state a ledger write produces, once every person-scoped event in it is known to happen while
 * the people it takes are alive — or a refusal naming the first that does not.
 *
 * On the APPEND as well as the revision, and that pairing is the point. A revision can move a
 * partner's `birthYear` or `lifeExpectancy`, and so the month they die, under events already
 * written; an append can date a new loan or wedding past a death that is already on the books.
 * Guarding only one of the two would leave a household that can author an unreachable event and
 * then be refused every subsequent edit for carrying it — the check would brick the plan instead
 * of protecting it. Guarding both keeps the invariant true of every state authoring ever produces,
 * which is what lets an edit be refused for what IT changes and nothing else.
 *
 * {@link dropEvent} needs none: removing an event cannot strand one.
 */
function reachable(next: ProjectionState): ProjectionState {
  assertPersonEventsStillReachable(next);
  return next;
}

/**
 * The replay context every ledger write validates against: the plan compiled under
 * `jurisdiction`, which is the *validation* jurisdiction a handle was constructed with — never
 * the one a run is asked for.
 */
export function projectionBaseFor(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
): LedgerBaseConfig {
  return createProjectionBase(state.scenario.plan, {
    jurisdiction,
    startYear: state.startYear,
  });
}

/**
 * Reject a pre-built ledger that will not replay cleanly against this plan's base — the gate on
 * every import path that installs a timeline whole rather than minting it event-by-event. A
 * structurally-valid but un-replayable ledger (tampered, hand-edited, version-skewed) would
 * otherwise install silently and project garbage; here it throws, naming the stranded event.
 *
 * Replay validity only — {@link validateLedger} runs `checkEvent`, never the affordability
 * gate, so a plan that projects insolvent still loads. Complementary to the counter floor: that
 * floors ids, this checks preconditions; neither substitutes for the other.
 *
 * The offender's id and type are stamped into the message here rather than borrowed from the
 * `reason`: a reason is free to explain the failure without naming the event (the unknown-type
 * rejection does exactly that), so a message that relied on it would silently lose the one
 * detail a user needs to find the bad row. Same detail {@link replaceEvent} / {@link dropEvent}
 * give.
 */
export function assertReplayable(state: ProjectionState, jurisdiction: Jurisdiction): void {
  const result = validateLedger(state.scenario.ledger, projectionBaseFor(state, jurisdiction));
  if (!result.ok) {
    const { id, type } = result.event;
    throw new Error(`Projection: cannot load — event "${id}" (${type}) fails — ${result.reason}`);
  }
}

/**
 * The funding question against the ledger so far — which liquid accounts could pay a money-out
 * event at a month, and what a chosen set nets after tax.
 *
 * A read, but it belongs beside the writes: it must be built from the SAME
 * {@link projectionBaseFor} context and validation jurisdiction the affordability gate decides
 * on, or an authoring picker and the down-payment gate would tell the user different stories
 * about the same accounts. Sharing the context is what makes that impossible rather than merely
 * unlikely.
 *
 * `excludeEventId`, when given, prices each query at the excluded event's OWN month argument,
 * treated as its (possibly still-being-dragged-around-the-form) hypothetical position — every
 * event that would execute before it AT THAT MONTH counts, the event itself never does, and a
 * sibling that would execute after it there does not either, whether that is a later-month event
 * or a same-month sibling authored after it. An event being edited must not see its OWN prior
 * draw as already-spent money it is then asked to also cover, but a not-yet-executed sibling must
 * not shrink what it sees either — and moving the draft to a different month must reprice against
 * who would ACTUALLY execute before it there, not who preceded it at its old month. See
 * {@link fundingLookupExcludingEvent}, which this delegates to unchanged. Absent for an ordinary
 * (non-editing) read.
 */
export function projectionFunding(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  excludeEventId?: string,
): FundingLookup {
  const base = projectionBaseFor(state, jurisdiction);
  return excludeEventId === undefined
    ? fundingLookup(state.scenario.ledger, base, jurisdiction)
    : fundingLookupExcludingEvent(state.scenario.ledger, base, jurisdiction, excludeEventId);
}

/**
 * Append a transaction. Validates through {@link addEvent} — including the affordability gate,
 * run under `jurisdiction` — and carries the post-mint `nextSeq` into the same new state, so
 * ledger and counter land together.
 */
export function appendEvent(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  event: NewLifeEvent,
  nextSeq: number,
): ProjectionState {
  const result = addEvent(
    state.scenario.ledger,
    projectionBaseFor(state, jurisdiction),
    event,
    jurisdiction,
  );
  if (!result.ok) {
    throw new Error(`Projection: cannot apply transaction — ${result.conflict}`);
  }
  return reachable(withStateLedger(state, result.ledger, nextSeq));
}

/**
 * Rewrite one event in place through the whole-ledger replay {@link updateEvent} runs, so a
 * revision that would strand a later event is refused with the state untouched. No general
 * affordability gate — that otherwise fires only on append — except One-Time Spend, which
 * carries its own hard block and keeps enforcing it here too (`updateEvent` prices it against
 * the ledger without this event, so its own prior draw never counts against itself).
 *
 * `nextSeq` moves with it when the revision minted something (a partner's new job), so the
 * ledger and the counter that named its contents land as ONE new state.
 */
export function replaceEvent(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  eventId: string,
  next: NewLifeEvent,
  nextSeq?: number,
): ProjectionState {
  const result = updateEvent(
    state.scenario.ledger,
    eventId,
    next,
    projectionBaseFor(state, jurisdiction),
    jurisdiction,
  );
  if (!result.ok) {
    throw new Error(`Projection: cannot revise transaction — ${result.conflict}`);
  }
  return reachable(withStateLedger(state, result.ledger, nextSeq));
}

/**
 * Drop an event and, transitively, everything it caused. REFUSED when the remaining ledger
 * would no longer replay, and the conflict names the event that would fail.
 */
export function dropEvent(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  eventId: string,
): ProjectionState {
  const result = removeEvent(
    state.scenario.ledger,
    eventId,
    projectionBaseFor(state, jurisdiction),
  );
  if (!result.ok) {
    throw new Error(`Projection: cannot remove transaction — ${result.conflict}`);
  }
  return withStateLedger(state, result.ledger);
}
