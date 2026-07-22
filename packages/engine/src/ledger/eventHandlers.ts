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
  HomePurchaseEvent,
  JobChangeEvent,
  LifeEvent,
  LifeEventType,
  LoanEvent,
  RelationshipEvent,
  SeparationEvent,
} from "./eventTypes";
import type { InterpretContext, InterpretState, SeriesDef } from "./interpretState";
import type { AccountTransfer } from "./transfers";
import {
  asAccountId,
  asChildId,
  asLiabilityId,
  asPersonId,
  asPropertyId,
  asSeriesId,
} from "../ids";

export interface EventHandler<E extends LifeEvent> {
  check(event: E, state: InterpretState, context: InterpretContext): ValidationResult;
  apply(event: E, state: InterpretState, context: InterpretContext): void;
}

const ok: ValidationResult = { ok: true };
function fail(event: LifeEvent, requirement: string): ValidationResult {
  return { ok: false, reason: `${event.type} "${event.id}": ${requirement}` };
}

/**
 * Whole dollars for a conflict message. Conflicts are read by a person, so they
 * quote dollars, not the raw cents the engine counts in.
 */
function dollars(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

/** Owner must be a known household member (present at some point). */
function ownerExists(state: InterpretState, ownerId: string): boolean {
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
  apply(event, state, context) {
    state.childrenById.set(asChildId(event.childId), {
      id: event.childId,
      name: event.childName,
      birthMonth: event.birthMonth,
      causedByEventId: event.id,
    });
    // A positive annual cost spawns a linked child-cost expense: bounded to
    // exactly 18 years from birth (mirroring alimony's bounded shape) and
    // inflation-linked so it stays real across that span (§4.1). The annual
    // amount is the source of truth — the series distributes it (no pre-round, §4).
    if (event.annualCostCents > 0) {
      const CHILD_COST_YEARS = 18;
      addSeries(state, {
        id: asSeriesId(`${event.id}:childCost`),
        causedByEventId: event.id,
        role: "childCost",
        ownerId: asPersonId(event.childId),
        seriesType: "expense",
        startMonth: event.birthMonth,
        endMonth: event.birthMonth + CHILD_COST_YEARS * 12 - 1,
        baseline: { unit: "annual", annualCents: event.annualCostCents },
        growthMode: { type: "inflationLinked", annualRate: context.annualInflationRate },
      });
    }
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
    const common = {
      id: asLiabilityId(event.liabilityId),
      causedByEventId: event.id,
      ownerId: asPersonId(event.ownerId),
      startMonth: event.month,
      openingBalanceCents: event.openingBalanceCents,
      apr: event.apr,
      transfers: [],
    };
    // LoanEvent is discriminated on kind; carry exactly the field that kind owns
    // into the derived LiabilityDef (also a discriminated union).
    state.liabilitiesById.set(
      asLiabilityId(event.liabilityId),
      event.kind === "creditCard"
        ? { ...common, kind: event.kind, creditLimitCents: event.creditLimitCents }
        : { ...common, kind: event.kind, termMonths: event.termMonths },
    );
  },
};

const homePurchase: EventHandler<HomePurchaseEvent> = {
  check(event, state, context) {
    if (state.propertiesById.has(asPropertyId(event.propertyId))) {
      return fail(event, `property "${event.propertyId}" already exists`);
    }
    if (state.liabilitiesById.has(asLiabilityId(event.mortgageLiabilityId))) {
      return fail(event, `mortgage "${event.mortgageLiabilityId}" already exists`);
    }
    if (!ownerExists(state, event.ownerId)) {
      return fail(event, `owner "${event.ownerId}" not found`);
    }
    if (!context.accountIds.has(asAccountId(event.downPaymentAccountId))) {
      return fail(event, `down-payment account "${event.downPaymentAccountId}" not found`);
    }
    if (event.purchasePriceCents <= 0) {
      return fail(event, `purchase price must be positive`);
    }
    if (event.downPaymentCents < 0 || event.downPaymentCents > event.purchasePriceCents) {
      return fail(event, `down payment must be between 0 and the purchase price`);
    }
    // §4.5 HARD BLOCK: the down payment must be coverable from liquid, sourced
    // funds at the purchase month. `liquidBalanceAt` (present only on the authoring
    // path) never counts credit, so the §5.1 shortfall cascade can never fund a
    // down payment. Absent a projection (ordinary replay/undo) this check is skipped.
    const liquid = context.liquidBalanceAt?.(event.month);
    if (liquid !== undefined && liquid < event.downPaymentCents) {
      return fail(
        event,
        `down payment of ${dollars(event.downPaymentCents)} exceeds the ${dollars(liquid)} of liquid funds available at month ${event.month}. Only liquid accounts count toward a down payment — goal funds, retirement and brokerage balances do not, so total net worth can be well above the down payment while this still fails. Credit is never a valid source (§4.5).`,
      );
    }
    return ok;
  },
  apply(event, state, context) {
    // Property: the appreciating stock. Default appreciation is inflation-linked
    // at the base inflation rate (§4.1), user-overridable via appreciationMode.
    state.propertiesById.set(asPropertyId(event.propertyId), {
      id: asPropertyId(event.propertyId),
      causedByEventId: event.id,
      ownerId: asPersonId(event.ownerId),
      startMonth: event.month,
      endMonth: null,
      openingValueCents: event.purchasePriceCents,
      appreciationMode:
        event.appreciationMode ??
        { type: "inflationLinked", annualRate: context.annualInflationRate },
      mortgageLiabilityId: asLiabilityId(event.mortgageLiabilityId),
    });
    // Mortgage: financed amount = price − down payment. Reuses the liability
    // machinery — amortizes from its origination month like any other loan.
    state.liabilitiesById.set(asLiabilityId(event.mortgageLiabilityId), {
      id: asLiabilityId(event.mortgageLiabilityId),
      causedByEventId: event.id,
      ownerId: asPersonId(event.ownerId),
      startMonth: event.month,
      kind: "mortgage",
      openingBalanceCents: event.purchasePriceCents - event.downPaymentCents,
      apr: event.mortgageApr,
      termMonths: event.mortgageTermMonths,
      transfers: [],
    });
    // Down payment: the paired liquid-account outflow (§3.2). Property value +
    // mortgage together equal the price, so this outflow is the only net-worth
    // change at purchase — the purchase itself conserves net worth.
    pushAccountTransfer(state, {
      accountId: asAccountId(event.downPaymentAccountId),
      month: event.month,
      amountCents: -event.downPaymentCents,
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

function addSeries(state: InterpretState, def: SeriesDef): void {
  state.seriesById.set(def.id, def);
}

function pushAccountTransfer(state: InterpretState, transfer: AccountTransfer): void {
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
  HomePurchaseEvent: homePurchase,
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
  state: InterpretState,
  context: InterpretContext,
): ValidationResult {
  return handlerFor(event).check(event, state, context);
}

/** Fold `event` into the replay state (mutating). */
export function applyEvent(
  event: LifeEvent,
  state: InterpretState,
  context: InterpretContext,
): void {
  handlerFor(event).apply(event, state, context);
}
