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
import { lifeExpectancyEndMonthExclusive, personActiveWindow } from "../job/personActiveWindow";

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
 * The partner the household has at `month`, or `null` when it has none — the single answer every
 * partner-offering surface reads, now that there can only ever be one.
 *
 * Death-aware, which is what separates it from {@link membersAt}: a membership's `endMonth`
 * records a separation and nothing else, so a partner who died years ago is still "a member" by
 * that reckoning. Asking through {@link personActiveWindow} composes the two the way every
 * person-scoped rule in the simulation already does, so a form cannot offer to separate from
 * somebody the projection has already buried.
 *
 * Base members are excluded by their infinite start: the primary is not somebody the primary is
 * partnered with.
 */
export function activePartnerAt(
  household: Household,
  month: number,
  nowYear: number | undefined,
): Person | null {
  for (const membership of household.memberships) {
    if (!Number.isFinite(membership.startMonth)) continue;
    const active = personActiveWindow(membership, nowYear);
    if (active.startMonth <= month && month < active.endMonthExclusive) return membership.person;
  }
  return null;
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
  nowYear?: number,
): HouseholdSnapshot {
  const m = clampMonth(month, projection);

  const members = membersAt(household, m);
  /**
   * Whose holdings this cross-section is entitled to show. The whole-plan views are deliberately
   * omniscient — a partner still to come appears on the timeline, in the job projections and in
   * every chart drawn over the horizon — but a DATED snapshot answers "who is in this household
   * now", so a future partner's accounts must not sit in it at $0 years before they arrive, and a
   * separated partner's must leave with them.
   *
   * Read from {@link membersAt}, which closes a membership on SEPARATION alone. Death is not a
   * departure: a partner who died left their accounts to the household, so they stay in the
   * snapshot exactly as the projection still carries them.
   */
  const memberIds = new Set(members.map((p) => p.id));
  /**
   * Who the household is composed of at `m` — the roster it READS as, which is not the same
   * question as whose holdings it may show above. Death closes a life without closing a
   * membership, so a partner years dead was still listed here as a current member, beside the
   * accounts they left behind: the panel said the household had two people in it and the money
   * of two people, when it had the money of two people and one person.
   *
   * Filtered here and not in {@link membersAt}, because the estate is exactly what the wider
   * answer protects — narrowing that one would take the deceased's accounts out of the snapshot
   * along with their name, which is the opposite of what happens when somebody dies.
   *
   * Without a `nowYear` there is no calendar to date a death against, and
   * {@link lifeExpectancyEndMonthExclusive} answers `Infinity` — every member reads as living,
   * which is what a caller that never supplied one has always seen.
   */
  const persons = members.filter((p) => m < lifeExpectancyEndMonthExclusive(p, nowYear));
  /**
   * Everyone the household has EVER held a membership for. An owner outside it is not a member
   * who has left or not yet arrived — it is a holding whose owner this roster cannot speak for
   * (a ledger snapshotted without its people), and hiding it would be inventing an absence.
   */
  const knownIds = new Set(household.memberships.map((mem) => mem.person.id));
  const present = (ownerId: string): boolean => memberIds.has(ownerId) || !knownIds.has(ownerId);
  const ownedByMember = (owners: readonly string[]): boolean =>
    owners.length === 0 || owners.some(present);
  const accountOwners = new Map(household.accounts.map((a) => [a.id, a.owners as readonly string[]]));
  const liabilityOwner = new Map(household.liabilities.map((l) => [l.id as string, l.ownerId as string]));

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
      if (!present(l.ownerId)) return false;
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
      if (!active || !present(p.ownerId)) return false;
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
      accounts: Object.entries(projectionMonth.accountBalancesCents)
        .filter(([id]) => ownedByMember(accountOwners.get(id) ?? []))
        .map(([id, balanceCents]) => ({ id, balanceCents })),
      liabilities: Object.entries(projectionMonth.liabilityBalancesCents)
        .filter(([id]) => {
          const owner = liabilityOwner.get(id);
          return owner === undefined || present(owner);
        })
        .map(([id, balanceCents]) => ({ id, balanceCents })),
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
