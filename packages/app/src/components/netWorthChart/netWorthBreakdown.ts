/**
 * Net-worth *breakdown* data — the companion to the total-only {@link
 * import("./netWorthChart").NetWorthChart}. Where that chart draws one nominal and one
 * real net-worth curve, this splits the same nominal net worth into its parts over time:
 * one band per account (cash savings, brokerage, retirement, and each goal fund by name),
 * plus property values and the debts owed against them.
 *
 * The three views the chart toggles between are all cuts of this one dataset:
 *  - **accounts** — just the asset accounts, the "savings accounts over time" view;
 *  - **assets**   — accounts + property values (all still added up);
 *  - **networth** — assets stacked up and liabilities stacked *down*, so the stack's
 *    signed total equals the nominal net worth the other chart draws.
 *
 * A band's KIND comes from which series map its id sits in (`accountBalancesCents` /
 * `propertyValuesCents` / `liabilityBalancesCents`), so this never has to be told what an id
 * is — only how to NAME and ORDER it. Names/order arrive as plain metadata ({@link
 * BreakdownMeta}) that the caller assembles from the engine's account descriptors and the
 * household, so this module depends on neither the `SimAccount` class nor any engine
 * construction path — it is pure and unit-testable in node. Balances stay raw magnitudes
 * here (a liability is its positive owed amount); the chart is what signs liabilities
 * negative for the net-worth view.
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
 * The names and order the breakdown should use. `accounts` is ordered — its sequence is the
 * accounts' stacking order. `propertyLabels` / `liabilityLabels` are id→label lookups
 * (order among them is not significant); any id missing a label falls back to a humanized
 * form of the id.
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
   * Value in cents by band id — a positive magnitude for every kind, INCLUDING a
   * liability's owed balance. The chart negates liabilities for the net-worth view; the
   * data keeps them positive so the same rows serve the assets-only view unchanged.
   */
  readonly centsById: Readonly<Record<string, number>>;
}

export interface NetWorthBreakdownData {
  readonly rows: readonly BreakdownMonthRow[];
  /**
   * Every band that carries a non-zero value at some month, ordered accounts (in the
   * meta's account order) → properties → liabilities. A band that is zero across the whole
   * horizon is dropped, so no dead legend entry appears (as the tax chart drops
   * always-zero sources).
   */
  readonly bands: readonly BreakdownBand[];
  /** True when any property value is ever present — gates the "assets" view/button. */
  readonly hasProperties: boolean;
  /** True when any liability is ever owed — gates the "net worth" view/button. */
  readonly hasLiabilities: boolean;
  /** Nominal net worth (assets − liabilities) at the last charted month; null if no rows. */
  readonly terminalNetWorthCents: number | null;
  /**
   * The highest nominal net worth reached over the charted period; null if no rows. A more
   * representative headline than the terminal value for a plan that accumulates and then
   * decumulates through retirement (whose last self-funded month can be near zero).
   */
  readonly peakNetWorthCents: number | null;
}

/**
 * A fallback display label for an id with no metadata — the app mints property/liability
 * ids as `home-<n>` / `mortgage-<n>` (see the home-purchase form), so read the leading token
 * and Title-case it: `home-3` → "Home". Accounts always carry a label via the meta and do
 * not rely on this.
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
 * Build the net-worth breakdown from a projection series and naming metadata. Which ids are
 * accounts vs. properties vs. liabilities is read from the series' three balance maps;
 * presence is read from the series too, so an account the plan defines but never funds is
 * dropped rather than drawn as a flat-zero band.
 *
 * The breakdown is the household's balance sheet *while the plan self-funds*. Rows stop at
 * the first month the plan is insolvent OR draws on a liability the caller didn't name — the
 * engine's synthetic last-resort credit card, a modelling device rather than a debt the
 * household holds. Past that point the composition story is over, and the sibling total
 * net-worth chart takes over with its own insolvency handling. This also keeps the synthetic
 * card from ever appearing as a band or denting the reported net worth.
 */
export function buildNetWorthBreakdown(
  series: ProjectionSeries,
  meta: BreakdownMeta,
): NetWorthBreakdownData {
  const accountOrder = meta.accounts.map((a) => a.id);
  const accountLabel = new Map(meta.accounts.map((a) => [a.id, a.label]));
  const isNamedLiability = (id: string) => meta.liabilityLabels?.[id] !== undefined;

  const rows: BreakdownMonthRow[] = [];
  const accountIds = new Set<string>();
  const propertyIds = new Set<string>();
  const liabilityIds = new Set<string>();
  // Which ids ever hold a non-zero value — the drop-if-always-zero filter for the bands.
  const nonZero = new Set<string>();

  for (const m of series.months) {
    if (m.isInsolvent) break; // curves end at insolvency, as the total net-worth chart does
    // The first draw on an unnamed liability (the synthetic last-resort card) marks the end
    // of the self-funded period — stop before it so it never becomes a band.
    const drawsUnnamedDebt = Object.entries(m.liabilityBalancesCents).some(
      ([id, cents]) => cents !== 0 && !isNamedLiability(id),
    );
    if (drawsUnnamedDebt) break;

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

  // Accounts in the meta's order first, then any series-only account ids (defensive — the
  // sim runs the same accounts), then properties, then liabilities. Always-zero ids dropped.
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
  // Only named (household) liabilities band — an unnamed one would have truncated the rows
  // above, so this filter is defensive belt-and-suspenders.
  const liabilityBands: BreakdownBand[] = [...liabilityIds]
    .filter((id) => nonZero.has(id) && isNamedLiability(id))
    .map((id) => ({ id, label: meta.liabilityLabels![id]!, kind: "liability" }));

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
