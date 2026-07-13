/**
 * Household — the immutable, array-shaped model that interpretation produces and
 * both consumers (projection and snapshot) read (§1). Built once at the public
 * boundary from the internal {@link InterpretState} accumulator, so the two
 * consumers can never interpret the ledger differently.
 */

import type { Cents } from "../money";
import type { GrowthMode } from "../cashFlowSeries";
import type { CashFlowSeries } from "../cashFlowSeries";
import type { LiabilityKind } from "../liability";
import type { Person } from "../projection/simulate";
import type { LiabilityId, PersonId, PropertyId, SeriesId } from "../ids";
import type { Child, SeriesRole } from "./eventTypes";
import type { AccountTransfer, LiabilityTransfer } from "./transfers";

export interface HouseholdMembership {
  readonly person: Person;
  readonly startMonth: number;
  readonly endMonth: number | null;
}

/**
 * A household income/expense series. Carries its own materialized
 * `CashFlowSeries` — built exactly once at interpretation — so projection and
 * snapshot read monthly amounts through the *same* instance and cannot disagree
 * (§14, §15).
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

/** A durable property in the derived model — an appreciating stock (§4.1). */
export interface HouseholdProperty {
  readonly id: PropertyId;
  readonly ownerId: PersonId;
  readonly causedByEventId: string;
  readonly startMonth: number;
  readonly endMonth: number | null;
  readonly openingValueCents: Cents;
  readonly appreciationMode: GrowthMode;
  readonly mortgageLiabilityId: LiabilityId | null;
}

export interface Household {
  readonly memberships: readonly HouseholdMembership[];
  readonly children: readonly Child[];
  readonly series: readonly HouseholdSeries[];
  readonly liabilities: readonly HouseholdLiability[];
  readonly properties: readonly HouseholdProperty[];
  readonly accountTransfers: readonly AccountTransfer[];
}
