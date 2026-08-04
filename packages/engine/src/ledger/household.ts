/**
 * Household — the immutable, array-shaped model interpretation produces and both consumers
 * (projection and snapshot) read. Built once at the public boundary from the internal
 * {@link InterpretState} accumulator, so the two can never interpret the ledger differently.
 */

import type { Cents } from "../money";
import type { GrowthMode } from "../cashFlowSeries";
import type { SimCashFlowSeries } from "../cashFlowSeries";
import type { LiabilityKind } from "../liability";
import type { FinancialObligation, ObligationSource } from "../projection/financialObligation";
import type { JobPaySpan } from "../job";
import type { Person } from "../person";
import type { PlanDescriptor } from "../projection/waterfall";
import type { LiabilityId, PersonId, PropertyId, SeriesId } from "../ids";
import type { Account } from "../account";
import type { Child, SeriesRole } from "./eventTypes";
import type { AccountTransfer, LiabilityTransfer } from "./transfers";

export interface HouseholdMembership {
  /**
   * The member as **authoring** {@link Person} data. The narrower
   * {@link import("../projection/simulate").SimPerson} the sim consumes is derived from it
   * at the sim boundary via {@link import("../compilePerson").compilePerson}.
   */
  readonly person: Person;
  readonly startMonth: number;
  readonly endMonth: number | null;
}

/**
 * A household income/expense series. Carries its own `SimCashFlowSeries`, materialized
 * exactly once at interpretation, so projection and snapshot read monthly amounts through
 * the *same* instance and cannot disagree.
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
   * Human-facing name carried over from the base series ("Income", "Healthcare", a budget
   * line's label). Diagnostic only — nothing in interpretation or simulation reads it.
   */
  readonly label?: string;
  /**
   * Stable per-source id carried over from the base series — a job's id, so per-source
   * reporting can name *which* job a paycheck came from. Diagnostic only.
   */
  readonly sourceId?: string;
  /**
   * Retirement-plan descriptor for an income series funding a person-owned account.
   * Presence makes the source deferral-eligible in the waterfall. Income series only.
   */
  readonly planDescriptor?: PlanDescriptor;
  /**
   * The source line's id, keying
   * {@link import("../projection/simulate").ProjectionMonthFlows.lineMonthlyCents}. Set
   * only on budget-line expense series; absent on health and event-caused ones.
   */
  readonly lineId?: string;
  /**
   * Which authoring model this expense came from, so it can be built into a {@link
   * import("../projection/financialObligation").FinancialObligation}. Carried from the base
   * series or derived from an event-created series' {@link SeriesRole}.
   */
  readonly obligationSource?: ObligationSource;
}

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
 * Discriminated on `kind` like {@link LoanEvent} and {@link LiabilityDef}: a revolving card
 * carries a credit limit and never amortizes; a term loan amortizes and has no limit. A
 * card with a term, or a loan with a credit limit, will not typecheck.
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

/** An appreciating asset stock. */
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
  /**
   * The household's accounts — the authoring side of the very
   * {@link import("../planAccount").PlanAccount}s the simulation runs, so net worth here and
   * the simulated balances cannot describe different holdings. Owners resolve against
   * {@link memberships} through {@link import("../account").accountsOf} et al., an invariant
   * interpretation enforces.
   */
  readonly accounts: readonly Account[];
  readonly accountTransfers: readonly AccountTransfer[];
  /**
   * Explicitly-funded obligations — ordered cross-account down-payment / spend draws, resolved
   * against source balances at the sim boundary, not here, since the split is balance-dependent.
   */
  readonly fundingDraws: readonly FinancialObligation[];
}

/**
 * One job's resolved employment window, already intersecting everything that can end it —
 * the job's own authored end, its owner's `retirementTargetAge`, and (mid-solve, or under a
 * preview run) any {@link import("../householdJob").StopWorkingBoundary} — read straight off
 * the income series {@link import("../compilePerson").compileJobIncome} built for it.
 *
 * `null` means the job pays the household no month at or after "now": already over before the
 * projection starts, or capped by a boundary that lands at or before its own start. Every
 * caller that needs "when does this job's employment actually end" should read it from here
 * rather than re-deriving the boundary math (owner's retirement age, any candidate stop-working
 * age) itself — that resolution is asymmetric (a boundary REPLACES the primary's own
 * `retirementTargetAge` but only CAPS everyone else's, and only caps a fixed-term job) and is
 * meant to live in exactly one place.
 */
export function resolvedJobEndMonth(household: Household, jobId: string): number | null {
  const series = household.series.find((s) => s.sourceId === `job:${jobId}`);
  return series?.endMonth ?? null;
}

/**
 * The window this household actually pays a job over — {@link resolvedJobEndMonth} turned into
 * the {@link import("../job").JobPaySpan} a caller can draw or total, given the job's authored
 * start. The start is the caller's because it is not a business rule: a job begins when it was
 * authored to begin, in this household or any other.
 *
 * The end is the rule, and it has three outcomes, not two. A resolved end month is the boundary
 * this household settled on — extended or capped, per the asymmetry {@link resolvedJobEndMonth}
 * describes. A `null` end is the third: it says this household pays the job NOTHING, and the
 * span it yields is EMPTY. That distinction is the whole point of this function existing.
 * "No resolved series" reads far too easily as "no opinion, fall back to what was authored",
 * and a caller that falls back puts the job's income back on screen in the very household that
 * retired it — a stop-working preview that removes a job the person only picks up at 70 would
 * still show them working at 70. Absence of a series is an answer: zero.
 *
 * The authored job is untouched either way. This resolves what a household PAYS, never what a
 * person authored, and no caller should read it as licence to edit or drop the job itself.
 */
export function resolvedJobPaySpan(
  household: Household,
  jobId: string,
  authored: JobPaySpan,
): JobPaySpan {
  const endMonth = resolvedJobEndMonth(household, jobId);
  return {
    startMonth: authored.startMonth,
    // An end month is the last month PAID; the span's end is one past it. `null` collapses the
    // span onto its own start, which pays no month at all.
    endMonthExclusive: endMonth === null ? authored.startMonth : endMonth + 1,
  };
}
