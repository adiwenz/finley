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
 * interpretation order, blocking the edit and naming the offender. No general affordability
 * gate here — it needs a projection and otherwise fires only on `addEvent` — EXCEPT One-Time
 * Spend, which carries its own hard block (`oneTimeSpend.check`) and must keep enforcing it on
 * revise too, priced at the revision's own SEQUENCE POSITION (see below), never letting an edit
 * quietly become unfunded the way `addEvent` would already refuse.
 */

import type { Ledger } from "./ledger";
import type { LifeEvent, NewLifeEvent } from "./eventTypes";
import { validateEventData } from "./eventValidation";
import type { LedgerBaseConfig } from "./ledgerBase";
import { validateLedger } from "./validateLedger";
import { validateNewEvent, ledgerBeforeEvent } from "./addEvent";
import { nullJurisdiction, type Jurisdiction } from "../jurisdiction/jurisdiction";

export type UpdateResult =
  | { ok: true; ledger: Ledger }
  | { ok: false; conflict: string };

export function updateEvent(
  ledger: Ledger,
  id: string,
  next: NewLifeEvent,
  base: LedgerBaseConfig,
  jurisdiction: Jurisdiction = nullJurisdiction,
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

  // One-Time Spend's own affordability gate must be priced at the revision's own SEQUENCE
  // POSITION, not against the whole ledger minus itself: `ledgerBeforeEvent` keeps every event
  // that precedes it (any earlier month, or an earlier same-month sibling) and drops the event
  // itself AND everything after it (a later-month event, or a same-month sibling authored after
  // it) — so a sibling that hasn't executed yet from this event's point of view never competes
  // for its funds, and a sibling that already has always does. Whether THAT sibling remains
  // fundable after this revision is not re-litigated here — it stays a normal simulation-time
  // block, the way a brand-new event's own effect on a later one already is.
  if (next.type === "OneTimeSpendEvent") {
    const affordability = validateNewEvent(ledgerBeforeEvent(ledger, id), base, next, jurisdiction);
    if (!affordability.ok) {
      return {
        ok: false,
        conflict: `Cannot update event "${id}": the revision fails — ${affordability.reason}`,
      };
    }
  }

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
