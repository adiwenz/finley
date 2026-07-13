/**
 * Snapshot — the household cross-section as of one month (§10.8).
 *
 * Built from the same {@link ReplayedHousehold} the projection consumes, so
 * presence (who/what is active) can never drift from the projection's stocks
 * (§1, §14). The requested month is clamped once (to the projection horizon)
 * and that single clamped month drives every field — people, children, flows,
 * liabilities, balances, and the returned `month` (§2).
 */

import type { Cents } from "../money";
import type { TaxCategory } from "../cashFlowSeries";
import type { LiabilityKind } from "../liability";
import type { ChildId, LiabilityId, PersonId, SeriesId } from "../ids";
import type { Child, SeriesRole } from "../ledger/eventTypes";
import type { LedgerBaseConfig, ReplayedHousehold } from "../ledger/replayState";
import { replayHousehold } from "../ledger/replay";
import type { Ledger } from "../ledger/ledger";
import type { Person, ProjectionSeries } from "./simulate";

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

export interface SnapshotBalances {
  readonly accounts: readonly BalanceEntry[];
  /** Amounts owed, positive. */
  readonly liabilities: readonly BalanceEntry[];
  readonly netWorthNominalCents: Cents;
  readonly isInsolvent: boolean;
}

export interface HouseholdSnapshot {
  readonly month: number;
  readonly persons: readonly Person[];
  readonly children: readonly SnapshotChild[];
  readonly income: readonly SnapshotSeries[];
  readonly expenses: readonly SnapshotSeries[];
  readonly liabilities: readonly SnapshotLiability[];
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
 * Household cross-section as of `month` (end-of-month convention, §10.8): an
 * event at month M is applied at M. Presence is derived from `household`;
 * balances (stocks) are read from `projection` when supplied.
 */
export function buildSnapshot(
  household: ReplayedHousehold,
  month: number,
  projection?: ProjectionSeries,
): HouseholdSnapshot {
  const m = clampMonth(month, projection);

  const persons = household.memberships
    .filter((mem) => mem.startMonth <= m && (mem.endMonth === null || mem.endMonth > m))
    .map((mem) => mem.person);

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

  return { month: m, persons, children, income, expenses, liabilities, balances };
}

/**
 * Convenience wrapper: replay `ledger` (seeded with `opts.initialPersons`) and
 * snapshot it. Goes through the same {@link replayHousehold} interpreter as the
 * projection, so it cannot interpret events differently.
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
    horizonMonths: opts?.projection ? opts.projection.months.length - 1 : 0,
    annualInflationRate: 0,
    initialPersons: opts?.initialPersons,
  };
  return buildSnapshot(replayHousehold(ledger, base), month, opts?.projection);
}
