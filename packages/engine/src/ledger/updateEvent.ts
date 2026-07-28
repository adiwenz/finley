/**
 * Revise an event already in the ledger — the third write alongside `addEvent` (grow)
 * and `removeEvent` (undo). Without it, anything authored *on* an event is write-once:
 * a partner's jobs live on their `RelationshipEvent`, so changing a partner's salary
 * meant removing the partner and every event depending on them. An update is not a free
 * rewrite but a *replacement* that must leave a ledger which still replays cleanly.
 *
 * Fixed, and why:
 *   - **id and type** — dependencies are tracked by id and interpreted by type
 *     (`computeDependents`, the handler table), so changing either would be a different
 *     event wearing an existing one's name. Use add + remove for that.
 *   - **sequence number** — the ledger's tie-breaker for same-month ordering, never
 *     recycled; a revision keeps its place rather than jumping to the end of the log.
 *
 * Everything else, including the month, is revisable, so validation is the same
 * whole-ledger replay `removeEvent` runs: check every remaining event against the
 * base-seeded state in interpretation order and block the edit, naming the offender, if
 * a precondition now fails. Like undo, this runs the pure replay context — the
 * affordability gate needs a projection and fires on `addEvent`'s authoring path.
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

  // The revision keeps its place in the ledger's order.
  const revised = { ...next, sequenceNumber: existing.sequenceNumber } as LifeEvent;
  const events = ledger.events.map((e) => (e.id === id ? revised : e));

  // Replay from the base-seeded state: the revision must satisfy its own preconditions,
  // and no event depending on it may be stranded.
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
