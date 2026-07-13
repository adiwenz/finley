/**
 * Event handlers — the single definition of what each event *means*.
 *
 * Each event type has one handler colocating its preconditions (`check`) and
 * its replay behavior (`apply`), so adding a new event type is one new entry,
 * not edits to two parallel switches (§14). The registry is a mapped type over
 * the event union, so a missing handler is a compile error — exhaustiveness is
 * enforced by the type system, with no `any` and no loosely-typed lookups.
 */

import type { ValidationResult } from "./ledger";
import type {
  BudgetItemEndEvent,
  BudgetItemStartEvent,
  ChildEvent,
  DebtPayoffEvent,
  JobChangeEvent,
  LifeEvent,
  LifeEventType,
  LoanEvent,
  RelationshipEvent,
  SeparationEvent,
} from "./eventTypes";
import type {
  AccountTransfer,
  ReplayContext,
  ReplayState,
  SeriesDef,
} from "./replayState";
import {
  asAccountId,
  asChildId,
  asLiabilityId,
  asPersonId,
  asSeriesId,
} from "../ids";

export interface EventHandler<E extends LifeEvent> {
  check(event: E, state: ReplayState, context: ReplayContext): ValidationResult;
  apply(event: E, state: ReplayState, context: ReplayContext): void;
}

const ok: ValidationResult = { ok: true };
function fail(event: LifeEvent, requirement: string): ValidationResult {
  return { ok: false, reason: `${event.type} "${event.id}": ${requirement}` };
}

/** Owner must be a known household member (present at some point). */
function ownerExists(state: ReplayState, ownerId: string): boolean {
  return state.personsById.has(asPersonId(ownerId));
}

const relationship: EventHandler<RelationshipEvent> = {
  check(event, state) {
    if (state.personsById.has(asPersonId(event.person.id))) {
      return fail(event, `person "${event.person.id}" already exists`);
    }
    return ok;
  },
  apply(event, state) {
    state.personsById.set(asPersonId(event.person.id), {
      person: event.person,
      startMonth: event.month,
      endMonth: null,
    });
  },
};

const child: EventHandler<ChildEvent> = {
  check(event, state) {
    if (state.childrenById.has(asChildId(event.childId))) {
      return fail(event, `child "${event.childId}" already exists`);
    }
    return ok;
  },
  apply(event, state) {
    state.childrenById.set(asChildId(event.childId), {
      id: event.childId,
      name: event.childName,
      birthMonth: event.birthMonth,
      causedByEventId: event.id,
    });
  },
};

const separation: EventHandler<SeparationEvent> = {
  check(event, state) {
    const membership = state.personsById.get(asPersonId(event.partnerPersonId));
    if (!membership) {
      return fail(event, `person "${event.partnerPersonId}" not found; cannot separate`);
    }
    if (event.month < membership.startMonth) {
      return fail(
        event,
        `cannot separate at month ${event.month}, before partnering at month ${membership.startMonth}`,
      );
    }
    if (membership.endMonth !== null) {
      return fail(event, `person "${event.partnerPersonId}" is already separated`);
    }
    return ok;
  },
  apply(event, state) {
    const membership = state.personsById.get(asPersonId(event.partnerPersonId));
    if (membership) membership.endMonth = event.month;

    // End all income series owned by the departing partner from this month.
    for (const s of state.seriesById.values()) {
      if (s.ownerId === event.partnerPersonId && s.seriesType === "income" && s.endMonth === null) {
        s.endMonth = event.month - 1;
      }
    }
    // Alimony: fixed-dollar expense for its duration.
    if (event.alimonyMonthlyCents > 0 && event.alimonyDurationMonths > 0) {
      addSeries(state, {
        id: asSeriesId(`${event.id}:alimony`),
        causedByEventId: event.id,
        role: "alimony",
        ownerId: asPersonId(event.partnerPersonId),
        seriesType: "expense",
        startMonth: event.month,
        endMonth: event.month + event.alimonyDurationMonths - 1,
        baseline: { unit: "monthly", monthlyCents: event.alimonyMonthlyCents },
        growthMode: { type: "fixed" },
      });
    }
    // Child support: fixed-dollar expense from this month indefinitely.
    if (event.childSupportMonthlyCents > 0) {
      addSeries(state, {
        id: asSeriesId(`${event.id}:childSupport`),
        causedByEventId: event.id,
        role: "childSupport",
        ownerId: asPersonId(event.partnerPersonId),
        seriesType: "expense",
        startMonth: event.month,
        endMonth: null,
        baseline: { unit: "monthly", monthlyCents: event.childSupportMonthlyCents },
        growthMode: { type: "fixed" },
      });
    }
  },
};

const loan: EventHandler<LoanEvent> = {
  check(event, state) {
    if (state.liabilitiesById.has(asLiabilityId(event.liabilityId))) {
      return fail(event, `liability "${event.liabilityId}" already exists`);
    }
    if (!ownerExists(state, event.ownerId)) {
      return fail(event, `owner "${event.ownerId}" not found`);
    }
    return ok;
  },
  apply(event, state) {
    state.liabilitiesById.set(asLiabilityId(event.liabilityId), {
      id: asLiabilityId(event.liabilityId),
      causedByEventId: event.id,
      ownerId: asPersonId(event.ownerId),
      startMonth: event.month,
      kind: event.kind,
      openingBalanceCents: event.openingBalanceCents,
      apr: event.apr,
      termMonths: event.termMonths,
      creditLimitCents: event.creditLimitCents,
      transfers: [],
    });
  },
};

const debtPayoff: EventHandler<DebtPayoffEvent> = {
  check(event, state, context) {
    if (!state.liabilitiesById.has(asLiabilityId(event.liabilityId))) {
      return fail(event, `liability "${event.liabilityId}" not found for payoff`);
    }
    if (!context.accountIds.has(asAccountId(event.accountId))) {
      return fail(event, `account "${event.accountId}" not found for payoff`);
    }
    return ok;
  },
  apply(event, state) {
    const liab = state.liabilitiesById.get(asLiabilityId(event.liabilityId));
    if (liab) {
      liab.transfers.push({
        month: event.month,
        amountCents: -event.amountCents, // negative = reduces balance
        accountId: asAccountId(event.accountId),
      });
    }
    pushAccountTransfer(state, {
      accountId: asAccountId(event.accountId),
      month: event.month,
      amountCents: -event.amountCents, // negative = outflow
    });
  },
};

const jobChange: EventHandler<JobChangeEvent> = {
  check(event, state) {
    if (state.seriesById.has(asSeriesId(event.seriesId))) {
      return fail(event, `series "${event.seriesId}" already exists`);
    }
    if (!ownerExists(state, event.ownerId)) {
      return fail(event, `owner "${event.ownerId}" not found`);
    }
    if (event.replacesSeriesId != null) {
      const prev = state.seriesById.get(asSeriesId(event.replacesSeriesId));
      if (!prev) {
        return fail(event, `replaced series "${event.replacesSeriesId}" not found`);
      }
      if (prev.endMonth !== null) {
        return fail(event, `replaced series "${event.replacesSeriesId}" is not active`);
      }
    }
    return ok;
  },
  apply(event, state) {
    if (event.replacesSeriesId != null) {
      const prev = state.seriesById.get(asSeriesId(event.replacesSeriesId));
      if (prev && prev.endMonth === null) prev.endMonth = event.month - 1;
    }
    addSeries(state, {
      id: asSeriesId(event.seriesId),
      causedByEventId: event.id,
      role: "primaryIncome",
      ownerId: asPersonId(event.ownerId),
      seriesType: "income",
      startMonth: event.month,
      endMonth: null,
      // Annual is the source of truth — the series distributes it (no pre-round, §4).
      baseline: { unit: "annual", annualCents: event.annualIncomeCents },
      growthMode: event.growthMode,
      taxCategory: event.taxCategory,
    });
  },
};

const budgetItemStart: EventHandler<BudgetItemStartEvent> = {
  check(event, state) {
    if (state.seriesById.has(asSeriesId(event.seriesId))) {
      return fail(event, `series "${event.seriesId}" already exists`);
    }
    if (!ownerExists(state, event.ownerId)) {
      return fail(event, `owner "${event.ownerId}" not found`);
    }
    return ok;
  },
  apply(event, state) {
    addSeries(state, {
      id: asSeriesId(event.seriesId),
      causedByEventId: event.id,
      role: "budgetItem",
      ownerId: asPersonId(event.ownerId),
      seriesType: event.seriesType,
      startMonth: event.month,
      endMonth: null,
      baseline: { unit: "monthly", monthlyCents: event.monthlyCents },
      growthMode: event.growthMode,
      taxCategory: event.taxCategory,
    });
  },
};

const budgetItemEnd: EventHandler<BudgetItemEndEvent> = {
  check(event, state) {
    const s = state.seriesById.get(asSeriesId(event.seriesId));
    if (!s) return fail(event, `series "${event.seriesId}" not found; cannot end it`);
    if (s.endMonth !== null) {
      return fail(event, `series "${event.seriesId}" is already ended`);
    }
    return ok;
  },
  apply(event, state) {
    const s = state.seriesById.get(asSeriesId(event.seriesId));
    if (s && s.endMonth === null) s.endMonth = event.month - 1;
  },
};

function addSeries(state: ReplayState, def: SeriesDef): void {
  state.seriesById.set(def.id, def);
}

function pushAccountTransfer(state: ReplayState, transfer: AccountTransfer): void {
  const list = state.accountTransfersByAccountId.get(transfer.accountId);
  if (list) list.push(transfer);
  else state.accountTransfersByAccountId.set(transfer.accountId, [transfer]);
}

type HandlerRegistry = {
  [T in LifeEventType]: EventHandler<Extract<LifeEvent, { type: T }>>;
};

const handlers: HandlerRegistry = {
  RelationshipEvent: relationship,
  ChildEvent: child,
  SeparationEvent: separation,
  LoanEvent: loan,
  DebtPayoffEvent: debtPayoff,
  JobChangeEvent: jobChange,
  BudgetItemStartEvent: budgetItemStart,
  BudgetItemEndEvent: budgetItemEnd,
};

/**
 * Dispatch to the handler for `event.type`. The one localized cast bridges
 * TypeScript's inability to correlate the mapped-type lookup with the specific
 * union member; it is sound because the registry is keyed by that exact type.
 */
function handlerFor(event: LifeEvent): EventHandler<LifeEvent> {
  return handlers[event.type] as EventHandler<LifeEvent>;
}

/** Preconditions for `event` against the state accumulated so far. */
export function checkEvent(
  event: LifeEvent,
  state: ReplayState,
  context: ReplayContext,
): ValidationResult {
  return handlerFor(event).check(event, state, context);
}

/** Fold `event` into the replay state (mutating). */
export function applyEvent(
  event: LifeEvent,
  state: ReplayState,
  context: ReplayContext,
): void {
  handlerFor(event).apply(event, state, context);
}
