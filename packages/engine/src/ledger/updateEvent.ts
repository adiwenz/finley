/**
 * Without this, anything authored *on* an event is write-once — a partner's jobs live on
 * their `RelationshipEvent`.
 *
 * Fixed: **id and type**, since dependencies are tracked by id and interpreted by type
 * (`computeDependents`, the handler table) — changing either means a different event, so use
 * add + remove. And the **sequence number**, the never-recycled same-month tie-breaker, so a
 * revision keeps its place rather than jumping to the end.
 *
 * Everything else, the month included, is revisable, so validation is the whole-ledger replay
 * `removeEvent` runs: every remaining event rechecked against the base-seeded state in
 * interpretation order, blocking the edit and naming the offender. No affordability gate
 * here — it needs a projection and fires only on `addEvent`.
 */

import type { Ledger } from "./ledger";
import type { LifeEvent, NewLifeEvent } from "./eventTypes";
import { validateEventData } from "./eventValidation";
import type { LedgerBaseConfig } from "./ledgerBase";
import { validateLedger } from "./validateLedger";

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

  const revised = { ...next, sequenceNumber: existing.sequenceNumber } as LifeEvent;
  // Sequence numbers are never recycled, and an update mints none.
  const updated: Ledger = {
    events: ledger.events.map((e) => (e.id === id ? revised : e)),
    nextSequenceNumber: ledger.nextSequenceNumber,
  };

  // Replay from the base-seeded state: the revision must satisfy its own preconditions,
  // and no event depending on it may be stranded.
  const replay = validateLedger(updated, base);
  if (!replay.ok) {
    const blame =
      replay.event.id === id
        ? `the revision fails — ${replay.reason}`
        : `it causes event "${replay.event.id}" (${replay.event.type}) to fail — ${replay.reason}`;
    return { ok: false, conflict: `Cannot update event "${id}": ${blame}` };
  }

  return { ok: true, ledger: updated };
}
