/**
 * The engine's *internal*, mutable accumulator: indexed maps the event handlers push into,
 * avoiding linear `.find`/`.some` scans. `interpret.ts` converts it to the immutable,
 * array-shaped {@link Household} at the public boundary; Maps preserve insertion order, so
 * that conversion is deterministic.
 */

import type { Cents } from "../money/money";
import type { GrowthMode, TaxCategory } from "../money/cashFlowSeries";
import type { LiabilityKind } from "../liability/liability";
import type { Person } from "../plan/person";
import type {
  AccountId,
  ChildId,
  LiabilityId,
  PersonId,
  PropertyId,
  SeriesId,
} from "../plan/ids";
import type { Child, SeriesBaseline, SeriesRole } from "./eventTypes";
import type { AccountTransfer, LiabilityTransfer } from "./transfers";
import type { FinancialObligation } from "../projection/financialObligation";
import type { FundingFailure } from "../projection/fundingFailure";
import type { FundingTreatment } from "../projection/fundingEligibility";

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
 * Mirrors {@link LoanEvent}: a revolving card carries a credit limit and never amortizes; a
 * term loan amortizes over a term and has no limit.
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
   * Explicitly-funded obligations — cross-account down-payment / spend draws, appended in event
   * order. The simulator resolves each against the sources' month-M balances; they cannot be
   * pre-split here, since the split is balance-dependent and replay carries no balances.
   */
  readonly fundingDraws: FinancialObligation[];
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
 * names it.
 */
export interface FundingSourceBalance {
  readonly id: string;
  readonly label: string;
  readonly balanceCents: Cents;
}

/**
 * Whether selected funding sources can net a wanted amount at a month once the capital-gains
 * tax on liquidating them is paid. Event-neutral: the Home Purchase §4.5 down-payment gate
 * and One-Time Spend read the same shape.
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
   * The shared funding-availability calculation, resolved against a projection of the ledger *so
   * far* by the SAME ordered gross-up the simulator runs ({@link
   * import("../projection/fundingDrawStep").resolveOrderedFundingDraw}). Gates the home-purchase
   * down payment (`homePurchase.check`) and is exposed to a preview/advisory unchanged — the gate
   * and the UI can never disagree about what a selection delivers.
   *
   * Present only on the authoring path ({@link addEvent}); `undefined` during ordinary
   * interpretation and undo, when handlers skip projection-dependent checks.
   */
  readonly fundingAvailabilityAt?: (
    sourceIds: readonly string[],
    amountCents: Cents,
    month: number,
  ) => FundingAvailability;
  /**
   * Why a shortfall the gate above found would happen: `funding-configuration` when eligible
   * money sits in an account the household didn't select, `no-eligible-source-suffices` when
   * the whole eligible pool still falls short. Priced over the same seam as
   * `fundingAvailabilityAt` — its `selectedSources*Cents` figures come from that exact call, not
   * a second calculation — so the refusal message can name an alternative without the gate and
   * the classifier ever pricing the selection differently. Advisory only: the engine recommends,
   * it never substitutes a source for the one the household named.
   *
   * Present only on the authoring path ({@link addEvent}); `undefined` during ordinary
   * interpretation and undo.
   */
  readonly fundingFailureAt?: (
    treatment: FundingTreatment,
    sourceIds: readonly string[],
    amountCents: Cents,
    month: number,
  ) => FundingFailure;
  /**
   * The household's liquid funding pool at `month`, largest balance first — labels for
   * `fundingFailureAt`'s `alternativeSources`, which carry only an `accountId`. Present only on
   * the authoring path ({@link addEvent}).
   */
  readonly fundingSourcesAt?: (month: number) => readonly FundingSourceBalance[];
}
