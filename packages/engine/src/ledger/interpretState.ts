/**
 * The engine's *internal*, mutable accumulator: indexed maps the event handlers push into,
 * avoiding linear `.find`/`.some` scans. Never externally observable — `interpret.ts`
 * converts it to the immutable, array-shaped {@link Household} at the public boundary.
 * Maps preserve insertion order, so that conversion is deterministic.
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

export interface PersonMembership {
  readonly person: Person;
  /** Month the person joined; `-Infinity` for base (pre-event) household. */
  startMonth: number;
  /** Month membership ended (separation), or `null` while still a member. */
  endMonth: number | null;
}

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
 * Immutable data, instantiated at the sim boundary. Mirrors {@link LoanEvent}: a revolving
 * card carries a credit limit and never amortizes; a term loan amortizes over a term and has
 * no limit.
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
 * Value grows by its `appreciationMode` (default `inflationLinked`); the associated
 * mortgage's balance nets against value to give equity.
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
  /** `null` if paid cash. */
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
   * Cross-account down-payment / spend draws, appended in event order. The simulator
   * resolves each against the sources' month-M balances; they cannot be pre-split here,
   * since the split is balance-dependent and replay carries no balances.
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
 * One selected funding source as the availability check saw it. A selected id that is not a
 * liquid account (or holds nothing) is carried at balance 0 so a conflict message still
 * names it, rather than silently dropping it.
 */
export interface FundingSourceBalance {
  readonly id: string;
  readonly label: string;
  readonly balanceCents: Cents;
}

/**
 * Whether selected funding sources can net a wanted amount at a month once the
 * capital-gains tax on liquidating them is paid. Event-neutral: the Home Purchase §4.5
 * down-payment gate reads it today, One-Time Spend reads the same shape.
 */
export interface FundingAvailability {
  /** Uncovered remainder after draining the sources NET of capital-gains tax; >0 blocks. */
  readonly shortfallCents: Cents;
  readonly availableCents: Cents;
  /**
   * The wedge between what the sources hold and what they deliver. Zero for cash sources (no
   * gain over basis) and under a no-tax jurisdiction.
   */
  readonly taxCents: Cents;
  readonly taxed: boolean;
  /** The selected sources in drain order, for the conflict message. */
  readonly sources: readonly FundingSourceBalance[];
}

/** Base-provided facts, read-only to handlers during interpretation. */
export interface InterpretContext {
  /** Account ids known to exist (from base config) — validates payoff targets. */
  readonly accountIds: ReadonlySet<AccountId>;
  /** The default rate for `inflationLinked` growth. */
  readonly annualInflationRate: number;
  /**
   * The affordability check every money-out event's gate shares, resolved against a
   * projection of the ledger *so far*. Runs the SAME ordered gross-up as the simulator
   * ({@link import("../projection/fundingDrawStep").resolveOrderedFundingDraw}), differencing
   * each sale's tax marginally over the owner's projected other income that month, so a gate
   * blocks exactly when the sim would fall short.
   *
   * Present only on the authoring path ({@link addEvent}); `undefined` during ordinary
   * interpretation and undo, when handlers skip projection-dependent checks.
   */
  readonly fundingAvailabilityAt?: (
    sourceIds: readonly string[],
    amountCents: Cents,
    month: number,
  ) => FundingAvailability;
}
