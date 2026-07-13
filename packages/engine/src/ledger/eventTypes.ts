/**
 * Event types — the serializable data at the heart of the event-sourcing spine
 * (§0.3, §6). Events are plain discriminated-union objects; they are never
 * classes and are never mutated. Their meaning is defined in exactly one place
 * (the handler registry consumed by `replayHousehold`), never re-interpreted.
 */

import type { Cents } from "../money";
import type { GrowthMode, TaxCategory } from "../cashFlowSeries";
import type { LiabilityKind } from "../liability";
import type { Person } from "../projection/simulate";

// ─── Durable entity ──────────────────────────────────────────────────────────

export interface Child {
  readonly id: string;
  readonly name: string;
  /** Absolute simulation month of birth (may be ≤ 0 for pre-sim births). */
  readonly birthMonth: number;
  /** The ChildEvent that recorded this child. */
  readonly causedByEventId: string;
}

// ─── Event base ──────────────────────────────────────────────────────────────

/**
 * Fields shared by *every* event — nothing more (§11). Dependency metadata and
 * roles are NOT here; they belong only to the event types that use them.
 */
export interface EventBase {
  readonly id: string;
  /** Monotonically assigned at append-time; breaks ties within the same month. */
  readonly sequenceNumber: number;
  readonly month: number;
}

/**
 * Mixed into the event types that can be *auto-created as a consequence of*
 * another event (§8). `causedByEventId` names the producer; removing the
 * producer transitively removes everything it caused. Producer-only events
 * (relationship, separation, series-end) do not carry it.
 */
export interface CausedByFields {
  readonly causedByEventId?: string;
}

// ─── Event types ─────────────────────────────────────────────────────────────

/** Adds a new person (partner/spouse) to the household. */
export interface RelationshipEvent extends EventBase {
  readonly type: "RelationshipEvent";
  readonly person: Person;
}

/** Records a child. Affects expenses only if explicit expense events follow. */
export interface ChildEvent extends EventBase, CausedByFields {
  readonly type: "ChildEvent";
  readonly childId: string;
  readonly childName: string;
  readonly birthMonth: number;
}

/**
 * Records a separation: ends all income series owned by the departing partner,
 * and optionally creates alimony and child-support expense streams tagged with
 * this event's id. Never touches child-owned expenses, mortgages, or other
 * liabilities (§4.3).
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
export interface LoanEvent extends EventBase, CausedByFields {
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
export interface DebtPayoffEvent extends EventBase, CausedByFields {
  readonly type: "DebtPayoffEvent";
  readonly liabilityId: string;
  readonly accountId: string;
  readonly amountCents: Cents;
}

/**
 * Starts (or changes) a person's primary income. Creates a new income series
 * from `month` forward. If `replacesSeriesId` is given, the existing series is
 * ended at month−1. `annualIncomeCents` is the source of truth — it is
 * distributed to months by the series machinery, never pre-rounded (§4).
 */
export interface JobChangeEvent extends EventBase, CausedByFields {
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
export interface BudgetItemStartEvent extends EventBase, CausedByFields {
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

export type LifeEventType = LifeEvent["type"];

/** Reads the optional dependency link off any event (only some types carry it). */
export function causedByEventId(event: LifeEvent): string | undefined {
  return "causedByEventId" in event ? event.causedByEventId : undefined;
}

// ─── Derived-series vocabulary ───────────────────────────────────────────────

/** Why a replay-derived series exists — machine-readable; labels are the UI's job. */
export type SeriesRole =
  | "base"
  | "primaryIncome"
  | "budgetItem"
  | "alimony"
  | "childSupport";

/**
 * How a series' baseline amount is expressed (§4). Annual baselines stay the
 * source of truth and are distributed across the year deterministically (12
 * months sum exactly to the annual total); monthly baselines repeat exactly.
 */
export type SeriesBaseline =
  | { readonly unit: "annual"; readonly annualCents: Cents }
  | { readonly unit: "monthly"; readonly monthlyCents: Cents };

// ─── New-event input ─────────────────────────────────────────────────────────

/** Distributes `Omit` across a union so each member keeps its discriminant. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, Extract<K, keyof T>>
  : never;

/**
 * A life event ready to append: every field except the ledger-assigned
 * `sequenceNumber`. The caller supplies `id` (intentional, stable ids).
 */
export type NewLifeEvent = DistributiveOmit<LifeEvent, "sequenceNumber">;
