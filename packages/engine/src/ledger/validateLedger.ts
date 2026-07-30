/**
 * Replay-validity — a ledger is valid when every event satisfies its precondition against the
 * state its predecessors produce. Seed the base-seeded initial state (so events referencing
 * base persons, accounts, or series validate), then in interpretation order `checkEvent` and
 * `applyEvent` each event, bailing on the first conflict and returning the offender.
 *
 * This is replay validity, *not* affordability: `checkEvent` never re-litigates a purchase's
 * affordability, so a validly-replaying ledger may still project insolvent. Callers phrase
 * their own message around the returned event; the fold itself stays message-agnostic — the
 * `reason` explains the failure and says nothing about *which* event failed, because that is
 * the returned `event`'s job and a caller's message shape is its own.
 */

import type { Ledger } from "./ledger";
import type { LifeEvent } from "./eventTypes";
import type { LedgerBaseConfig } from "./ledgerBase";
import { applyEvent, checkEvent, isKnownEventType } from "./eventHandlers";
import { contextFrom, seedState, sortedEvents } from "./interpret";

export type ValidateLedgerResult =
  | { ok: true }
  | { ok: false; event: LifeEvent; reason: string };

export function validateLedger(ledger: Ledger, base: LedgerBaseConfig): ValidateLedgerResult {
  const state = seedState(base);
  const context = contextFrom(base);
  for (const event of sortedEvents(ledger.events)) {
    // The discriminant first: an imported event is `unknown` data wearing a `LifeEvent` type,
    // so a hand-edited or version-skewed one may name an event this build has no handler for.
    // Dispatching it would throw a raw `TypeError` from deep inside the fold; refusing it here
    // makes it the same kind of answer as any other precondition failure.
    if (!isKnownEventType(event.type)) {
      return { ok: false, event, reason: "unknown event type" };
    }
    const check = checkEvent(event, state, context);
    if (!check.ok) return { ok: false, event, reason: check.reason };
    applyEvent(event, state, context);
  }
  return { ok: true };
}
