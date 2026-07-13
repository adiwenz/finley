/**
 * Undo — remove an event (and its transitive dependents) if the remaining
 * ledger still replays cleanly (§6.1, §6.2).
 *
 * Strategy A: replay the remaining events against the *same* base-seeded initial
 * state normal replay uses (§7) — so events that reference base people, accounts,
 * or series are validated correctly. If any precondition fails, the removal is
 * blocked and the offending event is named.
 *
 * Strategy B: the removal set is the transitive causedBy closure of the target
 * (see {@link computeDependents}).
 */

import type { Ledger } from "./ledger";
import type { LedgerBaseConfig } from "./replayState";
import { applyEvent, checkEvent } from "./eventHandlers";
import { contextFrom, seedState, sortedEvents } from "./replay";
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
