/**
 * The Ledger — the append-only event log that is the system's source of truth
 * (§0.3, §6). Everything else (projection, snapshot) is a pure derivation.
 */

import type { LifeEvent, NewLifeEvent } from "./eventTypes";
import { validateEventData } from "./eventValidation";

/** Success, or a failure carrying a human-readable reason. */
export type ValidationResult = { ok: true } | { ok: false; reason: string };

/** Thrown by {@link appendEvent} when an event's own fields are malformed. */
export class EventValidationError extends Error {}

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

/** Append an event, stamping it with the next sequence number. */
export function appendEvent(ledger: Ledger, event: NewLifeEvent): Ledger {
  const data = validateEventData(event);
  if (!data.ok) throw new EventValidationError(data.reason);
  const stamped = {
    ...event,
    sequenceNumber: ledger.nextSequenceNumber,
  } as LifeEvent;
  return {
    events: [...ledger.events, stamped],
    nextSequenceNumber: ledger.nextSequenceNumber + 1,
  };
}

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
