/**
 * Snapshot — the household cross-section as of one month (§10.8).
 *
 * Built from the same {@link Household} the projection consumes, so
 * presence (who/what is active) can never drift from the projection's stocks
 * (§1, §14). The requested month is clamped once (to the projection horizon)
 * and that single clamped month drives every field — people, children, flows,
 * liabilities, balances, and the returned `month` (§2).
 */

import type { Cents } from "../money";
import type { TaxCategory } from "../cashFlowSeries";
import type { LiabilityKind } from "../liability";
import type { ChildId, LiabilityId, PersonId, PropertyId, SeriesId } from "../ids";
import type { Child, SeriesRole } from "../ledger/eventTypes";
import type { LedgerBaseConfig } from "../ledger/ledgerBase";
import type { Household } from "../ledger/household";
import { interpretLedger } from "../ledger/interpret";
import type { Ledger } from "../ledger/ledger";
import type { SimPerson, ProjectionSeries } from "./simulate";

export interface SnapshotChild extends Child {
  readonly id: ChildId;
  readonly ageMonths: number;
}

export interface SnapshotSeries {
  readonly id: SeriesId;
  readonly ownerId: PersonId;
  readonly seriesType: "income" | "expense";
  readonly role: SeriesRole;
  /** Monthly rate at the snapshot month, growth applied — a *flow* (§10.8). */
  readonly monthlyCents: Cents;
  /** The event that created this series; `null` for base (value-editing) series. */
  readonly causedByEventId: string | null;
  readonly startMonth: number;
  readonly endMonth: number | null;
  readonly taxCategory?: TaxCategory;
}

export interface SnapshotLiability {
  readonly id: LiabilityId;
  readonly kind: LiabilityKind;
  readonly ownerId: PersonId;
  readonly causedByEventId: string;
  readonly startMonth: number;
}

export interface BalanceEntry {
  readonly id: string;
  readonly balanceCents: Cents;
}

/**
 * A property in the snapshot cross-section (§4.1). `valueCents` and
 * `mortgageBalanceCents` come from the projection month; `equityCents` is their
 * difference (value − mortgage). Without a projection, value falls back to the
 * opening value and mortgage/equity are unknown (null).
 */
export interface SnapshotProperty {
  readonly id: PropertyId;
  readonly ownerId: PersonId;
  readonly causedByEventId: string;
  readonly startMonth: number;
  readonly valueCents: Cents;
  readonly mortgageBalanceCents: Cents | null;
  readonly equityCents: Cents | null;
}

export interface SnapshotBalances {
  readonly accounts: readonly BalanceEntry[];
  /** Amounts owed, positive. */
  readonly liabilities: readonly BalanceEntry[];
  /** Null once the plan is insolvent (§5.1) — see {@link ProjectionMonth}. */
  readonly netWorthNominalCents: Cents | null;
  readonly isInsolvent: boolean;
}

export interface HouseholdSnapshot {
  readonly month: number;
  readonly persons: readonly SimPerson[];
  readonly children: readonly SnapshotChild[];
  readonly income: readonly SnapshotSeries[];
  readonly expenses: readonly SnapshotSeries[];
  readonly liabilities: readonly SnapshotLiability[];
  readonly properties: readonly SnapshotProperty[];
  /** Null unless a projection was supplied. */
  readonly balances: SnapshotBalances | null;
}

/** Clamp the requested month into the projection horizon, if one is supplied. */
function clampMonth(month: number, projection?: ProjectionSeries): number {
  const count = projection?.months.length ?? 0;
  if (count === 0) return month;
  return Math.max(0, Math.min(month, count - 1));
}

/**
 * The people in the household as of `month` (end-of-month convention, §10.8):
 * present from their `startMonth` and not yet separated (`endMonth > month`).
 * The single authoritative answer to "who is in the household at M" — the
 * snapshot and any UI that offers people to act on should read through this.
 */
export function membersAt(household: Household, month: number): SimPerson[] {
  return household.memberships
    .filter((mem) => mem.startMonth <= month && (mem.endMonth === null || mem.endMonth > month))
    .map((mem) => mem.person);
}

/**
 * Household cross-section as of `month` (end-of-month convention, §10.8): an
 * event at month M is applied at M. Presence is derived from `household`;
 * balances (stocks) are read from `projection` when supplied.
 */
export function buildSnapshot(
  household: Household,
  month: number,
  projection?: ProjectionSeries,
): HouseholdSnapshot {
  const m = clampMonth(month, projection);

  const persons = membersAt(household, m);

  const children: SnapshotChild[] = household.children
    .filter((c) => c.birthMonth <= m)
    .map((c) => ({ ...c, id: c.id as ChildId, ageMonths: m - c.birthMonth }));

  const income: SnapshotSeries[] = [];
  const expenses: SnapshotSeries[] = [];
  for (const s of household.series) {
    const active = s.startMonth <= m && (s.endMonth === null || m <= s.endMonth);
    if (!active) continue;
    const view: SnapshotSeries = {
      id: s.id,
      ownerId: s.ownerId,
      seriesType: s.seriesType,
      role: s.role,
      monthlyCents: s.series.getMonthlyCents(m),
      causedByEventId: s.causedByEventId,
      startMonth: s.startMonth,
      endMonth: s.endMonth,
      taxCategory: s.series.taxCategory,
    };
    if (s.seriesType === "income") income.push(view);
    else expenses.push(view);
  }

  const projectionMonth = projection?.months[m];
  const liabilities: SnapshotLiability[] = household.liabilities
    .filter((l) => {
      // With a projection, "active" means a positive balance at the month —
      // a paid-off liability disappears (§16). Without one, fall back to the
      // contractual origination month.
      if (projectionMonth) return (projectionMonth.liabilityBalancesCents[l.id] ?? 0) > 0;
      return l.startMonth <= m;
    })
    .map((l) => ({
      id: l.id,
      kind: l.kind,
      ownerId: l.ownerId,
      causedByEventId: l.causedByEventId,
      startMonth: l.startMonth,
    }));

  // Properties active at the month: present from purchase, not yet sold. With a
  // projection, a property with 0 value (sold, or pre-purchase) drops out; value,
  // mortgage balance and equity are read from the projection month.
  const properties: SnapshotProperty[] = household.properties
    .filter((p) => {
      const active = p.startMonth <= m && (p.endMonth === null || m <= p.endMonth);
      if (!active) return false;
      if (projectionMonth) return (projectionMonth.propertyValuesCents[p.id] ?? 0) > 0;
      return true;
    })
    .map((p) => {
      const valueCents = projectionMonth?.propertyValuesCents[p.id] ?? p.openingValueCents;
      const mortgageBalanceCents =
        projectionMonth && p.mortgageLiabilityId !== null
          ? projectionMonth.liabilityBalancesCents[p.mortgageLiabilityId] ?? 0
          : null;
      return {
        id: p.id,
        ownerId: p.ownerId,
        causedByEventId: p.causedByEventId,
        startMonth: p.startMonth,
        valueCents,
        mortgageBalanceCents,
        equityCents: mortgageBalanceCents === null ? null : valueCents - mortgageBalanceCents,
      };
    });

  let balances: SnapshotBalances | null = null;
  if (projectionMonth) {
    balances = {
      accounts: Object.entries(projectionMonth.accountBalancesCents).map(
        ([id, balanceCents]) => ({ id, balanceCents }),
      ),
      liabilities: Object.entries(projectionMonth.liabilityBalancesCents).map(
        ([id, balanceCents]) => ({ id, balanceCents }),
      ),
      netWorthNominalCents: projectionMonth.netWorthNominalCents,
      isInsolvent: projectionMonth.isInsolvent,
    };
  }

  return { month: m, persons, children, income, expenses, liabilities, properties, balances };
}

/**
 * Convenience wrapper: replay `ledger` (seeded with `opts.initialPersons`) and
 * snapshot it. Goes through the same {@link interpretLedger} interpreter as the
 * projection, so it cannot interpret events differently.
 */
export function snapshotAt(
  ledger: Ledger,
  month: number,
  opts?: {
    initialPersons?: readonly SimPerson[];
    projection?: ProjectionSeries;
  },
): HouseholdSnapshot {
  const base: LedgerBaseConfig = {
    horizonMonths: opts?.projection ? opts.projection.months.length - 1 : 0,
    annualInflationRate: 0,
    initialPersons: opts?.initialPersons,
  };
  return buildSnapshot(interpretLedger(ledger, base), month, opts?.projection);
}
