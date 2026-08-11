/**
 * Event handlers — the single definition of what each event *means*.
 *
 * Each event type has one handler colocating its preconditions (`check`) and its replay
 * behavior (`apply`), so adding an event type is one new entry, not edits to two parallel
 * switches. The registry is a mapped type over the event union, so a missing handler is a
 * compile error.
 */

import type { ValidationResult } from "./ledger";
import type {
  ChildEvent,
  DebtPayoffEvent,
  HomePurchaseEvent,
  LifeEvent,
  LifeEventType,
  LoanEvent,
  OneTimeSpendEvent,
  RelationshipEvent,
  SeparationEvent,
} from "./eventTypes";
import type { InterpretContext, InterpretState, LiabilityDef, SeriesDef } from "./interpretState";
import type { AccountTransfer } from "./transfers";
import type { LiabilityKind } from "../liability/liability";
import type { Cents } from "../money/money";
import {
  asAccountId,
  asChildId,
  asLiabilityId,
  asPersonId,
  asPropertyId,
  asSeriesId,
  type LiabilityId,
  type PersonId,
} from "../plan/ids";
import { PRE_NOW_MONTH, isPreExisting } from "../projection/nowMarker";
import { explicitObligation } from "../projection/financialObligation";
import type { FundingFailure } from "../projection/fundingFailure";

export interface EventHandler<E extends LifeEvent> {
  check(event: E, state: InterpretState, context: InterpretContext): ValidationResult;
  apply(event: E, state: InterpretState, context: InterpretContext): void;
}

const ok: ValidationResult = { ok: true };
function fail(event: LifeEvent, requirement: string): ValidationResult {
  return { ok: false, reason: `${event.type} "${event.id}": ${requirement}` };
}

/**
 * A holding (loan, property, mortgage) opens at CURRENT terms, so the only pre-now date it can
 * carry is the now marker — a `-5` would ask the sim to reconstruct an origination it does not
 * model. Anchors (marriage, birth) are exempt: they carry no balance, so their true past month
 * reconstructs nothing. Returns a requirement string when the month is negative but not exactly
 * {@link PRE_NOW_MONTH}, else null. Month ≥ 0 (a transaction during the plan) always passes.
 */
function holdingMonthFault(month: number): string | null {
  return isPreExisting(month) && month !== PRE_NOW_MONTH
    ? `a holding must open at the now marker (${PRE_NOW_MONTH}), not month ${month}`
    : null;
}

/** Owner must be a known household member (present at some point). */
function ownerExists(state: InterpretState, ownerId: string): boolean {
  return state.personsById.has(asPersonId(ownerId));
}

/** Whole dollars for a conflict message — conflicts are read by a person, not the engine. */
function dollars(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

/**
 * The down-payment refusal, phrased from the classification: `funding-configuration` names the
 * eligible account(s) elsewhere that could cover it — the fix is to re-point the funding, not to
 * find more money — while `no-eligible-source-suffices` states that the combined eligible pool,
 * not just the selection, falls short. Neither branch calls it insolvency: retirement and other
 * ineligible balances are excluded on purpose, so total net worth can exceed the down payment
 * while this still refuses.
 */
function fundingFailureMessage(
  event: HomePurchaseEvent,
  failure: FundingFailure,
  labelById: ReadonlyMap<string, string>,
): string {
  const amount = `down payment of ${dollars(event.downPaymentCents)}`;
  if (failure.kind === "funding-configuration") {
    const taxNote =
      failure.selectedSourcesTaxCents > 0
        ? " (after the capital-gains tax on liquidating the selected investment sources)"
        : "";
    const alternatives = failure.alternativeSources
      .map((s) => `${labelById.get(s.accountId) ?? s.accountId} (${dollars(s.availableCents)} available)`)
      .join(", ");
    return (
      `${amount} exceeds the ${dollars(failure.selectedSourcesAvailableCents)} available from the ` +
      `selected sources${taxNote} at month ${event.month}. Other eligible accounts could cover it: ` +
      `${alternatives}. Re-point the funding to one of those or lower the amount — only the selected ` +
      `accounts fund this purchase, and nothing is moved for you.`
    );
  }
  const taxNote =
    failure.eligibleTaxCents > 0 ? " (after the capital-gains tax on liquidating them)" : "";
  return (
    `${amount} exceeds what the eligible funding sources together can cover ` +
    `(${dollars(failure.eligibleAvailableCents)} available${taxNote}) at month ${event.month}. ` +
    `Retirement accounts and other ineligible balances do not count, and credit is never a ` +
    `source, so total net worth can exceed the down payment while this still fails.`
  );
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
    // A positive annual cost spawns a linked child-cost expense: bounded to exactly 18
    // years from birth and inflation-linked. The annual amount is the source of truth —
    // the series distributes it, no pre-round.
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

/**
 * The amortizing (non-revolving) {@link LiabilityDef} both a term {@link LoanEvent} and a purchase
 * mortgage mint — one builder so the two handlers cannot drift on how a scheduled loan opens. A
 * revolving card is the one liability this does NOT build: it carries a credit limit, not a term,
 * so the card arm of `loan.apply` stays inline. `startMonth` records whatever month it is given —
 * month 0 for a plan-time origination, the now marker for a debt already carried — so a holding
 * needs no special case.
 */
function amortizingLiability(params: {
  id: LiabilityId;
  causedByEventId: string;
  ownerId: PersonId;
  startMonth: number;
  openingBalanceCents: Cents;
  apr: number;
  termMonths: number;
  kind: Exclude<LiabilityKind, "creditCard">;
}): LiabilityDef {
  return { ...params, transfers: [] };
}

/**
 * Insert a liability, refusing to silently overwrite an existing entry — the invariant a
 * liability id, once taken (authored `LoanEvent` or a purchase's derived mortgage), stays taken.
 * `check` is expected to have already refused a collision before `apply` runs; this is the
 * backstop for anything that reaches `apply` without one (a future caller, a bug in `check`
 * itself) so a collision throws loudly instead of one liability quietly replacing another.
 */
function insertLiability(
  state: InterpretState,
  id: LiabilityId,
  def: LiabilityDef,
  event: LifeEvent,
): void {
  if (state.liabilitiesById.has(id)) {
    throw new Error(
      `Interpretation invariant violated: liability "${id}" already exists, ` +
        `colliding with ${event.type} "${event.id}"`,
    );
  }
  state.liabilitiesById.set(id, def);
}

const loan: EventHandler<LoanEvent> = {
  check(event, state) {
    if (state.liabilitiesById.has(asLiabilityId(event.liabilityId))) {
      return fail(event, `liability "${event.liabilityId}" already exists`);
    }
    if (!ownerExists(state, event.ownerId)) {
      return fail(event, `owner "${event.ownerId}" not found`);
    }
    const misdated = holdingMonthFault(event.month);
    if (misdated) return fail(event, misdated);
    return ok;
  },
  apply(event, state) {
    const id = asLiabilityId(event.liabilityId);
    // The fields every kind shares; the kind-owned tail (`creditLimitCents` vs. `termMonths`)
    // rides on top. A revolving card is built inline — it carries a limit, not a term, so it is
    // the one liability `amortizingLiability` does NOT construct.
    const common = {
      id,
      causedByEventId: event.id,
      ownerId: asPersonId(event.ownerId),
      startMonth: event.month,
      openingBalanceCents: event.openingBalanceCents,
      apr: event.apr,
    };
    insertLiability(
      state,
      id,
      event.kind === "creditCard"
        ? { ...common, transfers: [], kind: event.kind, creditLimitCents: event.creditLimitCents }
        : amortizingLiability({ ...common, termMonths: event.termMonths, kind: event.kind }),
      event,
    );
  },
};

const homePurchase: EventHandler<HomePurchaseEvent> = {
  check(event, state, context) {
    if (state.propertiesById.has(asPropertyId(event.propertyId))) {
      return fail(event, `property "${event.propertyId}" already exists`);
    }
    const misdated = holdingMonthFault(event.month);
    if (misdated) return fail(event, misdated);
    if (!ownerExists(state, event.ownerId)) {
      return fail(event, `owner "${event.ownerId}" not found`);
    }
    if (event.purchasePriceCents <= 0) {
      return fail(event, `purchase price must be positive`);
    }
    // The embedded mortgage's liability id is AUTHORED (minted like any other id), so a
    // hand-edited or imported ledger can still hand it to a standalone LoanEvent that landed
    // first — same precondition `loan.check` applies to its own `liabilityId`, checked here
    // before `apply` inserts and would otherwise collide with whichever liability landed first.
    if (event.mortgage !== undefined) {
      const mortgageLiabilityId = asLiabilityId(event.mortgage.liabilityId);
      if (state.liabilitiesById.has(mortgageLiabilityId)) {
        return fail(event, `liability "${mortgageLiabilityId}" already exists`);
      }
    }
    // A holding (a home already owned at "now") opens at its current value with no acquisition:
    // it names no funding source, draws no down payment, and skips the down-payment checks below.
    // Only a purchase authored during the plan (`month ≥ 0`) funds. Everything above — owner,
    // securing-liability, and positive-value checks — applies to both.
    if (isPreExisting(event.month)) {
      return ok;
    }
    if (event.downPaymentSourceIds.length === 0) {
      return fail(event, `at least one down-payment source is required`);
    }
    for (const sourceId of event.downPaymentSourceIds) {
      if (!context.accountIds.has(asAccountId(sourceId))) {
        return fail(event, `down-payment source "${sourceId}" not found`);
      }
    }
    if (event.downPaymentCents < 0 || event.downPaymentCents > event.purchasePriceCents) {
      return fail(event, `down payment must be between 0 and the purchase price`);
    }
    // HARD BLOCK: the down payment must be coverable from the SELECTED liquid sources at the
    // purchase month, NET of the capital-gains tax liquidating them owes. `fundingAvailabilityAt`
    // runs the SAME ordered gross-up the simulator does against a projection of the ledger so far
    // — draining the selected sources in the user's order, taxing each sale marginally over the
    // owner's other income that month — so the gate blocks exactly when the sim would fall short.
    // A selected source that is not a liquid account (illiquid, or empty) contributes 0. It exists
    // only on the authoring path; absent it (ordinary replay/undo) this check is skipped — replay
    // never re-litigates an accepted purchase.
    //
    // The refusal itself is never a substitution: `fundingFailureAt` (the same eligibility seam
    // and classifier the blocked-projection warning uses, see `classifyFundingFailure`) only
    // explains WHY — naming an eligible account that could cover it when one exists — so the
    // household can re-point the funding themselves. Nothing here reorders, substitutes, or
    // liquidates on their behalf.
    const affordability = context.fundingAvailabilityAt?.(
      event.downPaymentSourceIds,
      event.downPaymentCents,
      event.month,
    );
    if (affordability !== undefined && affordability.shortfallCents > 0) {
      const failure = context.fundingFailureAt?.(
        "asset-acquisition",
        event.downPaymentSourceIds,
        event.downPaymentCents,
        event.month,
      );
      if (failure !== undefined) {
        const labelById = new Map(
          (context.fundingSourcesAt?.(event.month) ?? []).map((s) => [s.id, s.label]),
        );
        return fail(event, fundingFailureMessage(event, failure, labelById));
      }
      // No classifier available (should not happen on the authoring path, which always injects
      // one alongside `fundingAvailabilityAt`) — fall back to naming just the selected sources.
      const counted = affordability.sources
        .map((s) => `${s.label} (${dollars(s.balanceCents)})`)
        .join(", ");
      const taxNote = affordability.taxed
        ? " (after the capital-gains tax on liquidating the selected investment sources)"
        : "";
      return fail(
        event,
        `down payment of ${dollars(event.downPaymentCents)} exceeds the ${dollars(affordability.availableCents)} available from the selected sources${taxNote} at month ${event.month}. Selected sources: ${counted}. Only these accounts fund the purchase — other balances (retirement, illiquid goal funds) do not count, and credit is never a source, so total net worth can exceed the down payment while this still fails.`,
      );
    }
    return ok;
  },
  apply(event, state, context) {
    // Mortgage: a dependent artifact materialized here from the embedded terms, not a separate
    // event — but its id is AUTHORED (`event.mortgage.liabilityId`, minted by authoring), never
    // derived or minted here. `causedByEventId` is this purchase, so deleting the purchase drops
    // it and revising the purchase rebuilds it under the SAME authored id — no cross-event
    // precondition, no cascade edge. A cash purchase / owned-outright home omits `mortgage`.
    const mortgageLiabilityId =
      event.mortgage !== undefined ? asLiabilityId(event.mortgage.liabilityId) : null;
    if (event.mortgage !== undefined && mortgageLiabilityId !== null) {
      insertLiability(
        state,
        mortgageLiabilityId,
        amortizingLiability({
          id: mortgageLiabilityId,
          causedByEventId: event.id,
          ownerId: asPersonId(event.ownerId),
          startMonth: event.month,
          openingBalanceCents: event.mortgage.openingBalanceCents,
          apr: event.mortgage.apr,
          termMonths: event.mortgage.termMonths,
          kind: "mortgage",
        }),
        event,
      );
    }
    // Property: the appreciating stock. Its balance nets against the mortgage above to give
    // equity; a cash purchase leaves `mortgageLiabilityId` null.
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
      mortgageLiabilityId,
    });
    // A holding is already on the books at "now" — it was acquired off the timeline, so there is
    // no down payment to draw here; the property simply opens at its current value.
    if (isPreExisting(event.month)) {
      return;
    }
    // Down payment: an explicitly-funded asset acquisition, drained across the selected liquid
    // sources in order and resolved at simulation time (the per-source split is balance-dependent).
    // When a securing loan covers the rest of the price, property value and that loan's balance
    // cancel, leaving this draw as the only net-worth change at acquisition. `"downpayment"` is the
    // report-band namespace the simulator keys the draw's gain/tax bands off.
    state.fundingDraws.push(
      explicitObligation({
        id: `downpayment:${event.id}`,
        sourceId: "downpayment",
        // The purchase event, so a block suppresses the property and mortgage it originates below.
        sourceEventId: event.id,
        month: event.month,
        amountCents: event.downPaymentCents,
        orderedAccountIds: event.downPaymentSourceIds,
        treatment: "asset-acquisition",
      }),
    );
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

/**
 * The spend refusal, phrased from the classification — the same shape `fundingFailureMessage`
 * gives Home Purchase's down payment, but for an `"expense"`-eligible pool (credit cards
 * included) and without a fixed "down payment" phrasing.
 */
function oneTimeSpendFundingFailureMessage(
  event: OneTimeSpendEvent,
  failure: FundingFailure,
  labelById: ReadonlyMap<string, string>,
): string {
  const amount = `spend of ${dollars(event.amountCents)}`;
  if (failure.kind === "funding-configuration") {
    const taxNote =
      failure.selectedSourcesTaxCents > 0
        ? " (after the capital-gains tax on liquidating the selected investment sources)"
        : "";
    const alternatives = failure.alternativeSources
      .map((s) => `${labelById.get(s.accountId) ?? s.accountId} (${dollars(s.availableCents)} available)`)
      .join(", ");
    return (
      `${amount} exceeds the ${dollars(failure.selectedSourcesAvailableCents)} available from the ` +
      `selected sources${taxNote} at month ${event.month}. Other eligible sources could cover it: ` +
      `${alternatives}. Re-point the funding to one of those or lower the amount — only the selected ` +
      `sources fund this spend, and nothing is moved for you.`
    );
  }
  const taxNote =
    failure.eligibleTaxCents > 0 ? " (after the capital-gains tax on liquidating them)" : "";
  return (
    `${amount} exceeds what the eligible funding sources together can cover ` +
    `(${dollars(failure.eligibleAvailableCents)} available${taxNote}) at month ${event.month}.`
  );
}

/**
 * A dated, source-directed spend: names the accounts (and, eligibly, credit cards) to drain and
 * in what order. `check` validates that each named source exists, as either a liquid account or
 * a credit-card liability, then — mirroring Home Purchase's own §4.5 down-payment gate — HARD
 * BLOCKS when the selected sources cannot fully cover the spend at its month, net of any
 * capital-gains tax liquidating them owes. `fundingAvailabilityAt` runs the SAME ordered
 * gross-up the simulator does ({@link import("../projection/fundingDrawStep").resolveFundingDraws}),
 * so the gate refuses exactly when the sim would otherwise fall short — an insolvent spend can no
 * longer be authored, savable and replayable, the way it once was. Present only on the authoring
 * path; absent during ordinary replay/undo, when this check is skipped (matching Home Purchase).
 */
const oneTimeSpend: EventHandler<OneTimeSpendEvent> = {
  check(event, state, context) {
    for (const sourceId of event.fundingSourceIds) {
      const isAccount = context.accountIds.has(asAccountId(sourceId));
      const isCreditCard = state.liabilitiesById.get(asLiabilityId(sourceId))?.kind === "creditCard";
      if (!isAccount && !isCreditCard) {
        return fail(event, `funding source "${sourceId}" not found`);
      }
    }
    const affordability = context.fundingAvailabilityAt?.(
      event.fundingSourceIds,
      event.amountCents,
      event.month,
    );
    if (affordability !== undefined && affordability.shortfallCents > 0) {
      const failure = context.fundingFailureAt?.(
        "expense",
        event.fundingSourceIds,
        event.amountCents,
        event.month,
      );
      if (failure !== undefined) {
        const labelById = new Map(
          (context.fundingSourcesAt?.(event.month) ?? []).map((s) => [s.id, s.label]),
        );
        return fail(event, oneTimeSpendFundingFailureMessage(event, failure, labelById));
      }
      // No classifier available (should not happen on the authoring path) — name just the
      // selected sources, the same fallback Home Purchase's own gate falls back to.
      const counted = affordability.sources
        .map((s) => `${s.label} (${dollars(s.balanceCents)})`)
        .join(", ");
      const taxNote = affordability.taxed
        ? " (after the capital-gains tax on liquidating the selected investment sources)"
        : "";
      return fail(
        event,
        `spend of ${dollars(event.amountCents)} exceeds the ${dollars(affordability.availableCents)} available from the selected sources${taxNote} at month ${event.month}. Selected sources: ${counted}.`,
      );
    }
    return ok;
  },
  apply(event, state) {
    // The sole obligation this event produces: an explicitly-funded expense, resolved at
    // simulation time against the named sources' month-M balances (the split is
    // balance-dependent and cannot be pre-computed here). Same {@link explicitObligation}
    // abstraction the down payment uses, differentiated only by `treatment` — no dependent
    // artifact to materialize.
    state.fundingDraws.push(
      explicitObligation({
        id: event.id,
        sourceId: "onetimespend",
        sourceEventId: event.id,
        month: event.month,
        amountCents: event.amountCents,
        orderedAccountIds: event.fundingSourceIds,
        treatment: "expense",
        label: event.label,
      }),
    );
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
  OneTimeSpendEvent: oneTimeSpend,
};

/**
 * Does the registry hold a handler for this discriminant? The type-level guarantee that
 * `event.type` is a {@link LifeEventType} holds only for events this build minted — an
 * imported plan is `unknown` data wearing a `LifeEvent` type, and a hand-edited or
 * version-skewed one may carry a discriminant no handler answers to. A caller replaying
 * foreign events asks here first, so the miss is a rejection it can phrase rather than the
 * `TypeError` {@link handlerFor} would raise on an `undefined` handler.
 *
 * Own properties only, so a prototype name (`"toString"`, `"constructor"`) is not mistaken
 * for a registered event type.
 */
export function isKnownEventType(type: unknown): type is LifeEventType {
  return typeof type === "string" && Object.hasOwn(handlers, type);
}

/**
 * Dispatch to the handler for `event.type`. The cast bridges TypeScript's inability to
 * correlate the mapped-type lookup with the specific union member; sound because the
 * registry is keyed by that exact type.
 *
 * Assumes a registered discriminant — true of every event this build mints. Replaying events
 * from outside (an imported plan) gates on {@link isKnownEventType} first.
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
