/**
 * Event ledger — the event-sourcing spine (§0.3, §6).
 *
 * The ledger is the source of truth. A projection is a derived view obtained
 * by replaying all events in (month, sequenceNumber) order. No event is ever
 * mutated; undo is "remove a record then replay."
 *
 * Durable entities (Person, Child) survive separation and undo. Dependent
 * artifacts (income/expense series, liabilities) carry a `sourceEventId` and
 * `role` so they can be targeted by undo Strategy B (§6.2).
 */

import type { Cents } from "./money";
import type { Jurisdiction } from "./jurisdiction";
import type { GrowthMode, TaxCategory } from "./cashFlowSeries";
import { CashFlowSeries } from "./cashFlowSeries";
import { Account } from "./account";
import { Liability, type LiabilityKind } from "./liability";
import type { Person, OwnedSeries, HouseholdSimInput } from "./projection";
import { simulateHousehold } from "./projection";
import type { ProjectionSeries } from "./projection";

// ─── Durable entity ──────────────────────────────────────────────────────────

export interface Child {
  readonly id: string;
  readonly name: string;
  /** Absolute simulation month of birth (may be ≤ 0 for pre-sim births). */
  readonly birthMonth: number;
  readonly sourceEventId: string;
}

// ─── Event base ──────────────────────────────────────────────────────────────

interface EventBase {
  readonly id: string;
  /** Monotonically assigned at append-time; breaks ties within the same month. */
  readonly sequenceNumber: number;
  readonly month: number;
  readonly sourceEventId?: string;
  readonly role?: string;
}

// ─── Event types ─────────────────────────────────────────────────────────────

/** Adds a new person (partner/spouse) to the household. */
export interface RelationshipEvent extends EventBase {
  readonly type: "RelationshipEvent";
  readonly person: Person;
}

/** Records a child. Affects expenses only if explicit expense events follow. */
export interface ChildEvent extends EventBase {
  readonly type: "ChildEvent";
  readonly childId: string;
  readonly childName: string;
  readonly birthMonth: number;
}

/**
 * Records a separation: ends all income series owned by the departing partner,
 * and optionally creates alimony (fixed-dollar expense) and child support
 * (fixed-dollar expense) streams tagged with this event's id.
 * Never touches child-owned expenses, mortgages, or other liabilities (§4.3).
 */
export interface SeparationEvent extends EventBase {
  readonly type: "SeparationEvent";
  /** Person ID of the departing partner — their income streams are ended. */
  readonly partnerPersonId: string;
  /** Monthly alimony expense paid by this household, 0 if none (cents). */
  readonly alimonyMonthlyCents: Cents;
  /** Duration of alimony in months from this event. 0 if no alimony. */
  readonly alimonyDurationMonths: number;
  /** Monthly child support expense paid, 0 if none (cents). */
  readonly childSupportMonthlyCents: Cents;
}

/** Creates a new liability (mortgage, auto, student loan, or credit card). */
export interface LoanEvent extends EventBase {
  readonly type: "LoanEvent";
  readonly liabilityId: string;
  readonly ownerId: string;
  readonly kind: LiabilityKind;
  readonly openingBalanceCents: Cents;
  readonly apr: number;
  readonly termMonths?: number;
  readonly creditLimitCents?: Cents;
}

/**
 * Applies a lump-sum principal paydown on a liability. Paired with an Account
 * outflow (same amount, same month) to conserve net worth (§3.2). The engine
 * records both halves; callers must supply both transfers.
 */
export interface DebtPayoffEvent extends EventBase {
  readonly type: "DebtPayoffEvent";
  readonly liabilityId: string;
  readonly accountId: string;
  readonly amountCents: Cents;
}

/**
 * Starts (or changes) a person's primary income. Creates a new income
 * CashFlowSeries from `month` forward. If `replacesSeriesId` is given, the
 * existing series is ended at month−1.
 */
export interface JobChangeEvent extends EventBase {
  readonly type: "JobChangeEvent";
  readonly seriesId: string;
  readonly ownerId: string;
  readonly annualIncomeCents: Cents;
  readonly growthMode: GrowthMode;
  readonly taxCategory: TaxCategory;
  /** Series to end at month−1 when this job starts. */
  readonly replacesSeriesId?: string;
}

/** Creates a recurring income or expense series from `month` forward. */
export interface BudgetItemStartEvent extends EventBase {
  readonly type: "BudgetItemStartEvent";
  readonly seriesId: string;
  readonly ownerId: string;
  readonly seriesType: "income" | "expense";
  readonly monthlyCents: Cents;
  readonly growthMode: GrowthMode;
  readonly taxCategory?: TaxCategory;
}

/** Ends a recurring income or expense series at month−1. */
export interface BudgetItemEndEvent extends EventBase {
  readonly type: "BudgetItemEndEvent";
  /** `seriesId` of the BudgetItemStartEvent or JobChangeEvent to end. */
  readonly seriesId: string;
}

export type LifeEvent =
  | RelationshipEvent
  | ChildEvent
  | SeparationEvent
  | LoanEvent
  | DebtPayoffEvent
  | JobChangeEvent
  | BudgetItemStartEvent
  | BudgetItemEndEvent;

// ─── Ledger ──────────────────────────────────────────────────────────────────

export interface Ledger {
  readonly events: readonly LifeEvent[];
  /** Next sequence number — always equals events.length for a well-formed ledger. */
  readonly nextSeq: number;
}

export const emptyLedger: Ledger = { events: [], nextSeq: 0 };

/** Distributive Omit: distributes over union members so the discriminant is preserved. */
type DistributiveOmit<T, K extends keyof T> = T extends T ? Omit<T, K> : never;

/** Append an event; assigns the next sequence number. */
export function appendEvent(
  ledger: Ledger,
  partial: DistributiveOmit<LifeEvent, "sequenceNumber">,
): Ledger {
  const event = { ...partial, sequenceNumber: ledger.nextSeq } as LifeEvent;
  return { events: [...ledger.events, event], nextSeq: ledger.nextSeq + 1 };
}

// ─── Precondition checks ─────────────────────────────────────────────────────

type CheckResult = { ok: true } | { ok: false; reason: string };

function checkPreconditions(event: LifeEvent, state: ReplayState): CheckResult {
  switch (event.type) {
    case "RelationshipEvent": {
      if (state.persons.some((p) => p.id === event.person.id)) {
        return { ok: false, reason: `Person "${event.person.id}" already exists` };
      }
      return { ok: true };
    }
    case "ChildEvent": {
      if (state.children.some((c) => c.id === event.childId)) {
        return { ok: false, reason: `Child "${event.childId}" already exists` };
      }
      return { ok: true };
    }
    case "SeparationEvent": {
      if (!state.persons.some((p) => p.id === event.partnerPersonId)) {
        return {
          ok: false,
          reason: `Person "${event.partnerPersonId}" not found; cannot separate`,
        };
      }
      return { ok: true };
    }
    case "LoanEvent": {
      if (state.liabilityDefs.some((l) => l.id === event.liabilityId)) {
        return {
          ok: false,
          reason: `Liability "${event.liabilityId}" already exists`,
        };
      }
      return { ok: true };
    }
    case "DebtPayoffEvent": {
      if (!state.liabilityDefs.some((l) => l.id === event.liabilityId)) {
        return {
          ok: false,
          reason: `Liability "${event.liabilityId}" not found for payoff`,
        };
      }
      return { ok: true };
    }
    case "JobChangeEvent":
    case "BudgetItemStartEvent":
      return { ok: true };
    case "BudgetItemEndEvent": {
      if (!state.seriesDefs.some((s) => s.id === event.seriesId)) {
        return {
          ok: false,
          reason: `Series "${event.seriesId}" not found; cannot end it`,
        };
      }
      return { ok: true };
    }
  }
}

// ─── Internal replay state ────────────────────────────────────────────────────

interface SeriesDef {
  id: string;
  sourceEventId: string;
  role: string;
  ownerId: string;
  seriesType: "income" | "expense";
  startMonth: number;
  endMonth?: number;
  // Monthly-native (no annual splitting needed in these descriptors):
  monthlyCents: Cents;
  growthMode: GrowthMode;
  taxCategory?: TaxCategory;
}

interface LiabilityDef {
  id: string;
  sourceEventId: string;
  ownerId: string;
  kind: LiabilityKind;
  openingBalanceCents: Cents;
  apr: number;
  termMonths?: number;
  creditLimitCents?: Cents;
  // Transfer: [month, amountCents (negative = paydown)]
  transfers: Array<{ month: number; amountCents: Cents; accountId: string }>;
}

interface ReplayState {
  persons: Person[];
  children: Child[];
  seriesDefs: SeriesDef[];
  liabilityDefs: LiabilityDef[];
  /** Account-level one-time outflows from debt payoff events. */
  accountOutflows: Array<{ accountId: string; month: number; amountCents: Cents }>;
}

function freshState(): ReplayState {
  return { persons: [], children: [], seriesDefs: [], liabilityDefs: [], accountOutflows: [] };
}

function applyEvent(event: LifeEvent, state: ReplayState): void {
  switch (event.type) {
    case "RelationshipEvent": {
      state.persons.push(event.person);
      break;
    }

    case "ChildEvent": {
      state.children.push({
        id: event.childId,
        name: event.childName,
        birthMonth: event.birthMonth,
        sourceEventId: event.id,
      });
      break;
    }

    case "SeparationEvent": {
      // End all income series owned by the departing partner from this month.
      for (const s of state.seriesDefs) {
        if (s.ownerId === event.partnerPersonId && s.seriesType === "income" && s.endMonth == null) {
          s.endMonth = event.month - 1;
        }
      }
      // Alimony: fixed-dollar expense from this month forward.
      if (event.alimonyMonthlyCents > 0 && event.alimonyDurationMonths > 0) {
        state.seriesDefs.push({
          id: `${event.id}:alimony`,
          sourceEventId: event.id,
          role: "alimony",
          ownerId: event.partnerPersonId,
          seriesType: "expense",
          startMonth: event.month,
          endMonth: event.month + event.alimonyDurationMonths - 1,
          monthlyCents: event.alimonyMonthlyCents,
          growthMode: { type: "fixed" },
        });
      }
      // Child support: fixed-dollar expense from this month indefinitely.
      if (event.childSupportMonthlyCents > 0) {
        state.seriesDefs.push({
          id: `${event.id}:childSupport`,
          sourceEventId: event.id,
          role: "childSupport",
          ownerId: event.partnerPersonId,
          seriesType: "expense",
          startMonth: event.month,
          monthlyCents: event.childSupportMonthlyCents,
          growthMode: { type: "fixed" },
        });
      }
      break;
    }

    case "LoanEvent": {
      state.liabilityDefs.push({
        id: event.liabilityId,
        sourceEventId: event.id,
        ownerId: event.ownerId,
        kind: event.kind,
        openingBalanceCents: event.openingBalanceCents,
        apr: event.apr,
        termMonths: event.termMonths,
        creditLimitCents: event.creditLimitCents,
        transfers: [],
      });
      break;
    }

    case "DebtPayoffEvent": {
      const liab = state.liabilityDefs.find((l) => l.id === event.liabilityId);
      if (liab) {
        liab.transfers.push({
          month: event.month,
          amountCents: -event.amountCents, // negative = reduces balance
          accountId: event.accountId,
        });
      }
      state.accountOutflows.push({
        accountId: event.accountId,
        month: event.month,
        amountCents: -event.amountCents, // negative = outflow
      });
      break;
    }

    case "JobChangeEvent": {
      if (event.replacesSeriesId != null) {
        const prev = state.seriesDefs.find((s) => s.id === event.replacesSeriesId);
        if (prev && prev.endMonth == null) {
          prev.endMonth = event.month - 1;
        }
      }
      state.seriesDefs.push({
        id: event.seriesId,
        sourceEventId: event.id,
        role: "primaryIncome",
        ownerId: event.ownerId,
        seriesType: "income",
        startMonth: event.month,
        monthlyCents: Math.round(event.annualIncomeCents / 12),
        growthMode: event.growthMode,
        taxCategory: event.taxCategory,
      });
      break;
    }

    case "BudgetItemStartEvent": {
      state.seriesDefs.push({
        id: event.seriesId,
        sourceEventId: event.id,
        role: "budgetItem",
        ownerId: event.ownerId,
        seriesType: event.seriesType,
        startMonth: event.month,
        monthlyCents: event.monthlyCents,
        growthMode: event.growthMode,
        taxCategory: event.taxCategory,
      });
      break;
    }

    case "BudgetItemEndEvent": {
      const s = state.seriesDefs.find((sd) => sd.id === event.seriesId);
      if (s && s.endMonth == null) {
        s.endMonth = event.month - 1;
      }
      break;
    }
  }
}

// ─── Sorted replay order: (month ASC, sequenceNumber ASC) ────────────────────

function sortedEvents(events: readonly LifeEvent[]): LifeEvent[] {
  return [...events].sort(
    (a, b) => a.month - b.month || a.sequenceNumber - b.sequenceNumber,
  );
}

// ─── Convert replay state to HouseholdSimInput ───────────────────────────────

function buildSimInput(
  state: ReplayState,
  base: LedgerBaseConfig,
  externalAccounts: readonly Account[],
): HouseholdSimInput {
  const incomeSeries: OwnedSeries[] = [];
  const expenseSeries: OwnedSeries[] = [];

  for (const def of state.seriesDefs) {
    const series = new CashFlowSeries(
      def.startMonth,
      def.monthlyCents,
      def.growthMode,
      {
        baselineUnit: "monthly",
        endMonth: def.endMonth,
        taxCategory: def.taxCategory,
      },
    );
    if (def.seriesType === "income") {
      incomeSeries.push({ series, ownerId: def.ownerId });
    } else {
      expenseSeries.push({ series, ownerId: def.ownerId });
    }
  }

  // Build liabilities with their payoff transfers.
  const liabilities: Liability[] = [];
  for (const def of state.liabilityDefs) {
    const liab = new Liability({
      id: def.id,
      ownerId: def.ownerId,
      kind: def.kind,
      openingBalanceCents: def.openingBalanceCents,
      apr: def.apr,
      termMonths: def.termMonths,
      creditLimitCents: def.creditLimitCents,
    });
    for (const t of def.transfers) {
      liab.addTransfer({ month: t.month, amountCents: t.amountCents });
    }
    liabilities.push(liab);
  }

  // Apply debt-payoff outflows to the matching accounts.
  const accounts = externalAccounts.map((acc) => {
    const outflows = state.accountOutflows.filter((o) => o.accountId === acc.id);
    if (outflows.length === 0) return acc;
    // Clone the account and attach the outflow transfers.
    const clone = new Account({
      id: acc.id,
      ownerId: acc.ownerId,
      liquid: acc.liquid,
      taxTreatment: acc.taxTreatment,
      openingBalanceCents: acc.openingBalanceCents,
      initialAnnualRate: acc.getRateAt(0),
    });
    for (const o of outflows) {
      clone.addTransfer({ month: o.month, amountCents: o.amountCents });
    }
    return clone;
  });

  const allPersons = [...(base.initialPersons ?? []), ...state.persons];

  return {
    horizonMonths: base.horizonMonths,
    annualInflationRate: base.annualInflationRate,
    startYear: base.startYear,
    persons: allPersons,
    accounts,
    incomeSeries,
    expenseSeries,
    liabilities: liabilities.length > 0 ? liabilities : undefined,
  };
}

// ─── Public replay API ────────────────────────────────────────────────────────

export interface LedgerBaseConfig {
  readonly horizonMonths: number;
  readonly annualInflationRate: number;
  readonly startYear?: number;
  /** Persons present before any events (e.g. the primary account holder). */
  readonly initialPersons?: readonly Person[];
  /** Accounts managed outside the event ledger (provide once; payoff events attach outflows). */
  readonly initialAccounts?: readonly Account[];
}

/**
 * Replay the ledger against `base` config and `jurisdiction`, returning the full
 * projection series. This is the main derive-from-replay entry point.
 *
 * Replay order: (month ASC, sequenceNumber ASC) — producer-before-consumer
 * within the same month is guaranteed by using sequence numbers assigned at
 * append time (§5, §6).
 */
export function replayLedger(
  ledger: Ledger,
  base: LedgerBaseConfig,
  jurisdiction: Jurisdiction,
): ProjectionSeries {
  const state = freshState();
  for (const event of sortedEvents(ledger.events)) {
    applyEvent(event, state);
  }
  const simInput = buildSimInput(state, base, base.initialAccounts ?? []);
  return simulateHousehold(simInput, jurisdiction);
}

// ─── Undo: Strategy A + B ────────────────────────────────────────────────────

/**
 * Ids of all events that would be removed when event `id` is removed:
 * the event itself plus any event with `sourceEventId === id` (Strategy B,
 * §6.2 — reference-scoped cascade, one level deep only per spec).
 */
export function computeDependents(ledger: Ledger, id: string): string[] {
  const direct = ledger.events
    .filter((e) => e.sourceEventId === id)
    .map((e) => e.id);
  return [id, ...direct];
}

export type RemoveResult =
  | { ok: true; ledger: Ledger }
  | { ok: false; conflict: string };

/**
 * Remove event `id` from the ledger (and any Strategy-B dependents).
 *
 * Strategy A (§6.1): replay the remaining events in order; if any event's
 * preconditions fail against the state accumulated so far, the removal is
 * blocked and the conflict is named.
 *
 * Strategy B (§6.2): if Strategy A passes, also remove events whose
 * `sourceEventId` matches the removed event.
 */
export function removeEvent(ledger: Ledger, id: string): RemoveResult {
  const toRemove = new Set(computeDependents(ledger, id));
  const remaining = ledger.events.filter((e) => !toRemove.has(e.id));

  // Strategy A: replay remaining events; fail if any precondition is violated.
  const state = freshState();
  for (const event of sortedEvents(remaining)) {
    const check = checkPreconditions(event, state);
    if (!check.ok) {
      return {
        ok: false,
        conflict: `Cannot remove event "${id}": removing it causes event "${event.id}" (${event.type}) to fail — ${check.reason}`,
      };
    }
    applyEvent(event, state);
  }

  // Strategy A passed → rebuild the ledger without the removed events.
  const newLedger: Ledger = {
    events: remaining,
    nextSeq: ledger.nextSeq, // sequence numbers are never recycled
  };
  return { ok: true, ledger: newLedger };
}
