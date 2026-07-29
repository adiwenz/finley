/**
 * Interpret — the one place event meaning becomes household state.
 *
 * `interpretLedger` folds the ledger over the handler registry into an immutable
 * {@link Household}. Projection and snapshot both consume *that* object, so they can never
 * interpret the ledger differently. Base (value-editing surface) series fold in here too, so
 * they appear identically in both.
 */

import type { Ledger } from "./ledger";
import type { LifeEvent, SeriesRole } from "./eventTypes";
import { applyEvent } from "./eventHandlers";
import { asPersonId, asSeriesId, type AccountId, type SeriesId } from "../ids";
import { SimCashFlowSeries } from "../cashFlowSeries";
import type { SimOwnedSeries } from "../projection/simulate";
import { compilePersonIncomeSeries } from "../compilePerson";
import {
  freshState,
  type InterpretContext,
  type InterpretState,
  type PersonMembership,
  type SeriesDef,
} from "./interpretState";
import type { LedgerBaseConfig } from "./ledgerBase";
import type {
  Household,
  HouseholdLiability,
  HouseholdProperty,
  HouseholdSeries,
} from "./household";

function materializeSeries(def: SeriesDef): SimCashFlowSeries {
  const initialBaseCents =
    def.baseline.unit === "annual" ? def.baseline.annualCents : def.baseline.monthlyCents;
  return new SimCashFlowSeries(def.startMonth, initialBaseCents, def.growthMode, {
    baselineUnit: def.baseline.unit,
    endMonth: def.endMonth ?? undefined,
    taxCategory: def.taxCategory,
  });
}

/** Interpretation order: (month ASC, sequenceNumber ASC) — producer-before-consumer. */
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

/** Wrap a pre-built {@link SimOwnedSeries} as a value-plane (`base` role) household series. */
function ownedSeries(os: SimOwnedSeries, id: SeriesId, seriesType: "income" | "expense"): HouseholdSeries {
  return {
    id,
    ownerId: asPersonId(os.ownerId),
    seriesType,
    role: "base",
    causedByEventId: null,
    startMonth: os.series.startMonth,
    endMonth: os.series.endMonth ?? null,
    series: os.series,
    label: os.label,
    planDescriptor: os.planDescriptor,
    ...(os.sourceId !== undefined ? { sourceId: os.sourceId } : {}),
    ...(os.lineId !== undefined ? { lineId: os.lineId } : {}),
    ...(os.spendingSource !== undefined ? { spendingSource: os.spendingSource } : {}),
  };
}

/**
 * An event-created expense series has no authored label, and its {@link SeriesRole} is the
 * only human fact available to name it by.
 */
const ROLE_LABEL: Record<SeriesRole, string> = {
  base: "Expense",
  primaryIncome: "Income",
  alimony: "Alimony",
  childSupport: "Child support",
  childCost: "Child cost",
};

function baseSeries(os: SimOwnedSeries, seriesType: "income" | "expense", index: number): HouseholdSeries {
  return ownedSeries(os, asSeriesId(`base-${seriesType}-${index}`), seriesType);
}

/**
 * A partner's own jobs compiled into forward income series, clipped to the membership window
 * (join → separation). The primary earner's jobs are already in `base.initialIncomeSeries`; a
 * partner joins via a RelationshipEvent, so their jobs live on the membership and compile
 * here into `household.series`. Derived from the membership, so removing the
 * RelationshipEvent drops the income with it: hence `causedByEventId: null`, recomputed each
 * interpretation like the base series.
 */
function partnerJobSeries(
  membership: PersonMembership,
  nowYear: number,
  inflationRate: number,
): HouseholdSeries[] {
  const compiled = compilePersonIncomeSeries(membership.person, nowYear, inflationRate, {
    startMonth: membership.startMonth,
    endMonthExclusive: membership.endMonth ?? Number.POSITIVE_INFINITY,
  });
  return compiled.map((os, i) =>
    ownedSeries(os, asSeriesId(`partner-${membership.person.id}-income-${i}`), "income"),
  );
}

function toHousehold(state: InterpretState, base: LedgerBaseConfig): Household {
  const nowYear = base.startYear ?? 0;
  const series: HouseholdSeries[] = [
    ...(base.initialIncomeSeries ?? []).map((os, i) => baseSeries(os, "income", i)),
    ...(base.initialExpenseSeries ?? []).map((os, i) => baseSeries(os, "expense", i)),
    // Event-added members only — the base primary joins at `-Infinity` and is already in
    // `base.initialIncomeSeries` — so a partner's jobs never double-count.
    ...[...state.personsById.values()]
      .filter((m) => Number.isFinite(m.startMonth))
      .flatMap((m) => partnerJobSeries(m, nowYear, base.annualInflationRate)),
    ...[...state.seriesById.values()].map((def): HouseholdSeries => {
      const common = {
        id: def.id,
        ownerId: def.ownerId,
        seriesType: def.seriesType,
        role: def.role,
        causedByEventId: def.causedByEventId,
        startMonth: def.startMonth,
        endMonth: def.endMonth,
        series: materializeSeries(def),
      };
      // An event's expense reports as ordinary spending, tagged back to the event that
      // authored it — edited through that event, never as a budget line.
      return def.seriesType === "income"
        ? common
        : {
            ...common,
            label: ROLE_LABEL[def.role],
            spendingSource: {
              kind: "event",
              id: def.id,
              category: "other",
              editable: false,
            },
          };
    }),
  ];

  const liabilities: HouseholdLiability[] = [...state.liabilitiesById.values()].map(
    (def): HouseholdLiability => {
      const common = {
        id: def.id,
        ownerId: def.ownerId,
        causedByEventId: def.causedByEventId,
        startMonth: def.startMonth,
        openingBalanceCents: def.openingBalanceCents,
        apr: def.apr,
        transfers: def.transfers,
      };
      // Preserve the discriminant end to end: each arm carries exactly its own field.
      return def.kind === "creditCard"
        ? { ...common, kind: def.kind, creditLimitCents: def.creditLimitCents }
        : { ...common, kind: def.kind, termMonths: def.termMonths };
    },
  );

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
    // No authoring-account source flows through the ledger yet; accounts still enter the
    // simulation as compiled `SimAccount`s on the base. The field folds the former account
    // aggregate into this one household so ownership reads off a single object.
    accounts: [],
    accountTransfers: [...state.accountTransfersByAccountId.values()].flat(),
    fundingDraws: [...state.fundingDraws],
  };
}

export function interpretLedger(ledger: Ledger, base: LedgerBaseConfig): Household {
  return toHousehold(interpretToState(ledger, base), base);
}
