/**
 * Interpret — the one place event meaning becomes household state (§1).
 *
 * `interpretLedger` folds the ledger over the handler registry and returns an
 * immutable {@link Household}. Both projection and snapshot consume
 * *that* object, so they can never interpret the ledger differently. Base
 * (value-editing surface) series are folded in here too, so they appear in the
 * projection and the snapshot identically.
 */

import type { Ledger } from "./ledger";
import type { LifeEvent } from "./eventTypes";
import { applyEvent } from "./eventHandlers";
import { asPersonId, asSeriesId, type AccountId } from "../ids";
import { SimCashFlowSeries } from "../cashFlowSeries";
import type { SimOwnedSeries } from "../projection/simulate";
import { freshState, type InterpretContext, type InterpretState, type SeriesDef } from "./interpretState";
import type { LedgerBaseConfig } from "./ledgerBase";
import type {
  Household,
  HouseholdLiability,
  HouseholdProperty,
  HouseholdSeries,
} from "./household";

/** Materialize a series descriptor into the one shared calculation primitive. */
function materializeSeries(def: SeriesDef): SimCashFlowSeries {
  const initialBaseCents =
    def.baseline.unit === "annual" ? def.baseline.annualCents : def.baseline.monthlyCents;
  return new SimCashFlowSeries(def.startMonth, initialBaseCents, def.growthMode, {
    baselineUnit: def.baseline.unit,
    endMonth: def.endMonth ?? undefined,
    taxCategory: def.taxCategory,
  });
}

/** Interpretation order: (month ASC, sequenceNumber ASC) — producer-before-consumer (§5, §6). */
export function sortedEvents(events: readonly LifeEvent[]): LifeEvent[] {
  return [...events].sort(
    (a, b) => a.month - b.month || a.sequenceNumber - b.sequenceNumber,
  );
}

export function contextFrom(base: LedgerBaseConfig): InterpretContext {
  const accountIds = new Set<AccountId>();
  for (const acc of base.initialAccounts ?? []) accountIds.add(acc.id as AccountId);
  return { accountIds, annualInflationRate: base.annualInflationRate };
}

/** Seed the pre-event household from base config (durable persons present from the start). */
export function seedState(base: LedgerBaseConfig): InterpretState {
  const state = freshState();
  for (const person of base.initialPersons ?? []) {
    state.personsById.set(asPersonId(person.id), {
      person,
      startMonth: -Infinity,
      endMonth: null,
    });
  }
  return state;
}

/** Interpret to the internal (mutable) state — shared by household build and undo. */
export function interpretToState(ledger: Ledger, base: LedgerBaseConfig): InterpretState {
  const state = seedState(base);
  const context = contextFrom(base);
  for (const event of sortedEvents(ledger.events)) applyEvent(event, state, context);
  return state;
}

function baseSeries(
  os: SimOwnedSeries,
  seriesType: "income" | "expense",
  index: number,
): HouseholdSeries {
  return {
    id: asSeriesId(`base-${seriesType}-${index}`),
    ownerId: asPersonId(os.ownerId),
    seriesType,
    role: "base",
    causedByEventId: null,
    startMonth: os.series.startMonth,
    endMonth: os.series.endMonth ?? null,
    series: os.series,
    planDescriptor: os.planDescriptor,
  };
}

function toHousehold(state: InterpretState, base: LedgerBaseConfig): Household {
  const series: HouseholdSeries[] = [
    ...(base.initialIncomeSeries ?? []).map((os, i) => baseSeries(os, "income", i)),
    ...(base.initialExpenseSeries ?? []).map((os, i) => baseSeries(os, "expense", i)),
    ...[...state.seriesById.values()].map(
      (def): HouseholdSeries => ({
        id: def.id,
        ownerId: def.ownerId,
        seriesType: def.seriesType,
        role: def.role,
        causedByEventId: def.causedByEventId,
        startMonth: def.startMonth,
        endMonth: def.endMonth,
        series: materializeSeries(def),
      }),
    ),
  ];

  const liabilities: HouseholdLiability[] = [...state.liabilitiesById.values()].map((def) => ({
    id: def.id,
    kind: def.kind,
    ownerId: def.ownerId,
    causedByEventId: def.causedByEventId,
    startMonth: def.startMonth,
    openingBalanceCents: def.openingBalanceCents,
    apr: def.apr,
    termMonths: def.termMonths,
    creditLimitCents: def.creditLimitCents,
    transfers: def.transfers,
  }));

  const properties: HouseholdProperty[] = [...state.propertiesById.values()].map((def) => ({
    id: def.id,
    ownerId: def.ownerId,
    causedByEventId: def.causedByEventId,
    startMonth: def.startMonth,
    endMonth: def.endMonth,
    openingValueCents: def.openingValueCents,
    appreciationMode: def.appreciationMode,
    mortgageLiabilityId: def.mortgageLiabilityId,
  }));

  return {
    memberships: [...state.personsById.values()].map((m) => ({
      person: m.person,
      startMonth: m.startMonth,
      endMonth: m.endMonth,
    })),
    children: [...state.childrenById.values()],
    series,
    liabilities,
    properties,
    accountTransfers: [...state.accountTransfersByAccountId.values()].flat(),
  };
}

/** The single derive-from-ledger entry point (§1). */
export function interpretLedger(ledger: Ledger, base: LedgerBaseConfig): Household {
  return toHousehold(interpretToState(ledger, base), base);
}
