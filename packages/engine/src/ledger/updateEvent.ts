/**
 * updateEvent — revise an event that is already in the ledger (§6.1), the third write
 * alongside `addEvent` (grow) and `removeEvent` (undo).
 *
 * Until now the ledger could only be appended to and pruned, so anything authored *on*
 * an event was write-once: a partner's own jobs (issue #118) live on their
 * `RelationshipEvent`, which meant changing a partner's salary required removing the
 * partner and re-adding them, taking every event that depended on them along with it.
 * This closes that gap without weakening the log: an update is not a free rewrite, it is
 * a *replacement* that has to leave a ledger which still replays cleanly.
 *
 * What is fixed, and why:
 *   - **The id and the type.** Dependencies are tracked by event id and interpreted by
 *     type (`computeDependents`, the handler table), so a "revision" that changed either
 *     would be a different event wearing an existing event's name. Add and remove are the
 *     way to change what kind of thing happened.
 *   - **The sequence number.** It is the ledger's tie-breaker for same-month ordering
 *     (§6) and is never recycled; a revision keeps its place in that order rather than
 *     jumping to the end of the log.
 *
 * Everything else — including the month — is revisable, so validation is the same
 * whole-ledger replay `removeEvent` runs: check every remaining event against the
 * base-seeded state in interpretation order and block the edit, naming the offender, if
 * any precondition now fails. (Like undo, this runs the pure replay context: the §4.5
 * affordability gate needs a projection and fires on the authoring path in `addEvent`.)
 */

import type { Ledger } from "./ledger";
import type { LifeEvent, NewLifeEvent } from "./eventTypes";
import { applyEvent, checkEvent } from "./eventHandlers";
import { validateEventData } from "./eventValidation";
import { contextFrom, seedState, sortedEvents } from "./interpret";
import type { LedgerBaseConfig } from "./ledgerBase";

/** Success carries the revised ledger; failure carries a human-readable conflict. */
export type UpdateResult =
  | { ok: true; ledger: Ledger }
  | { ok: false; conflict: string };

export function updateEvent(
  ledger: Ledger,
  id: string,
  next: NewLifeEvent,
  base: LedgerBaseConfig,
): UpdateResult {
  const existing = ledger.events.find((e) => e.id === id);
  if (existing === undefined) {
    return { ok: false, conflict: `No event with id "${id}" to update` };
  }
  if (next.id !== id) {
    return {
      ok: false,
      conflict: `Cannot update event "${id}": the revision carries a different id "${next.id}"`,
    };
  }
  if (next.type !== existing.type) {
    return {
      ok: false,
      conflict: `Cannot update event "${id}": an event's type is fixed (${existing.type} → ${next.type}); remove it and add the new one instead`,
    };
  }

  const data = validateEventData(next);
  if (!data.ok) return { ok: false, conflict: data.reason };

  // The revision keeps its place in the ledger's order (§6).
  const revised = { ...next, sequenceNumber: existing.sequenceNumber } as LifeEvent;
  const events = ledger.events.map((e) => (e.id === id ? revised : e));

  // Replay everything from the base-seeded state: the revision has to satisfy its own
  // preconditions, and no event that came to depend on it may be stranded by the change.
  const state = seedState(base);
  const context = contextFrom(base);
  for (const event of sortedEvents(events)) {
    const check = checkEvent(event, state, context);
    if (!check.ok) {
      const blame =
        event.id === id
          ? `the revision fails — ${check.reason}`
          : `it causes event "${event.id}" (${event.type}) to fail — ${check.reason}`;
      return { ok: false, conflict: `Cannot update event "${id}": ${blame}` };
    }
    applyEvent(event, state, context);
  }

  // Sequence numbers are never recycled, and an update mints none.
  return { ok: true, ledger: { events, nextSequenceNumber: ledger.nextSequenceNumber } };
}
