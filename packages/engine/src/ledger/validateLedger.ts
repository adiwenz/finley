/**
 * Replay-validity — a ledger is valid when every event satisfies its precondition against the
 * state its predecessors produce. Seed the base-seeded initial state (so events referencing
 * base persons, accounts, or series validate), then in interpretation order `checkEvent` and
 * `applyEvent` each event, bailing on the first conflict and returning the offender.
 *
 * This is replay validity, *not* affordability: `checkEvent` never re-litigates a purchase's
 * affordability, so a validly-replaying ledger may still project insolvent. Callers phrase
 * their own message around the returned event; the fold itself stays message-agnostic.
 */

import type { Ledger } from "./ledger";
import type { LifeEvent } from "./eventTypes";
import type { LedgerBaseConfig } from "./ledgerBase";
import { applyEvent, checkEvent } from "./eventHandlers";
import { contextFrom, seedState, sortedEvents } from "./interpret";

export type ValidateLedgerResult =
  | { ok: true }
  | { ok: false; event: LifeEvent; reason: string };

export function validateLedger(ledger: Ledger, base: LedgerBaseConfig): ValidateLedgerResult {
  const state = seedState(base);
  const context = contextFrom(base);
  for (const event of sortedEvents(ledger.events)) {
    const check = checkEvent(event, state, context);
    if (!check.ok) return { ok: false, event, reason: check.reason };
    applyEvent(event, state, context);
  }
  return { ok: true };
}
