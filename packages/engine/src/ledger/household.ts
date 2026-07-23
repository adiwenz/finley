/**
 * Household — the immutable, array-shaped model that interpretation produces and
 * both consumers (projection and snapshot) read (§1). Built once at the public
 * boundary from the internal {@link InterpretState} accumulator, so the two
 * consumers can never interpret the ledger differently.
 */

import type { Cents } from "../money";
import type { GrowthMode } from "../cashFlowSeries";
import type { SimCashFlowSeries } from "../cashFlowSeries";
import type { LiabilityKind } from "../liability";
import type { Person } from "../person";
import type { PlanDescriptor } from "../projection/waterfall";
import type { LiabilityId, PersonId, PropertyId, SeriesId } from "../ids";
import type { Child, SeriesRole } from "./eventTypes";
import type { AccountTransfer, LiabilityTransfer } from "./transfers";

export interface HouseholdMembership {
  /**
   * The household member as **authoring** {@link Person} data (§8) — identity, the
   * retirement/benefit inputs, and their jobs. The lower-level {@link
   * import("../projection/simulate").SimPerson} the sim consumes is *derived* from this
   * at the sim boundary via {@link import("../compilePerson").compilePerson}; the roster
   * the app holds and edits never touches it.
   */
  readonly person: Person;
  readonly startMonth: number;
  readonly endMonth: number | null;
}

/**
 * A household income/expense series. Carries its own materialized
 * `SimCashFlowSeries` — built exactly once at interpretation — so projection and
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
  readonly series: SimCashFlowSeries;
  /**
   * Human-facing name carried over from the base series ("Income", "Healthcare", a
   * budget line's label). Diagnostic only — nothing in the interpretation or the
   * simulation reads it; it exists so a report can name a series instead of
   * numbering it positionally.
   */
  readonly label?: string;
  /**
   * Retirement-plan descriptor (§5.5) for an income series funding a person-owned
   * account. Presence makes the source eligible for pre-tax deferral in the §5.0
   * waterfall. Only meaningful on income series; absent otherwise.
   */
  readonly planDescriptor?: PlanDescriptor;
  /**
   * Provenance of an expense series compiled from a standing budget line (§Q27): the
   * source line's id. Carried through so the simulator can report each line's monthly
   * amount ({@link
   * import("../projection/simulate").ProjectionMonthFlows.lineMonthlyCents}). Only set on
   * budget-line expense series; absent on scalar/health/event-caused series.
   */
  readonly lineId?: string;
}

/** The fields a derived liability carries whatever its kind. */
interface HouseholdLiabilityCommon {
  readonly id: LiabilityId;
  readonly ownerId: PersonId;
  readonly causedByEventId: string;
  readonly startMonth: number;
  readonly openingBalanceCents: Cents;
  readonly apr: number;
  readonly transfers: readonly LiabilityTransfer[];
}

/**
 * A liability in the derived model. Discriminated on `kind`, mirroring
 * {@link LoanEvent} and {@link LiabilityDef}: a revolving card carries a credit
 * limit and never amortizes; a term loan amortizes over a term and has no limit.
 * Each field is required exactly where it applies — a card with a term, or a loan
 * with a credit limit, will not typecheck.
 */
export type HouseholdLiability =
  | (HouseholdLiabilityCommon & {
      readonly kind: "creditCard";
      readonly creditLimitCents: Cents;
    })
  | (HouseholdLiabilityCommon & {
      readonly kind: Exclude<LiabilityKind, "creditCard">;
      readonly termMonths: number;
    });

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
