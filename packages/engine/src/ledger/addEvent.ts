/**
 * addEvent — the safe, base-aware way to grow the ledger (§6.1); the write-path
 * twin of `removeEvent`.
 *
 * `addEvent`/`validateNewEvent` validate a candidate event's own fields and its
 * preconditions against the interpreted state before appending it. Unlike the
 * pure interpret path, this can also run *affordability* preconditions that need
 * a projection — the §4.5 down-payment hard block reads projected liquid
 * balances. That projection is why these live here rather than in `interpret.ts`:
 * this module sits above the projection layer (it imports {@link buildProjection}),
 * keeping `interpret.ts` free of any projection dependency.
 */

import type { Ledger, ValidationResult } from "./ledger";
import type { LifeEvent, NewLifeEvent } from "./eventTypes";
import { checkEvent } from "./eventHandlers";
import { validateEventData } from "./eventValidation";
import { contextFrom, interpretLedger, interpretToState } from "./interpret";
import type { InterpretContext } from "./interpretState";
import type { LedgerBaseConfig } from "./ledgerBase";
import { buildProjection } from "../projection/buildHouseholdInput";
import { nullJurisdiction, type Jurisdiction } from "../jurisdiction";

/**
 * Liquid funds available at each month for the ledger *so far*, summed across the
 * base's `liquid` accounts from a projection. This is the sourced-funds figure the
 * §4.5 down-payment hard block checks against; credit is a liability, never an
 * asset here, so it can never fund a down payment. The month is clamped into the
 * projection horizon.
 */
function liquidBalanceLookup(
  ledger: Ledger,
  base: LedgerBaseConfig,
  jurisdiction: Jurisdiction,
): (month: number) => number {
  const liquidIds = new Set(
    (base.initialAccounts ?? []).filter((a) => a.liquid).map((a) => a.id),
  );
  const projection = buildProjection(interpretLedger(ledger, base), base, jurisdiction);
  const last = projection.months.length - 1;
  return (month) => {
    const m = projection.months[Math.max(0, Math.min(month, last))];
    if (!m) return 0;
    let sum = 0;
    for (const [id, balance] of Object.entries(m.accountBalancesCents)) {
      if (liquidIds.has(id)) sum += balance;
    }
    return sum;
  };
}

/**
 * The add-event replay context: the base facts plus a `liquidBalanceAt`
 * capability from a projection of the ledger so far (the pre-candidate state).
 * Projection-dependent affordability checks fire only through this context.
 */
function addEventContext(
  ledger: Ledger,
  base: LedgerBaseConfig,
  jurisdiction: Jurisdiction,
): InterpretContext {
  return {
    ...contextFrom(base),
    liquidBalanceAt: liquidBalanceLookup(ledger, base, jurisdiction),
  };
}

/**
 * Validate a would-be appended event against the current ledger+base: its own
 * fields, then its preconditions relative to the replayed state (including the
 * §4.5 affordability gate, evaluated with `jurisdiction`). A standalone
 * pre-check; {@link addEvent} runs this internally before appending.
 */
export function validateNewEvent(
  ledger: Ledger,
  base: LedgerBaseConfig,
  event: NewLifeEvent,
  jurisdiction: Jurisdiction = nullJurisdiction,
): ValidationResult {
  const data = validateEventData(event);
  if (!data.ok) return data;
  const stamped = { ...event, sequenceNumber: ledger.nextSequenceNumber } as LifeEvent;
  return checkEvent(
    stamped,
    interpretToState(ledger, base),
    addEventContext(ledger, base, jurisdiction),
  );
}

/** Success carries the grown ledger; failure carries a human-readable conflict. */
export type AddResult =
  | { ok: true; ledger: Ledger }
  | { ok: false; conflict: string };

/**
 * The safe, base-aware way to grow the ledger — symmetric with `removeEvent`.
 * Validates the event's own fields and its preconditions against the replayed
 * state; on success appends it (stamped with the next sequence number), on
 * failure returns the conflict and leaves the ledger untouched. `jurisdiction`
 * feeds the §4.5 affordability projection; it defaults to the null jurisdiction
 * so existing callers stay source-compatible.
 */
export function addEvent(
  ledger: Ledger,
  base: LedgerBaseConfig,
  event: NewLifeEvent,
  jurisdiction: Jurisdiction = nullJurisdiction,
): AddResult {
  const check = validateNewEvent(ledger, base, event, jurisdiction);
  if (!check.ok) return { ok: false, conflict: check.reason };
  const stamped = { ...event, sequenceNumber: ledger.nextSequenceNumber } as LifeEvent;
  return {
    ok: true,
    ledger: {
      events: [...ledger.events, stamped],
      nextSequenceNumber: ledger.nextSequenceNumber + 1,
    },
  };
}
