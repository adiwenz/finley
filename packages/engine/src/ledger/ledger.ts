/**
 * The Ledger — the append-only event log that is the system's source of truth
 * (§0.3, §6). Everything else (projection, snapshot) is a pure derivation.
 */

import type { LifeEvent } from "./eventTypes";

/** Success, or a failure carrying a human-readable reason. */
export type ValidationResult = { ok: true } | { ok: false; reason: string };

export interface Ledger {
  readonly events: readonly LifeEvent[];
  /**
   * The sequence number the next appended event will receive.
   *
   * Invariant: strictly greater than every existing event's `sequenceNumber`.
   * It increments by one on every append and is **never decremented** — removing
   * an event does not recycle its number, so ids assigned to later appends stay
   * globally unique and monotonic across the ledger's lifetime. (It therefore
   * does *not* in general equal `events.length` once any event has been removed.)
   */
  readonly nextSequenceNumber: number;
}

export const emptyLedger: Ledger = { events: [], nextSequenceNumber: 0 };

/**
 * Structural validation of a ledger's own invariants (independent of replay):
 * unique event ids, unique sequence numbers, and the `nextSequenceNumber`
 * monotonicity invariant. Catches malformed or hand-assembled ledgers.
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
