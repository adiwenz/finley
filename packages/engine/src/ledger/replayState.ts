/**
 * Replay state and the replay-derived household model.
 *
 * `ReplayState` is the engine's *internal*, mutable accumulator: indexed maps
 * (§9) that the event handlers push into as they replay, eliminating the linear
 * `.find`/`.some` scans of the old array-based state. It is never externally
 * observable — replay converts it to the immutable, array-shaped
 * `ReplayedHousehold` at the public boundary (§1). Maps preserve insertion
 * order, so that conversion is deterministic.
 */

import type { Cents } from "../money";
import type { GrowthMode, TaxCategory } from "../cashFlowSeries";
import { CashFlowSeries } from "../cashFlowSeries";
import type { LiabilityKind } from "../liability";
import type { Account } from "../account";
import type { Person, OwnedSeries } from "../projection/simulate";
import type {
  AccountId,
  ChildId,
  LiabilityId,
  PersonId,
  SeriesId,
} from "../ids";
import type { Child, SeriesBaseline, SeriesRole } from "./eventTypes";

// ─── Internal, mutable replay descriptors ────────────────────────────────────

/** Membership as an explicit interval (§3): durable person, active window. */
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

/** A one-time principal adjustment against a liability (paydown), with its funding account. */
export interface LiabilityTransfer {
  readonly month: number;
  /** Negative = reduces the owed balance. */
  readonly amountCents: Cents;
  readonly accountId: AccountId;
}

/** An event-derived liability, described as immutable data (instantiated at the sim boundary, §5). */
export interface LiabilityDef {
  readonly id: LiabilityId;
  readonly causedByEventId: string;
  readonly ownerId: PersonId;
  readonly startMonth: number;
  readonly kind: LiabilityKind;
  readonly openingBalanceCents: Cents;
  readonly apr: number;
  readonly termMonths?: number;
  readonly creditLimitCents?: Cents;
  readonly transfers: LiabilityTransfer[];
}

/** A one-time outflow applied to an asset account (the funding half of a payoff, §3.2). */
export interface AccountTransfer {
  readonly accountId: AccountId;
  readonly month: number;
  /** Negative = outflow. */
  readonly amountCents: Cents;
}

export interface ReplayState {
  readonly personsById: Map<PersonId, PersonMembership>;
  readonly childrenById: Map<ChildId, Child>;
  readonly seriesById: Map<SeriesId, SeriesDef>;
  readonly liabilitiesById: Map<LiabilityId, LiabilityDef>;
  readonly accountTransfersByAccountId: Map<AccountId, AccountTransfer[]>;
}

export function freshState(): ReplayState {
  return {
    personsById: new Map(),
    childrenById: new Map(),
    seriesById: new Map(),
    liabilitiesById: new Map(),
    accountTransfersByAccountId: new Map(),
  };
}

/** Read-only context available to handlers during replay (base-provided facts). */
export interface ReplayContext {
  /** Account ids known to exist (from base config) — validates payoff targets. */
  readonly accountIds: ReadonlySet<AccountId>;
}

// ─── Base configuration ──────────────────────────────────────────────────────

export interface LedgerBaseConfig {
  readonly horizonMonths: number;
  readonly annualInflationRate: number;
  readonly startYear?: number;
  /** Persons present before any events (e.g. the primary account holder). */
  readonly initialPersons?: readonly Person[];
  /** Accounts managed outside the event ledger (payoff events attach outflows). */
  readonly initialAccounts?: readonly Account[];
  /**
   * Ongoing income series on the value-editing (Budget/Accounts) surface rather
   * than the event ledger (§10.2). Value edits are overrides on the series
   * artifact, never life events (§10.3 rule 1), so they are supplied here.
   */
  readonly initialIncomeSeries?: readonly OwnedSeries[];
  /** Ongoing expense series on the value-editing surface (see initialIncomeSeries). */
  readonly initialExpenseSeries?: readonly OwnedSeries[];
}

// ─── Public replay-derived model (the single source both consumers read) ─────

export interface HouseholdMembership {
  readonly person: Person;
  readonly startMonth: number;
  readonly endMonth: number | null;
}

/**
 * A household income/expense series. Carries its own materialized
 * `CashFlowSeries` — built exactly once here — so projection and snapshot read
 * monthly amounts through the *same* instance and cannot disagree (§14, §15).
 */
export interface HouseholdSeries {
  readonly id: SeriesId;
  readonly ownerId: PersonId;
  readonly seriesType: "income" | "expense";
  readonly role: SeriesRole;
  /** The event that created this series; `null` for base (value-editing) series. */
  readonly causedByEventId: string | null;
  readonly startMonth: number;
  readonly endMonth: number | null;
  readonly series: CashFlowSeries;
}

export interface HouseholdLiability {
  readonly id: LiabilityId;
  readonly kind: LiabilityKind;
  readonly ownerId: PersonId;
  readonly causedByEventId: string;
  readonly startMonth: number;
  readonly openingBalanceCents: Cents;
  readonly apr: number;
  readonly termMonths?: number;
  readonly creditLimitCents?: Cents;
  readonly transfers: readonly LiabilityTransfer[];
}

export interface ReplayedHousehold {
  readonly memberships: readonly HouseholdMembership[];
  readonly children: readonly Child[];
  readonly series: readonly HouseholdSeries[];
  readonly liabilities: readonly HouseholdLiability[];
  readonly accountTransfers: readonly AccountTransfer[];
}

/** Materialize a series descriptor into the one shared calculation primitive. */
export function materializeSeries(def: SeriesDef): CashFlowSeries {
  const initialBaseCents =
    def.baseline.unit === "annual" ? def.baseline.annualCents : def.baseline.monthlyCents;
  return new CashFlowSeries(def.startMonth, initialBaseCents, def.growthMode, {
    baselineUnit: def.baseline.unit,
    endMonth: def.endMonth ?? undefined,
    taxCategory: def.taxCategory,
  });
}
