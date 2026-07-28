/**
 * Undo — remove an event and its transitive dependents if the remaining ledger still replays
 * cleanly.
 *
 * Strategy A: replay the remaining events against the *same* base-seeded initial state normal
 * replay uses, so events referencing base people, accounts, or series validate correctly. Any
 * precondition failure blocks the removal and names the offending event.
 *
 * Strategy B: the removal set is the transitive causedBy closure of the target (see
 * {@link computeDependents}).
 */

import type { Ledger } from "./ledger";
import type { LedgerBaseConfig } from "./ledgerBase";
import { applyEvent, checkEvent } from "./eventHandlers";
import { contextFrom, seedState, sortedEvents } from "./interpret";
import { computeDependents } from "./dependencies";

export type RemoveResult =
  | { ok: true; ledger: Ledger }
  | { ok: false; conflict: string };

export function removeEvent(
  ledger: Ledger,
  id: string,
  base: LedgerBaseConfig,
): RemoveResult {
  if (!ledger.events.some((e) => e.id === id)) {
    return { ok: false, conflict: `No event with id "${id}" to remove` };
  }

  const toRemove = new Set(computeDependents(ledger, id));
  const remaining = ledger.events.filter((e) => !toRemove.has(e.id));

  // Strategy A: replay remaining events from the base-seeded state; block on any
  // precondition failure.
  const state = seedState(base);
  const context = contextFrom(base);
  for (const event of sortedEvents(remaining)) {
    const check = checkEvent(event, state, context);
    if (!check.ok) {
      return {
        ok: false,
        conflict: `Cannot remove event "${id}": removing it causes event "${event.id}" (${event.type}) to fail — ${check.reason}`,
      };
    }
    applyEvent(event, state, context);
  }

  return {
    ok: true,
    // Sequence numbers are never recycled (see Ledger.nextSequenceNumber).
    ledger: { events: remaining, nextSequenceNumber: ledger.nextSequenceNumber },
  };
}
