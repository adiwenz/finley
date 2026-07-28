/**
 * The Ledger — the append-only event log that is the system's source of truth. Everything
 * else (projection, snapshot) is a pure derivation.
 */

import type { LifeEvent } from "./eventTypes";

export type ValidationResult = { ok: true } | { ok: false; reason: string };

export interface Ledger {
  readonly events: readonly LifeEvent[];
  /**
   * Invariant: strictly greater than every existing event's `sequenceNumber`. **Never
   * decremented** — removing an event does not recycle its number, so numbers stay unique
   * and monotonic, and this does *not* equal `events.length` once anything is removed.
   */
  readonly nextSequenceNumber: number;
}

export const emptyLedger: Ledger = { events: [], nextSequenceNumber: 0 };

/**
 * A ledger's own invariants, independent of replay: unique event ids, unique sequence
 * numbers, and `nextSequenceNumber` monotonicity.
 */
export function validateLedgerStructure(ledger: Ledger): ValidationResult {
  const seenIds = new Set<string>();
  const seenSeq = new Set<number>();
  for (const e of ledger.events) {
    if (seenIds.has(e.id)) {
      return { ok: false, reason: `Duplicate event id "${e.id}"` };
    }
    seenIds.add(e.id);
    if (seenSeq.has(e.sequenceNumber)) {
      return {
        ok: false,
        reason: `Duplicate sequence number ${e.sequenceNumber} (event "${e.id}")`,
      };
    }
    seenSeq.add(e.sequenceNumber);
    if (e.sequenceNumber >= ledger.nextSequenceNumber) {
      return {
        ok: false,
        reason: `Event "${e.id}" has sequence number ${e.sequenceNumber} ≥ nextSequenceNumber ${ledger.nextSequenceNumber}`,
      };
    }
  }
  return { ok: true };
}
