/**
 * Net-worth *breakdown* data — companion to the total-only {@link
 * import("./netWorthChart").NetWorthChart}. Splits the same nominal net worth into parts
 * over time: one band per account (cash savings, brokerage, retirement, each goal fund by
 * name), plus property values and the debts owed against them.
 *
 * The chart's three views are all cuts of this one dataset:
 *  - **accounts** — asset accounts only, the "savings accounts over time" view;
 *  - **assets**   — accounts + property values (still all added up);
 *  - **networth** — assets stacked up, liabilities stacked *down*, so the stack's signed
 *    total equals the nominal net worth the other chart draws.
 *
 * A band's KIND comes from which series map its id sits in (`accountBalancesCents` /
 * `propertyValuesCents` / `liabilityBalancesCents`), so this is never told what an id is —
 * only how to NAME and ORDER it. Names/order arrive as plain metadata
 * ({@link BreakdownMeta}) assembled by the caller, so this module depends on neither the
 * `SimAccount` class nor any engine construction path — pure and unit-testable in node.
 * Balances stay raw magnitudes (a liability is its positive owed amount); the chart signs
 * liabilities negative for the net-worth view.
 */

import type { ProjectionSeries } from "@finley/engine";

/** Which side of the balance sheet a band sits on — drives colour, order, and sign. */
export type BreakdownBandKind = "account" | "property" | "liability";

/** Id + display label for one named entity (an account, property, or liability). */
export interface BandMeta {
  readonly id: string;
  readonly label: string;
}

/**
 * Names and order for the breakdown. `accounts` is ordered — its sequence is the stacking
 * order. `propertyLabels` / `liabilityLabels` are id→label lookups (order insignificant);
 * an id missing a label falls back to a humanized form of the id.
 */
export interface BreakdownMeta {
  readonly accounts: readonly BandMeta[];
  readonly liabilityLabels?: Readonly<Record<string, string>>;
  readonly propertyLabels?: Readonly<Record<string, string>>;
}

/** One stacked band: a component of net worth, how to name it, and its kind. */
export interface BreakdownBand {
  /** The engine's stable id — an account id, a property id, or a liability id. */
  readonly id: string;
  readonly label: string;
  readonly kind: BreakdownBandKind;
}

/** One month's row: every band's value in cents, keyed by band id. */
export interface BreakdownMonthRow {
  readonly month: number;
  /**
   * Cents by band id — a positive magnitude for every kind, INCLUDING a liability's owed
   * balance. The chart negates liabilities for the net-worth view; keeping them positive
   * lets the same rows serve the assets-only view unchanged.
   */
  readonly centsById: Readonly<Record<string, number>>;
}

export interface NetWorthBreakdownData {
  readonly rows: readonly BreakdownMonthRow[];
  /**
   * Every band non-zero at some month, ordered accounts (in the meta's order) →
   * properties → liabilities. Always-zero bands are dropped so no dead legend entry
   * appears, as the tax chart drops always-zero sources.
   */
  readonly bands: readonly BreakdownBand[];
  /** True when any property value is ever present — gates the "assets" view/button. */
  readonly hasProperties: boolean;
  /** True when any liability is ever owed — gates the "net worth" view/button. */
  readonly hasLiabilities: boolean;
  /** Nominal net worth (assets − liabilities) at the last charted month; null if no rows. */
  readonly terminalNetWorthCents: number | null;
  /**
   * Highest nominal net worth over the charted period; null if no rows. A better headline
   * than the terminal value for a plan that accumulates then decumulates through
   * retirement, whose last self-funded month can be near zero.
   */
  readonly peakNetWorthCents: number | null;
}

/**
 * Fallback label for an id with no metadata. The app mints property/liability ids as
 * `home-<n>` / `mortgage-<n>` (see the home-purchase form), so Title-case the leading
 * token: `home-3` → "Home". Accounts always carry a label via the meta.
 */
function humanizeId(id: string): string {
  const head = id.split("-")[0] ?? id;
  return head.charAt(0).toUpperCase() + head.slice(1);
}

/** Signed nominal net worth of a row: assets add, liabilities subtract. */
function netWorthOf(row: BreakdownMonthRow, bands: readonly BreakdownBand[]): number {
  let total = 0;
  for (const band of bands) {
    const value = row.centsById[band.id] ?? 0;
    total += band.kind === "liability" ? -value : value;
  }
  return total;
}

/**
 * Build the breakdown from a projection series and naming metadata. Account vs. property
 * vs. liability, and presence at all, are read from the series' three balance maps — so an
 * account the plan defines but never funds is dropped, not drawn as a flat-zero band.
 *
 * Rows stop at the first insolvent month, as the total net-worth chart does. Every
 * liability is charted below zero as debt — including the engine's synthetic last-resort
 * borrowing once the caller labels it — so a plan living on borrowed money shows the debt
 * piling up rather than truncating where it starts.
 */
export function buildNetWorthBreakdown(
  series: ProjectionSeries,
  meta: BreakdownMeta,
): NetWorthBreakdownData {
  const accountOrder = meta.accounts.map((a) => a.id);
  const accountLabel = new Map(meta.accounts.map((a) => [a.id, a.label]));

  const rows: BreakdownMonthRow[] = [];
  const accountIds = new Set<string>();
  const propertyIds = new Set<string>();
  const liabilityIds = new Set<string>();
  // Which ids ever hold a non-zero value — the drop-if-always-zero filter for the bands.
  const nonZero = new Set<string>();

  for (const m of series.months) {
    if (m.isInsolvent) break; // curves end at insolvency, as the total net-worth chart does

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
    rows.push({ month: m.month, centsById });
  }

  // Meta-ordered accounts first, then any series-only account ids (defensive — the sim
  // runs the same accounts), then properties, then liabilities. Always-zero ids dropped.
  const orderedAccountIds = [
    ...accountOrder.filter((id) => accountIds.has(id) && nonZero.has(id)),
    ...[...accountIds].filter((id) => !accountOrder.includes(id) && nonZero.has(id)),
  ];
  const accountBands: BreakdownBand[] = orderedAccountIds.map((id) => ({
    id,
    label: accountLabel.get(id) ?? humanizeId(id),
    kind: "account",
  }));
  const propertyBands: BreakdownBand[] = [...propertyIds]
    .filter((id) => nonZero.has(id))
    .map((id) => ({ id, label: meta.propertyLabels?.[id] ?? humanizeId(id), kind: "property" }));
  // Every liability, labelled from the meta or humanized — a missing label affects only
  // the name, never whether it charts.
  const liabilityBands: BreakdownBand[] = [...liabilityIds]
    .filter((id) => nonZero.has(id))
    .map((id) => ({ id, label: meta.liabilityLabels?.[id] ?? humanizeId(id), kind: "liability" }));

  const bands = [...accountBands, ...propertyBands, ...liabilityBands];
  const lastRow = rows[rows.length - 1];
  const peakNetWorthCents = rows.length
    ? Math.max(...rows.map((r) => netWorthOf(r, bands)))
    : null;

  return {
    rows,
    bands,
    hasProperties: propertyBands.length > 0,
    hasLiabilities: liabilityBands.length > 0,
    terminalNetWorthCents: lastRow ? netWorthOf(lastRow, bands) : null,
    peakNetWorthCents,
  };
}
