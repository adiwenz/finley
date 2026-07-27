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
import type { InterpretContext, DownPaymentAffordability, DownPaymentSource } from "./interpretState";
import type { LedgerBaseConfig } from "./ledgerBase";
import { buildProjection } from "../projection/buildHouseholdInput";
import {
  resolveOrderedFundingDraw,
  type FundingSourceState,
  type TaxableByOwner,
  type TaxableByCategory,
} from "../projection/fundingDrawStep";
import { nullJurisdiction, type Jurisdiction, type JurisdictionContext } from "../jurisdiction";

// The projection's default start year (simulate.ts / report.ts hold the same local
// constant): only bracket indexing reads it, so an off-by-a-year here is immaterial.
const DEFAULT_START_YEAR = 2026;

/**
 * The §4.5 down-payment affordability check for the ledger *so far*, from one projection.
 * Given the SELECTED sources (in drain order), the down payment, and the month, it runs the
 * SAME ordered gross-up the simulator uses ({@link resolveOrderedFundingDraw}) against the
 * projected month state — draining each source, grossed up over the capital-gains tax the
 * sale induces (differenced marginally over the owner's projected other income that month,
 * from `flows.taxableByOwnerCents`) — and reports whether the net covers the down payment.
 * Because it is the SAME resolution the sim runs, the gate blocks exactly when the sim would
 * fall short, under any tax regime.
 *
 * Only liquid accounts fund a down payment (a cash goal fund included; credit never, being a
 * liability), so a selected id that is not a positive-balance liquid account contributes 0
 * to the draw yet is still named (at balance 0) in the returned sources. The month is clamped
 * into the horizon. Balances are positive-only — faithful to the full liquid position,
 * because the cascade floors the liquid sink to zero before each snapshot and every other
 * account is drawn only through `Math.max(0, …)` guards, so no hidden negative to reconcile.
 */
function downPaymentAffordabilityLookup(
  ledger: Ledger,
  base: LedgerBaseConfig,
  jurisdiction: Jurisdiction,
): (sourceIds: readonly string[], amountCents: number, month: number) => DownPaymentAffordability {
  const startYear = base.startYear ?? DEFAULT_START_YEAR;
  // Label and withdrawal category of each LIQUID account: the label names a counted source
  // ("Emergency fund", falling back to the id — `||`, not `??`, so an empty-string label
  // falls back too rather than a nameless "()"); the category prices each sale's tax under
  // its own provenance (a tax-exempt cash reserve untaxed; a taxable brokerage bears its gain).
  const liquidAccounts = (base.initialAccounts ?? []).filter((a) => a.liquid);
  const labelById = new Map(liquidAccounts.map((a) => [a.id, a.label || a.id]));
  const ownerById = new Map(liquidAccounts.map((a) => [a.id, a.ownerId]));
  const categoryById = new Map(liquidAccounts.map((a) => [a.id, a.taxProfile.withdrawalCategory]));
  const projection = buildProjection(interpretLedger(ledger, base), base, jurisdiction);
  const last = projection.months.length - 1;
  const monthAt = (month: number) => projection.months[Math.max(0, Math.min(month, last))];
  return (sourceIds, amountCents, month) => {
    const m = monthAt(month);
    const ctx: JurisdictionContext = { year: startYear + Math.floor(Math.max(0, month) / 12) };
    // The owner's projected NON-funding taxable base for this month, the marginal context the
    // sale's tax is differenced over — the very map the sim exposed from this same projection.
    const taxableByOwner: TaxableByOwner = new Map();
    const baseRecord = m?.flows?.taxableByOwnerCents ?? {};
    for (const [ownerId, byCategory] of Object.entries(baseRecord)) {
      taxableByOwner.set(ownerId, { ...(byCategory as TaxableByCategory) });
    }

    // The selected sources in drain order: name every one (balance 0 if not a liquid,
    // positive-balance account), but only fund the draw from those that genuinely can.
    const named: DownPaymentSource[] = [];
    const fundingSources: FundingSourceState[] = [];
    for (const id of sourceIds) {
      const label = labelById.get(id) ?? id;
      const balance = (m?.accountBalancesCents[id] ?? 0) as number;
      const isLiquidBucket = labelById.has(id) && balance > 0;
      named.push({ id, label, balanceCents: isLiquidBucket ? balance : 0 });
      if (isLiquidBucket) {
        fundingSources.push({
          id,
          ownerId: ownerById.get(id) ?? "",
          category: categoryById.get(id) ?? "capitalGains",
          balanceCents: balance,
          basisCents: (m?.accountBasisCents[id] ?? 0) as number,
          label,
        });
      }
    }

    const { netDeliveredCents, shortfallCents } = resolveOrderedFundingDraw(
      amountCents,
      fundingSources,
      jurisdiction,
      ctx,
      taxableByOwner,
    );
    const combinedBalance = named.reduce((sum, s) => sum + s.balanceCents, 0);
    return {
      shortfallCents,
      availableCents: netDeliveredCents,
      // Tax bit into coverage when the sources net less than they hold (only meaningful, and
      // only read, when there is a shortfall — where the sources were drained dry).
      taxed: netDeliveredCents < combinedBalance,
      sources: named,
    };
  };
}

/**
 * The add-event replay context: the base facts plus the `downPaymentAffordabilityAt`
 * capability (the §4.5 down-payment check), from one projection of the ledger so far (the
 * pre-candidate state). Projection-dependent affordability checks fire only through this.
 */
function addEventContext(
  ledger: Ledger,
  base: LedgerBaseConfig,
  jurisdiction: Jurisdiction,
): InterpretContext {
  return {
    ...contextFrom(base),
    downPaymentAffordabilityAt: downPaymentAffordabilityLookup(ledger, base, jurisdiction),
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
