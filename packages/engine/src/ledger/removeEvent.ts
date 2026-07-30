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
import { computeDependents } from "./dependencies";
import { validateLedger } from "./validateLedger";

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
  // Sequence numbers are never recycled (see Ledger.nextSequenceNumber).
  const remaining: Ledger = {
    events: ledger.events.filter((e) => !toRemove.has(e.id)),
    nextSequenceNumber: ledger.nextSequenceNumber,
  };

  // Strategy A: the remaining ledger must still replay cleanly against the same base-seeded
  // state; block on the first precondition failure and name the stranded event.
  const replay = validateLedger(remaining, base);
  if (!replay.ok) {
    return {
      ok: false,
      conflict: `Cannot remove event "${id}": removing it causes event "${replay.event.id}" (${replay.event.type}) to fail — ${replay.reason}`,
    };
  }

  return { ok: true, ledger: remaining };
}
