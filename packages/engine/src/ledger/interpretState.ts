/**
 * Interpret state — the engine's *internal*, mutable accumulator.
 *
 * `InterpretState` is a set of indexed maps (§9) that the event handlers push
 * into as they interpret the ledger, eliminating the linear `.find`/`.some`
 * scans of the old array-based state. It is never externally observable —
 * `interpret.ts` converts it to the immutable, array-shaped {@link Household} at
 * the public boundary (§1). Maps preserve insertion order, so that conversion is
 * deterministic.
 */

import type { Cents } from "../money";
import type { GrowthMode, TaxCategory } from "../cashFlowSeries";
import type { LiabilityKind } from "../liability";
import type { SimPerson } from "../projection/simulate";
import type {
  AccountId,
  ChildId,
  LiabilityId,
  PersonId,
  PropertyId,
  SeriesId,
} from "../ids";
import type { Child, SeriesBaseline, SeriesRole } from "./eventTypes";
import type { AccountTransfer, LiabilityTransfer } from "./transfers";

/** Membership as an explicit interval (§3): durable person, active window. */
export interface PersonMembership {
  readonly person: SimPerson;
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
 * boundary, §5). Discriminated on `kind`, mirroring {@link LoanEvent}: a revolving
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
 * An event-derived {@link Property} — a durable, appreciating asset stock (§4.1).
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
}

export function freshState(): InterpretState {
  return {
    personsById: new Map(),
    childrenById: new Map(),
    seriesById: new Map(),
    liabilitiesById: new Map(),
    propertiesById: new Map(),
    accountTransfersByAccountId: new Map(),
  };
}

/** Read-only context available to handlers during interpretation (base-provided facts). */
export interface InterpretContext {
  /** Account ids known to exist (from base config) — validates payoff targets. */
  readonly accountIds: ReadonlySet<AccountId>;
  /** Base annual inflation rate — the default rate for `inflationLinked` growth. */
  readonly annualInflationRate: number;
  /**
   * Liquid funds available at a month, summed across the base's `liquid` accounts
   * from a projection of the ledger *so far*. Present only on the authoring path
   * ({@link addEvent}), where the §4.5 down-payment hard block reads it; `undefined`
   * during ordinary interpretation and undo, when handlers skip projection-dependent
   * affordability checks. Credit is never included — it is not a liquid asset —
   * so "credit is not a down-payment source" holds by construction.
   */
  readonly liquidBalanceAt?: (month: number) => Cents;
}
