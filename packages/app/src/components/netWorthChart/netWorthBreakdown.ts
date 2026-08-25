/**
 * Net-worth *breakdown* data — companion to the total-only {@link
 * import("./netWorthChart").NetWorthChart}. One band per account, plus property values and
 * the debts owed against them. The chart's three views are cuts of this one dataset:
 * **accounts** (asset accounts only), **assets** (+ property values), **networth** (assets
 * stacked up, liabilities *down*, so the signed total equals the nominal net worth the other
 * chart draws).
 *
 * A band's KIND comes from which series map its id sits in (`accountBalancesCents` /
 * `propertyValuesCents` / `liabilityBalancesCents`); names and order arrive as plain metadata
 * ({@link BreakdownMeta}), so this module depends on neither the `SimAccount` class nor any
 * engine construction path.
 */

import type { ProjectionMonth, ProjectionSeries } from "@finley/engine";
import { toAxisX } from "../monthAxis";
import { chartXMax, stoppedSpan, type StoppedSpan } from "./chartSpan";

/** Drives colour, stacking order, and sign. */
export type BreakdownBandKind = "account" | "property" | "liability";

export interface BandMeta {
  readonly id: string;
  readonly label: string;
  /** Whose holding this is. Absent → unattributed, and shown only in the combined view. */
  readonly ownerId?: string;
}

/**
 * `accounts` is ordered — its sequence is the stacking order. `propertyLabels` /
 * `liabilityLabels` are id→label lookups (order insignificant); an id missing a label falls
 * back to a humanized form of the id.
 */
export interface BreakdownMeta {
  readonly accounts: readonly BandMeta[];
  readonly liabilityLabels?: Readonly<Record<string, string>>;
  readonly propertyLabels?: Readonly<Record<string, string>>;
  /**
   * Owner by liability/property id — the account side carries its own on {@link BandMeta}.
   * An id absent here is unattributed, which is not the same as unowned: the engine's synthetic
   * last-resort card is owned by the household rather than by either person, and belongs in the
   * combined view alone.
   */
  readonly ownerById?: Readonly<Record<string, string>>;
}

export interface BreakdownBand {
  readonly id: string;
  readonly label: string;
  readonly kind: BreakdownBandKind;
  readonly ownerId?: string;
}

export interface BreakdownMonthRow {
  readonly month: number;
  /**
   * Cents by band id — a positive magnitude for every kind, INCLUDING a liability's owed
   * balance; the chart negates those for the net-worth view, so the same rows serve the
   * assets-only view unchanged.
   */
  readonly centsById: Readonly<Record<string, number>>;
}

export interface NetWorthBreakdownData {
  /**
   * Balances as they stand NOW, before any flow — {@link
   * import("@finley/engine").ProjectionSeries.opening} in the same band shape as a row. This
   * is a balance sheet, so "today" is a real column: the chart draws it at the axis' reserved
   * today slot, one month left of `rows[0]`'s end-of-month-0.
   */
  readonly opening: BreakdownMonthRow;
  readonly rows: readonly BreakdownMonthRow[];
  /**
   * Every band non-zero at some month, ordered accounts (in the meta's order) → properties →
   * liabilities. Always-zero bands are dropped, so no dead legend entry appears.
   */
  readonly bands: readonly BreakdownBand[];
  /** True when any property value is ever present — gates the "assets" view/button. */
  readonly hasProperties: boolean;
  /** True when any liability is ever owed — gates the "net worth" view/button. */
  readonly hasLiabilities: boolean;
  /**
   * The distinct people holding a drawn band, in stacking order — the owner cuts the chart can
   * offer. Fewer than two means there is nothing to compare and no owner toggle to show.
   */
  readonly owners: readonly string[];
  /** Nominal net worth (assets − liabilities) at the last charted month; null if no rows. */
  readonly terminalNetWorthCents: number | null;
  /**
   * Highest nominal net worth over the charted period; null if no rows. A better headline than
   * the terminal value for a plan that decumulates through retirement, whose last self-funded
   * month can be near zero.
   */
  readonly peakNetWorthCents: number | null;
  /**
   * The axis' right edge — the whole plan, not just the rows. Shared with the total net-worth
   * chart above via {@link import("./chartSpan").chartXMax} so the two never end at different
   * years while drawing the same plan.
   */
  readonly xMax: number;
  /** The unsimulated tail of a blocked plan, shaded like the chart above; null otherwise. */
  readonly stopped: StoppedSpan | null;
}

/**
 * Fallback label for an id with no metadata. The app mints property/liability ids as
 * `home-<n>` / `mortgage-<n>` (see the home-purchase form), so Title-case the leading token:
 * `home-3` → "Home".
 */
function humanizeId(id: string): string {
  const head = id.split("-")[0] ?? id;
  return head.charAt(0).toUpperCase() + head.slice(1);
}

function netWorthOf(row: BreakdownMonthRow, bands: readonly BreakdownBand[]): number {
  let total = 0;
  for (const band of bands) {
    const value = row.centsById[band.id] ?? 0;
    total += band.kind === "liability" ? -value : value;
  }
  return total;
}

/**
 * Account vs. property vs. liability, and presence at all, are read from the series' three
 * balance maps — so an account the plan defines but never funds is dropped, not drawn as a
 * flat-zero band.
 *
 * Rows stop at the first insolvent month, as the total net-worth chart does. Every liability
 * charts below zero as debt, including the engine's synthetic last-resort borrowing once the
 * caller labels it.
 */
/**
 * The highest nominal net worth a given set of bands ever reaches. Pass every band for the
 * household's figure, or one person's for theirs — the whole point of taking bands rather than
 * reading a precomputed total is that a person's cut has a peak of its own, and printing the
 * household's under their name claims a partner peaked at a figure their own chart never
 * reaches.
 *
 * Today is a charted point, so it competes for the peak — for a plan that decumulates from day
 * one, "now" IS the high-water mark, and reporting month 0's slightly lower figure would be a
 * number the chart visibly contradicts.
 */
export function peakNetWorthOf(
  data: { readonly opening: BreakdownMonthRow; readonly rows: readonly BreakdownMonthRow[] },
  bands: readonly BreakdownBand[],
): number | null {
  if (data.rows.length === 0) return null;
  return Math.max(netWorthOf(data.opening, bands), ...data.rows.map((r) => netWorthOf(r, bands)));
}

export function buildNetWorthBreakdown(
  series: ProjectionSeries,
  meta: BreakdownMeta,
  horizonMonths?: number,
): NetWorthBreakdownData {
  const accountOrder = meta.accounts.map((a) => a.id);
  const accountLabel = new Map(meta.accounts.map((a) => [a.id, a.label]));
  const accountOwner = new Map(
    meta.accounts.flatMap((a) => (a.ownerId === undefined ? [] : [[a.id, a.ownerId] as const])),
  );
  /** Undefined rather than a placeholder, so an unattributed band is filtered out, not mis-filed. */
  const ownerOf = (id: string): string | undefined => accountOwner.get(id) ?? meta.ownerById?.[id];
  const withOwner = <T extends { readonly id: string }>(band: T) => {
    const ownerId = ownerOf(band.id);
    return ownerId === undefined ? band : { ...band, ownerId };
  };

  const rows: BreakdownMonthRow[] = [];
  const accountIds = new Set<string>();
  const propertyIds = new Set<string>();
  const liabilityIds = new Set<string>();
  // Which ids ever hold a non-zero value — the drop-if-always-zero filter for the bands.
  const nonZero = new Set<string>();

  /** One month's three balance maps folded into a band row, registering ids as it goes. */
  const rowFor = (m: ProjectionMonth): BreakdownMonthRow => {
    const centsById: Record<string, number> = {};
    const collect = (source: Readonly<Record<string, number>>, into: Set<string>) => {
      for (const [id, cents] of Object.entries(source)) {
        into.add(id);
        centsById[id] = cents;
        if (cents !== 0) nonZero.add(id);
      }
    };
    collect(m.accountBalancesCents, accountIds);
    collect(m.propertyValuesCents, propertyIds);
    collect(m.liabilityBalancesCents, liabilityIds);
    return { month: m.month, centsById };
  };

  // Opening first, so a band that exists TODAY but is gone by month 0 — a savings account a
  // Year-0 purchase drains outright — still earns its band rather than being dropped as
  // always-zero and leaving a hole in the today column.
  const opening = rowFor(series.opening);

  for (const m of series.months) {
    if (m.isInsolvent) break;
    rows.push(rowFor(m));
  }

  // Meta-ordered accounts first, then any series-only account ids (defensive — the sim runs
  // the same accounts), then properties, then liabilities. Always-zero ids dropped.
  const orderedAccountIds = [
    ...accountOrder.filter((id) => accountIds.has(id) && nonZero.has(id)),
    ...[...accountIds].filter((id) => !accountOrder.includes(id) && nonZero.has(id)),
  ];
  const accountBands: BreakdownBand[] = orderedAccountIds.map((id) =>
    withOwner({ id, label: accountLabel.get(id) ?? humanizeId(id), kind: "account" as const }),
  );
  const propertyBands: BreakdownBand[] = [...propertyIds]
    .filter((id) => nonZero.has(id))
    .map((id) => withOwner({ id, label: meta.propertyLabels?.[id] ?? humanizeId(id), kind: "property" as const }));
  const liabilityBands: BreakdownBand[] = [...liabilityIds]
    .filter((id) => nonZero.has(id))
    .map((id) => withOwner({ id, label: meta.liabilityLabels?.[id] ?? humanizeId(id), kind: "liability" as const }));

  const bands = [...accountBands, ...propertyBands, ...liabilityBands];
  const lastRow = rows[rows.length - 1];
  const peakNetWorthCents = peakNetWorthOf({ opening, rows }, bands);

  // The axis spans the plan, not the rows — which stop early at a block (the series is truncated)
  // and at insolvency (dropped above). Same span and same shaded tail as the chart above it.
  const xMax = chartXMax(toAxisX(rows[rows.length - 1]?.month ?? 0), horizonMonths);

  return {
    opening,
    rows,
    bands,
    hasProperties: propertyBands.length > 0,
    hasLiabilities: liabilityBands.length > 0,
    // In band order, so the owner toggle lists people the way the stack reads. Distinct, and
    // only those actually holding a drawn band — a partner who brought nothing offers no cut.
    owners: [...new Set(bands.flatMap((b) => (b.ownerId === undefined ? [] : [b.ownerId])))],
    terminalNetWorthCents: lastRow ? netWorthOf(lastRow, bands) : null,
    peakNetWorthCents,
    xMax,
    stopped: stoppedSpan(series, xMax),
  };
}
