/**
 * Snapshot — the household cross-section as of one month.
 *
 * Built from the same {@link Household} the projection consumes, so presence (who/what is
 * active) can never drift from the projection's stocks. The requested month is clamped
 * once to the projection horizon, and that clamped month drives every field.
 */

import type { Cents } from "../money/money";
import type { TaxCategory } from "../money/cashFlowSeries";
import type { LiabilityKind } from "../liability/liability";
import type { ChildId, LiabilityId, PersonId, PropertyId, SeriesId } from "../plan/ids";
import type { Child, SeriesRole } from "../ledger/eventTypes";
import type { LedgerBaseConfig } from "../ledger/ledgerBase";
import type { Household } from "../ledger/household";
import { interpretLedger } from "../ledger/interpret";
import type { Ledger } from "../ledger/ledger";
import type { Person } from "../plan/person";
import type { ProjectionSeries } from "./simulate";

export interface SnapshotChild extends Child {
  readonly id: ChildId;
  readonly ageMonths: number;
}

export interface SnapshotSeries {
  readonly id: SeriesId;
  readonly ownerId: PersonId;
  readonly seriesType: "income" | "expense";
  readonly role: SeriesRole;
  /** Monthly rate at the snapshot month, growth applied — a *flow*. */
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
 * `valueCents` and `mortgageBalanceCents` come from the projection month; `equityCents` is
 * value − mortgage. Without a projection, value falls back to the opening value and
 * mortgage/equity are unknown (null).
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
  /** Null once the plan is insolvent — see {@link ProjectionMonth}. */
  readonly netWorthNominalCents: Cents | null;
  readonly isInsolvent: boolean;
}

export interface HouseholdSnapshot {
  readonly month: number;
  readonly persons: readonly Person[];
  readonly children: readonly SnapshotChild[];
  readonly income: readonly SnapshotSeries[];
  readonly expenses: readonly SnapshotSeries[];
  readonly liabilities: readonly SnapshotLiability[];
  readonly properties: readonly SnapshotProperty[];
  /** Null unless a projection was supplied. */
  readonly balances: SnapshotBalances | null;
}

function clampMonth(month: number, projection?: ProjectionSeries): number {
  const count = projection?.months.length ?? 0;
  if (count === 0) return month;
  return Math.max(0, Math.min(month, count - 1));
}

/**
 * The people in the household as of `month` (end-of-month convention): present from
 * `startMonth` and not yet separated (`endMonth > month`). The single authoritative answer
 * to "who is in the household at M" — any people-offering UI reads through this.
 */
export function membersAt(household: Household, month: number): Person[] {
  return household.memberships
    .filter((mem) => mem.startMonth <= month && (mem.endMonth === null || mem.endMonth > month))
    .map((mem) => mem.person);
}

/**
 * Household cross-section as of `month` (end-of-month convention: an event at month M is
 * applied at M). Presence is derived from `household`; balances (stocks) are read from
 * `projection` when supplied.
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
      // With a projection, "active" means a positive balance at the month, so a paid-off
      // liability disappears. Without one, fall back to the contractual origination month.
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

  // Present from purchase, not yet sold. With a projection, one worth 0 (sold or
  // pre-purchase) drops out and the value/mortgage/equity come from the projection month.
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
 * Replay `ledger` (seeded with `opts.initialPersons`) and snapshot it, through the same
 * {@link interpretLedger} the projection uses, so it cannot interpret events differently.
 */
export function snapshotAt(
  ledger: Ledger,
  month: number,
  opts?: {
    initialPersons?: readonly Person[];
    projection?: ProjectionSeries;
  },
): HouseholdSnapshot {
  const base: LedgerBaseConfig = {
    // `months.length` IS the horizon now that the opening snapshot rides a separate field
    // rather than occupying months[0].
    horizonMonths: opts?.projection ? opts.projection.months.length : 0,
    annualInflationRate: 0,
    initialPersons: opts?.initialPersons,
  };
  return buildSnapshot(interpretLedger(ledger, base), month, opts?.projection);
}
