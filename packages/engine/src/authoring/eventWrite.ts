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
import { addEvent, fundingLookup } from "../ledger/addEvent";
import type { FundingLookup } from "../ledger/addEvent";
import { removeEvent } from "../ledger/removeEvent";
import { updateEvent } from "../ledger/updateEvent";
import { validateLedger } from "../ledger/validateLedger";
import { createProjectionBase } from "../compile/projectionBase";
import type { ProjectionState } from "./state";
import { withStateLedger } from "./state";

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
 */
export function projectionFunding(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
): FundingLookup {
  return fundingLookup(
    state.scenario.ledger,
    projectionBaseFor(state, jurisdiction),
    jurisdiction,
  );
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
  return withStateLedger(state, result.ledger, nextSeq);
}

/**
 * Rewrite one event in place through the whole-ledger replay {@link updateEvent} runs, so a
 * revision that would strand a later event is refused with the state untouched. No affordability
 * gate — that fires only on append.
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
  );
  if (!result.ok) {
    throw new Error(`Projection: cannot revise transaction — ${result.conflict}`);
  }
  return withStateLedger(state, result.ledger, nextSeq);
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
