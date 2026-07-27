/**
 * Interpret state — the engine's *internal*, mutable accumulator.
 *
 * `InterpretState` is a set of indexed maps that the event handlers push
 * into as they interpret the ledger, eliminating the linear `.find`/`.some`
 * scans of the old array-based state. It is never externally observable —
 * `interpret.ts` converts it to the immutable, array-shaped {@link Household} at
 * the public boundary. Maps preserve insertion order, so that conversion is
 * deterministic.
 */

import type { Cents } from "../money";
import type { GrowthMode, TaxCategory } from "../cashFlowSeries";
import type { LiabilityKind } from "../liability";
import type { Person } from "../person";
import type {
  AccountId,
  ChildId,
  LiabilityId,
  PersonId,
  PropertyId,
  SeriesId,
} from "../ids";
import type { Child, SeriesBaseline, SeriesRole } from "./eventTypes";
import type { AccountTransfer, FundingDraw, LiabilityTransfer } from "./transfers";

/** Membership as an explicit interval: durable authoring person, active window. */
export interface PersonMembership {
  readonly person: Person;
  /** Month the person joined; `-Infinity` for base (pre-event) household. */
  startMonth: number;
  /** Month membership ended (separation), or `null` while still a member. */
  endMonth: number | null;
}

/** An event-derived income/expense series, described as data until materialized. */
export interface SeriesDef {
  readonly id: SeriesId;
  readonly causedByEventId: string;
  readonly role: SeriesRole;
  readonly ownerId: PersonId;
  readonly seriesType: "income" | "expense";
  readonly startMonth: number;
  /** Inclusive last active month; `null` = open-ended. Mutated by later events. */
  endMonth: number | null;
  readonly baseline: SeriesBaseline;
  readonly growthMode: GrowthMode;
  readonly taxCategory?: TaxCategory;
}

/** The fields an event-derived liability carries whatever its kind. */
interface LiabilityDefCommon {
  readonly id: LiabilityId;
  readonly causedByEventId: string;
  readonly ownerId: PersonId;
  readonly startMonth: number;
  readonly openingBalanceCents: Cents;
  readonly apr: number;
  readonly transfers: LiabilityTransfer[];
}

/**
 * An event-derived liability, described as immutable data (instantiated at the sim
 * boundary). Discriminated on `kind`, mirroring {@link LoanEvent}: a revolving
 * card carries a credit limit and never amortizes; a term loan amortizes over a
 * term and has no limit. Each field is required exactly where it applies and
 * unrepresentable where it does not — a card with a term will not typecheck.
 */
export type LiabilityDef =
  | (LiabilityDefCommon & {
      readonly kind: "creditCard";
      readonly creditLimitCents: Cents;
    })
  | (LiabilityDefCommon & {
      readonly kind: Exclude<LiabilityKind, "creditCard">;
      readonly termMonths: number;
    });

/**
 * An event-derived {@link Property} — a durable, appreciating asset stock.
 * Value grows by its own `appreciationMode` (default `inflationLinked`), stops
 * contributing after `endMonth` (a sale), and `associates` the mortgage whose
 * balance nets against value to give equity. Immutable data; instantiated at the
 * sim boundary like liabilities.
 */
export interface PropertyDef {
  readonly id: PropertyId;
  readonly causedByEventId: string;
  readonly ownerId: PersonId;
  readonly startMonth: number;
  /** Sale month; `null` while owned. Value contributes only through this month. */
  endMonth: number | null;
  readonly openingValueCents: Cents;
  readonly appreciationMode: GrowthMode;
  /** The mortgage liability associated with this property; `null` if paid cash. */
  readonly mortgageLiabilityId: LiabilityId | null;
}

export interface InterpretState {
  readonly personsById: Map<PersonId, PersonMembership>;
  readonly childrenById: Map<ChildId, Child>;
  readonly seriesById: Map<SeriesId, SeriesDef>;
  readonly liabilitiesById: Map<LiabilityId, LiabilityDef>;
  readonly propertiesById: Map<PropertyId, PropertyDef>;
  readonly accountTransfersByAccountId: Map<AccountId, AccountTransfer[]>;
  /**
   * Ordered, cross-account down-payment / spend draws, appended in event order. The
   * simulator resolves each against the sources' month-M balances (they cannot be
   * pre-split here — the split is balance-dependent, and replay carries no balances).
   */
  readonly fundingDraws: FundingDraw[];
}

export function freshState(): InterpretState {
  return {
    personsById: new Map(),
    childrenById: new Map(),
    seriesById: new Map(),
    liabilitiesById: new Map(),
    propertiesById: new Map(),
    accountTransfersByAccountId: new Map(),
    fundingDraws: [],
  };
}

/**
 * One liquid account's contribution to the sourced-funds total at a month: the
 * account's reporting label and its balance. The down-payment block enumerates
 * these so the conflict names exactly which buckets it counted (a liquid cash goal
 * fund included), rather than telling the user goal funds never count.
 */
export interface LiquidBucket {
  /** The account id — how the down-payment gate matches a bucket to a selected source. */
  readonly id: string;
  readonly label: string;
  readonly balanceCents: Cents;
}

/** Read-only context available to handlers during interpretation (base-provided facts). */
export interface InterpretContext {
  /** Account ids known to exist (from base config) — validates payoff targets. */
  readonly accountIds: ReadonlySet<AccountId>;
  /** Base annual inflation rate — the default rate for `inflationLinked` growth. */
  readonly annualInflationRate: number;
  /**
   * The liquid accounts (id + label + balance) available at a month — one bucket per
   * base `liquid` account with a positive balance, from a projection of the ledger
   * *so far*. The down-payment hard block matches its SELECTED sources against these by
   * id, drains them in the user's order, and names them in its conflict message, so the
   * stated total and the itemised list are one value by construction. A cash goal fund
   * is included (it is liquid, hence a genuine source); credit never is (not a liquid
   * asset), so "credit is not a down-payment source" holds by construction. Present only
   * on the authoring path ({@link addEvent}); `undefined` during ordinary interpretation
   * and undo, when handlers skip projection-dependent affordability checks.
   */
  readonly liquidBucketsAt?: (month: number) => readonly LiquidBucket[];
}
