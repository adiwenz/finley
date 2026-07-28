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
 * One selected funding source as the availability check saw it: its reporting label and its
 * liquid balance at the month. A conflict message enumerates these so it names exactly which
 * sources it counted (a liquid cash goal fund included), rather than telling the user goal
 * funds never count. A selected id that is not a liquid account (or holds nothing) is carried
 * at balance 0 so it still names itself.
 */
export interface FundingSourceBalance {
  readonly id: string;
  readonly label: string;
  readonly balanceCents: Cents;
}

/**
 * The affordability verdict for a set of selected funding sources at a month — whether they
 * can net a wanted amount once the capital-gains tax on liquidating them is paid. Event-
 * neutral: the Home Purchase §4.5 down-payment gate reads it today, and any other event that
 * funds a fixed amount from an ordered source list (One-Time Spend) reads the same
 * shape. A gate hard-blocks on a positive `shortfallCents`.
 */
export interface FundingAvailability {
  /** Uncovered remainder after draining the sources NET of capital-gains tax; >0 blocks. */
  readonly shortfallCents: Cents;
  /** What the selected sources genuinely net toward the wanted amount, after that tax. */
  readonly availableCents: Cents;
  /**
   * The capital-gains tax the liquidation induces — the wedge between what the sources hold
   * and what they deliver. Zero for cash sources (no gain over basis) and under a no-tax
   * jurisdiction. A picker states it so the user sees why $60,500 of balances buys a $60,000
   * house only sometimes.
   */
  readonly taxCents: Cents;
  /** True when that tax is non-zero — the flag a message reads to add "after tax". */
  readonly taxed: boolean;
  /** The selected sources in drain order, for the conflict message. */
  readonly sources: readonly FundingSourceBalance[];
}

/** Read-only context available to handlers during interpretation (base-provided facts). */
export interface InterpretContext {
  /** Account ids known to exist (from base config) — validates payoff targets. */
  readonly accountIds: ReadonlySet<AccountId>;
  /** Base annual inflation rate — the default rate for `inflationLinked` growth. */
  readonly annualInflationRate: number;
  /**
   * The funding-availability check every money-out event's affordability gate shares: given
   * the SELECTED sources (in the user's drain order), the amount wanted, and the month,
   * resolve — against a projection of the ledger *so far* — whether those sources can net
   * that amount once the capital-gains tax on liquidating them is paid. It runs the SAME
   * ordered gross-up the simulator uses ({@link
   * import("../projection/fundingDrawStep").resolveOrderedFundingDraw}) on the same
   * {@link import("./transfers").FundingDraw} shape, differencing each sale's tax marginally
   * over the owner's projected other income that month, so a gate blocks exactly when the sim
   * would fall short — under any tax regime, with no standalone-rate estimate.
   *
   * Deliberately event-neutral: the Home Purchase §4.5 down-payment gate is its first caller,
   * and One-Time Spend gates on the identical question. Only liquid accounts fund a
   * draw (a cash goal fund included; credit never, being a liability), so an illiquid or empty
   * selected source contributes 0. Present only on the authoring path ({@link addEvent});
   * `undefined` during ordinary interpretation and undo, when handlers skip
   * projection-dependent checks.
   */
  readonly fundingAvailabilityAt?: (
    sourceIds: readonly string[],
    amountCents: Cents,
    month: number,
  ) => FundingAvailability;
}
