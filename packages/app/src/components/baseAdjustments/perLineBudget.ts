/**
 * Monthly spending graph data: one band per thing the household's money goes to.
 *
 * Bands are the engine's {@link SpendingItem}s, read straight off each month's flows, already
 * labelled, categorized and tagged with provenance — no reassembly from the per-line map,
 * household series and liability labels, which is how whole categories of real spending went
 * missing from the chart.
 *
 * A month's stack totals exactly the obligation the income graph's spending-need line plots;
 * the simulator never skips spending, so a band is never shortened to ration a tight month.
 * Insolvency is its own fact ({@link insolventFromMonth}).
 */

import type { ProjectionSeries, SpendingItem } from "@finley/engine";

/**
 * A palette-level read of {@link SpendingItem.sourceKind} — money the user authors as lines
 * here, money simply owed, everything else. Not a re-classification of the engine's categories.
 */
export type BandKind = "line" | "other" | "debt";

function bandKindOf(item: SpendingItem): BandKind {
  if (item.sourceKind === "budgetLine") return "line";
  return item.sourceKind === "liability" ? "debt" : "other";
}

/** A spending item's identity, stable across every month. */
export interface ChartBand {
  readonly id: string;
  readonly label: string;
  readonly kind: BandKind;
  /** Whether the underlying fact is editable as a budget line. */
  readonly editable: boolean;
}

export interface PerLineMonthRow {
  readonly month: number;
  /** Cost per band, keyed by band id; absent for a band inactive that month. */
  readonly centsByLine: Readonly<Record<string, number>>;
  readonly totalCents: number;
}

export interface PerLineBudgetData {
  readonly rows: readonly PerLineMonthRow[];
  /** First month the cascade exhausted savings AND credit; null when the plan holds throughout. */
  readonly insolventFromMonth: number | null;
  /** In the order the engine reports them: budget lines as authored, then the rest, then debts. */
  readonly lines: readonly ChartBand[];
}

/**
 * One row per flowed month — every entry in `months` is processed now, so month 0 is the
 * first row — each carrying every item's amount and the engine's own `totalSpendingCents`,
 * not a re-sum.
 *
 * A band exists only for an item that carries money somewhere in the horizon; otherwise a
 * stream costing nothing throughout drags an empty band and an unexplained tooltip row through
 * forty years.
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
    if (flows === undefined) continue; // defensive: a flow-free snapshot carries no spending

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
    // Rows carry exactly the bands the chart draws: a dropped stream must not leave zeros in
    // the row data (also the hidden mirror screen readers and tests read).
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

/** 1-based year of an absolute month, for a human-facing "Year N" label. */
function yearOf(month: number): number {
  return Math.floor(month / 12) + 1;
}

/** One-line summary for the a11y label; null when the plan finances the whole budget. */
export function describeInsolvency(data: PerLineBudgetData): string | null {
  if (data.insolventFromMonth === null) return null;
  return (
    `From Year ${yearOf(data.insolventFromMonth)} this budget is no longer financeable — ` +
    `savings and credit are exhausted. Something has to change.`
  );
}
