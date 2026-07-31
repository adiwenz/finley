/**
 * Plain serializable discriminated-union objects: never classes, never mutated. Their
 * meaning is defined in exactly one place — the handler registry `interpretLedger`
 * consumes.
 */

import type { Cents } from "../money";
import type { GrowthMode } from "../cashFlowSeries";
import type { LiabilityKind } from "../liability";
import type { Person } from "../person";

// Durable entity

export interface Child {
  readonly id: string;
  readonly name: string;
  /** Absolute simulation month of birth (may be ≤ 0 for pre-sim births). */
  readonly birthMonth: number;
  /** The ChildEvent that recorded this child. */
  readonly causedByEventId: string;
}

// Event base

/**
 * Fields shared by *every* event — nothing more. Dependency metadata and roles belong to
 * the event types that use them.
 */
export interface EventBase {
  readonly id: string;
  /** Monotonically assigned at append-time; breaks ties within the same month. */
  readonly sequenceNumber: number;
  readonly month: number;
}

/**
 * Mixed into event types that can be auto-created as a consequence of another event;
 * removing the producer transitively removes everything it caused. Producer-only events
 * (relationship, separation, series-end) omit it.
 */
export interface CausedByFields {
  readonly causedByEventId?: string;
}

// Event types

export interface RelationshipEvent extends EventBase {
  readonly type: "RelationshipEvent";
  readonly person: Person;
}

/**
 * A positive `annualCostCents` spawns a linked expense (role `childCost`) from
 * `birthMonth` for exactly 18 years, tagged with this event's id so undoing the child
 * removes it. A zero cost records the child with no financial effect.
 */
export interface ChildEvent extends EventBase, CausedByFields {
  readonly type: "ChildEvent";
  readonly childId: string;
  readonly childName: string;
  readonly birthMonth: number;
  /** Today's dollars. */
  readonly annualCostCents: Cents;
}

/**
 * Ends all income series owned by the departing partner and creates alimony and
 * child-support expense streams tagged with this event's id — 0 in an amount field means
 * no such stream; alimony duration runs from this event's month. Never touches child-owned
 * expenses, mortgages, or other liabilities.
 */
export interface SeparationEvent extends EventBase {
  readonly type: "SeparationEvent";
  readonly partnerPersonId: string;
  readonly alimonyMonthlyCents: Cents;
  readonly alimonyDurationMonths: number;
  readonly childSupportMonthlyCents: Cents;
}

/**
 * Acquires a durable {@link Property} entity with its appreciating value and drains the down
 * payment as one-time outflows. Does NOT touch any budget item — ceasing to rent is a separate,
 * user-authored decision. Subject to the down-payment hard block.
 *
 * The financing mortgage is NOT minted here — it is an independent {@link LoanEvent}, and this
 * event only *names* it through {@link securedByLiabilityId}. Composing the two is the authoring
 * layer's job (`buyHome` emits the loan first, then this); keeping them separate is what lets a
 * pre-existing home reuse the same primitive as a plain property holding, and lets a cash
 * purchase omit the link entirely.
 */
export interface HomePurchaseEvent extends EventBase {
  readonly type: "HomePurchaseEvent";
  readonly propertyId: string;
  readonly ownerId: string;
  readonly purchasePriceCents: Cents;
  readonly downPaymentCents: Cents;
  /**
   * The liquid accounts funding the down payment, in drain order: each is emptied before
   * the next is touched, and each contributing source receives its own paired outflow.
   * Credit is never eligible (a real mortgage rule).
   */
  readonly downPaymentSourceIds: readonly string[];
  /**
   * The liability financing the property, when there is one. Directional (property → liability)
   * and referential, not owning: it must already exist when this replays, which forces the
   * securing loan to sort first and blocks removing that loan while the property still names it.
   * A cash purchase omits it.
   */
  readonly securedByLiabilityId?: string;
  /** Defaults to `inflationLinked` at base inflation. */
  readonly appreciationMode?: GrowthMode;
}

interface LoanEventCommon extends EventBase, CausedByFields {
  readonly type: "LoanEvent";
  readonly liabilityId: string;
  readonly ownerId: string;
  readonly openingBalanceCents: Cents;
  readonly apr: number;
}

/**
 * `termMonths` and `creditLimitCents` are not optional but kind-*determined*: a revolving
 * card has a credit limit and never amortizes, a term loan amortizes and has no limit. A
 * card with a term will not typecheck, so replay and validation need not re-check the
 * combination. One event `type`, not two, because both arms replay and cascade
 * identically — only the shape differs.
 */
export type LoanEvent =
  | (LoanEventCommon & {
      readonly kind: "creditCard";
      readonly creditLimitCents: Cents;
    })
  | (LoanEventCommon & {
      readonly kind: Exclude<LiabilityKind, "creditCard">;
      readonly termMonths: number;
    });

/**
 * A lump-sum principal paydown. Callers must supply the paired Account outflow (same
 * amount, same month) to conserve net worth.
 */
export interface DebtPayoffEvent extends EventBase, CausedByFields {
  readonly type: "DebtPayoffEvent";
  readonly liabilityId: string;
  readonly accountId: string;
  readonly amountCents: Cents;
}

export type LifeEvent =
  | RelationshipEvent
  | ChildEvent
  | SeparationEvent
  | HomePurchaseEvent
  | LoanEvent
  | DebtPayoffEvent;

export type LifeEventType = LifeEvent["type"];

export function causedByEventId(event: LifeEvent): string | undefined {
  return "causedByEventId" in event ? event.causedByEventId : undefined;
}

// Derived-series vocabulary

/** Why a replay-derived series exists; display labels are the UI's job. */
export type SeriesRole =
  | "base"
  | "primaryIncome"
  | "alimony"
  | "childSupport"
  | "childCost";

/**
 * Annual baselines stay the source of truth and are distributed so 12 months sum exactly
 * to the annual total; monthly baselines repeat exactly.
 */
export type SeriesBaseline =
  | { readonly unit: "annual"; readonly annualCents: Cents }
  | { readonly unit: "monthly"; readonly monthlyCents: Cents };

// New-event input

/** Distributes `Omit` across a union so each member keeps its discriminant. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, Extract<K, keyof T>>
  : never;

/** `sequenceNumber` is ledger-assigned; the caller supplies `id`, which is stable. */
export type NewLifeEvent = DistributiveOmit<LifeEvent, "sequenceNumber">;
