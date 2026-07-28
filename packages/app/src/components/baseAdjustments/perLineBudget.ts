/**
 * Monthly spending graph data ("Base + Adjustments") — a projection series turned into the
 * rows a spending chart draws: one band per thing the household's money goes to, at what it
 * cost each month.
 *
 * The bands are the engine's {@link SpendingItem}s, read straight off each month's flows —
 * authored budget lines, the health line, whatever the timeline added, each liability's
 * scheduled payment — already labelled, categorized, and tagged with provenance. No
 * reassembly here: stitching the picture from three shapes (per-line map, household series,
 * liability labels) is how whole categories of real spending went missing from the chart.
 * One read model, one list, one total.
 *
 * The three {@link BandKind}s differ only in how they are *drawn* — authored budget in the
 * tiered earth palette, other obligations in slate, debt service in rust — so the eye can
 * tell chosen from carried spending without the chart pretending they are different
 * quantities. A month's stack totals exactly the obligation the income graph's
 * spending-need line plots.
 *
 * It deliberately does **not** ration a tight month across the priority order: the
 * simulator never skips spending, so drawing a line below its amount would depict money the
 * household did spend. The point where the plan stops working is insolvency, reported as
 * its own fact ({@link insolventFromMonth}) rather than by quietly shrinking discretionary
 * bands — what to cut is the user's call.
 *
 * Pure, with no charting-library dependency, so it is unit-testable in node.
 */

import type { ProjectionSeries, SpendingItem } from "@finley/engine";

/**
 * How a band is drawn. Not a re-classification of the engine's categories — a three-way
 * read of {@link SpendingItem.sourceKind} for the palette: money the user authors as lines
 * here, money simply owed, and everything else the household carries (health, a child's
 * cost, an added expense).
 */
export type BandKind = "line" | "other" | "debt";

function bandKindOf(item: SpendingItem): BandKind {
  if (item.sourceKind === "budgetLine") return "line";
  return item.sourceKind === "liability" ? "debt" : "other";
}

/** One band on the graph: a spending item's identity, carried across every month. */
export interface ChartBand {
  /** The item's own id — stable across months, so a band keeps its identity. */
  readonly id: string;
  readonly label: string;
  readonly kind: BandKind;
  /** Whether the underlying fact is editable as a line (the item's own flag). */
  readonly editable: boolean;
}

/** One month's per-band row for the chart. */
export interface PerLineMonthRow {
  readonly month: number;
  /** This month's cost per band, keyed by band id (absent for a band inactive then). */
  readonly centsByLine: Readonly<Record<string, number>>;
  readonly totalCents: number;
}

/** The whole chart's derived data plus the plan-health summary. */
export interface PerLineBudgetData {
  readonly rows: readonly PerLineMonthRow[];
  /**
   * First month the cascade exhausted savings AND credit — where the plan stops being
   * financeable. `null` when it holds across the whole horizon.
   */
  readonly insolventFromMonth: number | null;
  /**
   * The bands tracked, so the chart renders one series per band, in the order the engine
   * reports them (budget lines as authored, then the rest, then debts).
   */
  readonly lines: readonly ChartBand[];
}

/**
 * Spending chart data from a projection series. One row per *flowed* month (month 0 is the
 * flow-free opening snapshot, so it is skipped), each carrying every item's amount and their
 * total — the engine's own `totalSpendingCents`, not a re-sum.
 *
 * A band exists only for an item that carries money *somewhere* in the horizon: a stream
 * costing nothing all the way through (no health line, a paid-off loan that never charged)
 * would otherwise drag an empty band and an unexplained tooltip row through forty years.
 */
export function buildPerLineBudgetData(series: ProjectionSeries): PerLineBudgetData {
  const rows: PerLineMonthRow[] = [];
  let insolventFromMonth: number | null = null;
  // First-seen band per id, and whether it ever carried money.
  const bands = new Map<string, ChartBand>();
  const carriesMoney = new Set<string>();

  for (const m of series.months) {
    if (m.isInsolvent && insolventFromMonth === null) insolventFromMonth = m.month;

    const flows = m.flows;
    if (flows === undefined) continue; // month 0 / any flow-free snapshot

    const centsByLine: Record<string, number> = {};
    for (const item of flows.spendingItems) {
      centsByLine[item.id] = item.amountCents;
      if (item.amountCents > 0) carriesMoney.add(item.id);
      if (!bands.has(item.id)) {
        bands.set(item.id, {
          id: item.id,
          label: item.label,
          kind: bandKindOf(item),
          editable: item.editable,
        });
      }
    }
    rows.push({ month: m.month, centsByLine, totalCents: flows.totalSpendingCents });
  }

  const lines = [...bands.values()].filter((band) => carriesMoney.has(band.id));
  const drawn = new Set(lines.map((band) => band.id));
  return {
    insolventFromMonth,
    lines,
    // Rows carry exactly the bands the chart draws: a stream dropped for costing nothing
    // must not leave a trail of zeros in the row data (also the hidden mirror screen readers
    // and tests read).
    rows:
      drawn.size === bands.size
        ? rows
        : rows.map((row) => ({
            ...row,
            centsByLine: Object.fromEntries(
              Object.entries(row.centsByLine).filter(([id]) => drawn.has(id)),
            ),
          })),
  };
}

/** Year (1-based) of an absolute month, for a human-facing "Year N" label. */
function yearOf(month: number): number {
  return Math.floor(month / 12) + 1;
}

/**
 * A one-line summary for the a11y label / status line, or `null` when the plan finances the
 * whole budget across the horizon. Names the year the plan runs out rather than a line to
 * cut — which spending to give up is the user's decision, not the graph's.
 */
export function describeInsolvency(data: PerLineBudgetData): string | null {
  if (data.insolventFromMonth === null) return null;
  return (
    `From Year ${yearOf(data.insolventFromMonth)} this budget is no longer financeable — ` +
    `savings and credit are exhausted. Something has to change.`
  );
}
