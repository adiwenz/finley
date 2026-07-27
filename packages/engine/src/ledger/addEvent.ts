/**
 * addEvent — the safe, base-aware way to grow the ledger; the write-path
 * twin of `removeEvent`.
 *
 * `addEvent`/`validateNewEvent` validate a candidate event's own fields and its
 * preconditions against the interpreted state before appending it. Unlike the
 * pure interpret path, this can also run *affordability* preconditions that need
 * a projection — the down-payment hard block reads projected liquid
 * balances. That projection is why these live here rather than in `interpret.ts`:
 * this module sits above the projection layer (it imports {@link buildProjection}),
 * keeping `interpret.ts` free of any projection dependency.
 */

import type { Ledger, ValidationResult } from "./ledger";
import type { LifeEvent, NewLifeEvent } from "./eventTypes";
import { checkEvent } from "./eventHandlers";
import { validateEventData } from "./eventValidation";
import { contextFrom, interpretLedger, interpretToState } from "./interpret";
import type { InterpretContext, LiquidBucket } from "./interpretState";
import type { LedgerBaseConfig } from "./ledgerBase";
import { buildProjection } from "../projection/buildHouseholdInput";
import { nullJurisdiction, type Jurisdiction } from "../jurisdiction";

/**
 * The liquid buckets available at each month for the ledger *so far*, from a
 * projection: one bucket per base `liquid` account with a positive balance, largest
 * first. The down-payment hard block both SUMS these for its sourced-funds total and
 * NAMES them in its conflict message, so the stated total and the printed list are one
 * value — they can never disagree. A liquid goal fund (a cash emergency reserve) IS a
 * bucket; its whole purpose is to be reachable. Credit is a liability, never an asset
 * here, so it can never fund a down payment. The month is clamped into the horizon.
 *
 * Positive-only is faithful to the full liquid position because a snapshot balance is
 * never negative: the shortfall cascade (`applyShortfallCascade`) floors the liquid
 * sink to zero and routes any deficit onto credit *before* the month is snapshotted,
 * and every other account is drawn down only through `Math.max(0, …)` guards. So the
 * summed buckets equal the full liquid total, with no hidden negative to reconcile.
 */
function liquidBucketsLookup(
  ledger: Ledger,
  base: LedgerBaseConfig,
  jurisdiction: Jurisdiction,
): (month: number) => readonly LiquidBucket[] {
  // Label by id so a counted bucket reads by its account name ("Emergency fund"),
  // falling back to the id when an account carries no label. `||` (not `??`) so an
  // empty-string label falls back too, rather than printing a nameless "()".
  const labelById = new Map(
    (base.initialAccounts ?? []).filter((a) => a.liquid).map((a) => [a.id, a.label || a.id]),
  );
  const projection = buildProjection(interpretLedger(ledger, base), base, jurisdiction);
  const last = projection.months.length - 1;
  const monthAt = (month: number) => projection.months[Math.max(0, Math.min(month, last))];
  return (month) => {
    const m = monthAt(month);
    if (!m) return [];
    const buckets: LiquidBucket[] = [];
    for (const [id, balance] of Object.entries(m.accountBalancesCents)) {
      const label = labelById.get(id);
      if (label !== undefined && balance > 0) buckets.push({ id, label, balanceCents: balance });
    }
    // Largest first is a stable default; the down-payment gate re-orders the buckets it
    // selects into the user's drain order, so this ordering only affects any consumer
    // that reads the whole pool.
    return buckets.sort((a, b) => b.balanceCents - a.balanceCents);
  };
}

/**
 * The add-event replay context: the base facts plus the `liquidBucketsAt` capability
 * (the liquid accounts the down-payment block sums for its total and names in its
 * message), from one projection of the ledger so far (the pre-candidate state).
 * Projection-dependent affordability checks fire only through this context.
 */
function addEventContext(
  ledger: Ledger,
  base: LedgerBaseConfig,
  jurisdiction: Jurisdiction,
): InterpretContext {
  return {
    ...contextFrom(base),
    liquidBucketsAt: liquidBucketsLookup(ledger, base, jurisdiction),
  };
}

/**
 * Validate a would-be appended event against the current ledger+base: its own
 * fields, then its preconditions relative to the replayed state (including the
 * affordability gate, evaluated with `jurisdiction`). A standalone
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
 * feeds the affordability projection; it defaults to the null jurisdiction
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
