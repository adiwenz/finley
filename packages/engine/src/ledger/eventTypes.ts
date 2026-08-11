/**
 * Plain serializable discriminated-union objects: never classes, never mutated. Their
 * meaning is defined in exactly one place — the handler registry `interpretLedger`
 * consumes.
 */

import type { Cents } from "../money/money";
import type { GrowthMode } from "../money/cashFlowSeries";
import type { LiabilityKind } from "../liability/liability";
import type { Person } from "../plan/person";

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
 * The financing mortgage embedded in a purchase — the amortizing terms the handler materializes a
 * {@link LiabilityDef} from, at the authored {@link liabilityId}. That id is minted by authoring
 * (the same centralized counter every other id comes off), never derived or minted during
 * interpretation: `homePurchase.apply` only ever materializes the liability under the id it is
 * given. The liability is still a DEPENDENT artifact with no independent life — no separate
 * `LoanEvent` ever names it, so deleting the purchase drops it and revising the purchase rebuilds
 * it under the same id — but its identity is owned by authoring, not conjured at interpret time.
 * Absent ⇒ a cash purchase / a home owned outright.
 *
 * `openingBalanceCents` is stored uniformly but computed differently by the two authoring verbs:
 * `buyHome` derives it as `purchasePriceCents − downPaymentCents` (and its revision recomputes it
 * when either changes), while `ownHome` opens a holding at the mortgage's CURRENT balance.
 */
export interface EmbeddedMortgage {
  /**
   * Minted once, by authoring, when financing is added to this purchase — `applyHomePurchase`,
   * `applyOwnHome`, or a `buyHome` revision that turns a cash purchase into a financed one. A
   * revision that only edits terms on an already-financed purchase carries this id through
   * unchanged; one that removes financing drops the whole `mortgage` object, id included. A LATER
   * revision that re-finances mints a FRESH id — this one is never reused once its mortgage is
   * gone.
   */
  readonly liabilityId: string;
  readonly openingBalanceCents: Cents;
  readonly apr: number;
  readonly termMonths: number;
}

/**
 * Acquires a durable {@link Property} entity with its appreciating value and drains the down
 * payment as one-time outflows. Does NOT touch any budget item — ceasing to rent is a separate,
 * user-authored decision. Subject to the down-payment hard block.
 *
 * The financing mortgage rides along as {@link mortgage}, and the handler materializes the
 * securing {@link LiabilityDef} at `mortgage.liabilityId` (`causedByEventId` this event) — so a
 * pre-existing home reuses the same primitive as a plain property holding, and a cash purchase
 * omits `mortgage` entirely.
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
  /** The financing terms; absent ⇒ paid cash / owned outright. */
  readonly mortgage?: EmbeddedMortgage;
  /** Defaults to `inflationLinked` at base inflation. */
  readonly appreciationMode?: GrowthMode;
  /**
   * Basis metadata for a pre-existing home (a holding), where the true origination is off the
   * timeline: the month it was acquired and what was originally paid. Behavior-free — the sim
   * opens the property at `purchasePriceCents` (its CURRENT value) and no current-balance logic
   * reads these. They exist so a future sale can compute a capital gain against a real basis and
   * so the app can display the acquisition; a purchase authored during the plan omits them (its
   * basis is the purchase itself).
   */
  readonly acquiredMonth?: number;
  readonly originalPriceCents?: Cents;
}

/**
 * A dated, source-directed cash outflow: the user names which accounts (and, eligibly, credit
 * cards) fund it and in what order, distinct from a dated expense override, which finances
 * itself from the engine's default liquidation order and never blocks. Produces exactly one
 * obligation — `treatment: "expense"`, `funding: { kind: "explicit", orderedAccountIds }` — via
 * {@link import("../projection/financialObligation").explicitObligation}, the same generic
 * abstraction Home Purchase's down payment uses, differentiated only by `treatment`; it shares
 * the funding machinery with Home Purchase and nothing else (no price, no mortgage, no dependent
 * artifact).
 *
 * `amountCents` is NOMINAL at `month`, matching Home Purchase's down payment: a one-time event
 * is a point-in-time decision the user prices themselves, unlike a recurring stream, which stays
 * today's-dollars-plus-growth because it is a standing commitment that must track prices.
 */
export interface OneTimeSpendEvent extends EventBase {
  readonly type: "OneTimeSpendEvent";
  readonly label: string;
  readonly amountCents: Cents;
  /** Ordered; drained in order. May name a credit card — the engine never substitutes one. */
  readonly fundingSourceIds: readonly string[];
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
  | DebtPayoffEvent
  | OneTimeSpendEvent;

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
