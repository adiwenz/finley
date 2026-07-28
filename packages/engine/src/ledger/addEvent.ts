/**
 * Unlike the pure interpret path, validators here run *affordability* preconditions needing
 * a projection (the down-payment block reads projected liquid balances) — which is why they
 * sit above the projection layer, keeping `interpret.ts` projection-free.
 */

import type { Ledger, ValidationResult } from "./ledger";
import type { LifeEvent, NewLifeEvent } from "./eventTypes";
import { checkEvent } from "./eventHandlers";
import { validateEventData } from "./eventValidation";
import { contextFrom, interpretLedger, interpretToState } from "./interpret";
import type { InterpretContext, FundingAvailability, FundingSourceBalance } from "./interpretState";
import type { LedgerBaseConfig } from "./ledgerBase";
import { buildProjection } from "../projection/buildHouseholdInput";
import {
  resolveOrderedFundingDraw,
  type FundingSourceState,
  type TaxableByOwner,
  type TaxableByCategory,
} from "../projection/fundingDrawStep";
import { nullJurisdiction, type Jurisdiction, type JurisdictionContext } from "../jurisdiction";

// simulate.ts / report.ts hold the same local constant. Only bracket indexing reads it, so
// an off-by-a-year is immaterial.
const DEFAULT_START_YEAR = 2026;

/**
 * Two funding questions about the ledger *so far*, answered from ONE projection: `sourcesAt`
 * gives the POOL, `availabilityAt` the VERDICT for a selection. Both read the same projected
 * `balanceCents`, so a picker and a gate can never tell the user different stories; the only
 * gap is tax, which the verdict reports separately (`taxed`).
 *
 * The pool is every liquid account that could fund a draw (cash goal fund included,
 * retirement excluded, credit never — a liability, not an asset), largest first. Membership
 * is a property of the ACCOUNT, not the month, so an emptied account is listed at $0.
 */
export interface FundingLookup {
  readonly sourcesAt: (month: number) => readonly FundingSourceBalance[];
  readonly availabilityAt: (
    sourceIds: readonly string[],
    amountCents: number,
    month: number,
  ) => FundingAvailability;
}

/**
 * The funding-availability check for the ledger *so far*, from one projection. Each source is
 * grossed up over the capital-gains tax its sale induces by the SAME ordered resolution the
 * simulator uses ({@link resolveOrderedFundingDraw}), differenced marginally over the owner's
 * projected other income that month PLUS any draw already authored there
 * (`flows.taxableByOwnerAfterFundingCents`) — so the gate blocks exactly when the sim would
 * fall short.
 *
 * Event-neutral, a question about a {@link import("./transfers").FundingDraw}: the Home
 * Purchase §4.5 down-payment gate and One-Time Spend get the identical answer. The month is
 * clamped into the horizon. Balances are positive-only: the cascade floors the liquid sink to
 * zero before each snapshot and every other account is drawn through `Math.max(0, …)` guards.
 */
export function fundingLookup(
  ledger: Ledger,
  base: LedgerBaseConfig,
  jurisdiction: Jurisdiction = nullJurisdiction,
): FundingLookup {
  const startYear = base.startYear ?? DEFAULT_START_YEAR;
  // `||`, not `??`, so an empty-string label falls back to the id too. The category prices
  // each sale's tax under its own provenance (a tax-exempt cash reserve untaxed; a taxable
  // brokerage bears its gain).
  const liquidAccounts = (base.initialAccounts ?? []).filter((a) => a.liquid);
  const labelById = new Map(liquidAccounts.map((a) => [a.id, a.label || a.id]));
  const ownerById = new Map(liquidAccounts.map((a) => [a.id, a.ownerId]));
  const categoryById = new Map(liquidAccounts.map((a) => [a.id, a.taxProfile.withdrawalCategory]));
  const projection = buildProjection(interpretLedger(ledger, base), base, jurisdiction);
  const last = projection.months.length - 1;
  // A Year-0 purchase draws against the funds on hand right now — the `opening` snapshot;
  // later months read that processed month's end-of-month balances, as before.
  const monthAt = (month: number) =>
    month <= 0 ? projection.opening : projection.months[Math.min(month, last)];

  // Whether a listed account can pay is `balanceCents > 0`, the test `availabilityAt` applies.
  const sourcesAt = (month: number): readonly FundingSourceBalance[] => {
    const m = monthAt(month);
    const pool: FundingSourceBalance[] = [];
    for (const [id, label] of labelById) {
      pool.push({ id, label, balanceCents: (m?.accountBalancesCents[id] ?? 0) as number });
    }
    return pool.sort((a, b) => b.balanceCents - a.balanceCents);
  };

  const availabilityAt = (
    sourceIds: readonly string[],
    amountCents: number,
    month: number,
  ): FundingAvailability => {
    const m = monthAt(month);
    const ctx: JurisdictionContext = { year: startYear + Math.floor(Math.max(0, month) / 12) };
    // A candidate appended now is last in ledger order, so the sim resolves it against
    // exactly this base.
    const taxableByOwner: TaxableByOwner = new Map();
    const baseRecord = m?.flows?.taxableByOwnerAfterFundingCents ?? {};
    for (const [ownerId, byCategory] of Object.entries(baseRecord)) {
      taxableByOwner.set(ownerId, { ...(byCategory as TaxableByCategory) });
    }

    const named: FundingSourceBalance[] = [];
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

    const { perSource, netDeliveredCents, shortfallCents } = resolveOrderedFundingDraw(
      amountCents,
      fundingSources,
      jurisdiction,
      ctx,
      taxableByOwner,
    );
    // Summed over the sources touched, NOT inferred from "delivered less than the sources
    // hold" — that holds for any draw smaller than its sources, and would call an untaxed
    // cash draw taxed.
    const taxCents = perSource.reduce((sum, s) => sum + s.taxCents, 0);
    return {
      shortfallCents,
      availableCents: netDeliveredCents,
      taxCents,
      taxed: taxCents > 0,
      sources: named,
    };
  };

  return { sourcesAt, availabilityAt };
}

/**
 * Base facts plus `fundingAvailabilityAt`, from one projection of the pre-candidate ledger.
 * Every money-out event's affordability gate fires through this alone.
 */
function addEventContext(
  ledger: Ledger,
  base: LedgerBaseConfig,
  jurisdiction: Jurisdiction,
): InterpretContext {
  return {
    ...contextFrom(base),
    fundingAvailabilityAt: fundingLookup(ledger, base, jurisdiction).availabilityAt,
  };
}

/**
 * Its own fields first, then its preconditions against the replayed state (including the
 * affordability gate). A standalone pre-check; {@link addEvent} runs it before appending.
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

export type AddResult =
  | { ok: true; ledger: Ledger }
  | { ok: false; conflict: string };

/** On failure the ledger is left untouched. `jurisdiction` feeds the affordability projection. */
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
