/**
 * Monthly income graph data — the income-side companion to {@link
 * import("./perLineBudget")} ("Base + Adjustments", issue #71), reporting income
 * **by source** (issue #99).
 *
 * Income is deliberately NOT a budget line: spending is authored as `Plan.budgetLines`,
 * while income rides jobs and passive streams (§6/§17). So it gets its own graph rather
 * than a band on the budget chart — and that graph is what makes the shape of a
 * retirement legible: earnings stop at the last paycheck, there is a gap until the
 * claiming age, and the government benefit picks up from there.
 *
 * Bands are the engine's per-source flows (`ProjectionMonthFlows.incomeSources`), not
 * tax-category buckets, so each band names its own source: *which* job pays, *which*
 * account a decumulation draw drains. The previous version banded by {@link
 * import("@finley/engine").ProjectionMonthFlows.incomeByCategoryCents} — a tax
 * classification — which forced hedged labels ("Pre-tax withdrawals" covered every
 * pre-tax account) and collapsed two jobs into one band; issue #99 replaced that.
 *
 * It also surfaces the **savings drawdown**: while cash savings cover the retirement
 * gap the engine reports a `savingsDrawdown` source rather than nothing, so "living off
 * savings" reads as its own band instead of a misleading flat zero.
 *
 * Pure: the app passes the series in and this derives the chart shape, with no charting
 * library dependency (so it is unit-testable in node).
 */

import type { IncomeSourceCategory, ProjectionSeries } from "@finley/engine";

/** One income band on the chart: a source, how to name it, and its provenance. */
export interface IncomeSourceBand {
  /** The engine's stable `sourceId` — the band's identity across months. */
  readonly id: string;
  readonly label: string;
  /** Provenance category, driving band colour and display order. */
  readonly category: IncomeSourceCategory;
}

/** One month's income row for the chart. */
export interface IncomeMonthRow {
  readonly month: number;
  /** Gross cash this month, keyed by source id. */
  readonly centsBySource: Readonly<Record<string, number>>;
  readonly totalCents: number;
  /**
   * The month's spending need — the obligations the income (and any drawdown) has to
   * cover: non-liability expenses + scheduled liability payments (the exact
   * `sharedObligationCents` the §5.0 waterfall and the decumulation gap use). Drawn as a
   * reference line so the chart reads "is what's coming in enough". 0 when flows are
   * absent (month 0).
   */
  readonly spendingNeedCents: number;
}

export interface IncomeChartData {
  readonly rows: readonly IncomeMonthRow[];
  /** Only the sources that actually carry money somewhere, in display order. */
  readonly sources: readonly IncomeSourceBand[];
  /**
   * First month with no income AND no savings drawdown — a genuine nothing, which under
   * a solvent plan should not happen (the gap is now a drawdown band). `null` otherwise.
   */
  readonly firstMonthWithNoIncome: number | null;
  /** First month funded by drawing down cash savings, or `null` if that never happens. */
  readonly firstSavingsDrawdownMonth: number | null;
  /**
   * First month the §5.1 shortfall cascade ran out of credit and the plan stopped being
   * financeable ({@link import("@finley/engine").ProjectionMonth.isInsolvent}) — the
   * "broke" marker. `null` if the plan stays solvent across the whole horizon.
   */
  readonly firstInsolventMonth: number | null;
}

/** Which view of the income chart is showing (issue #99 follow-up). */
export type IncomeMode = "simple" | "advanced";

/**
 * Stable stacking order by provenance category (bottom of the stack → top). The two
 * genuine income kinds sit at the base — earned **wages**, then the **government
 * benefit** — and the whole "living off savings" family stacks *above* them as one
 * contiguous group: every account draw (by tax friction) and the cash `savingsDrawdown`
 * last. Grouping all the drawdown categories after the benefit is what keeps Simple and
 * Advanced consistent: Simple's single "Living off savings" band and Advanced's several
 * draw bands both read as a cap above Social Security, rather than some draws below it and
 * the cash drawdown above. Anything unrecognised sorts to the very end.
 */
const CATEGORY_ORDER: readonly IncomeSourceCategory[] = [
  "wages",
  "governmentRetirementBenefit",
  "ordinaryIncome",
  "capitalGains",
  "taxExempt",
  "savingsDrawdown",
];

function categoryRank(category: string): number {
  const i = CATEGORY_ORDER.indexOf(category as IncomeSourceCategory);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

/**
 * Build the income chart data from a projection series. One row per *flowed* month
 * (month 0 is the flow-free opening snapshot, §4.6, so it is skipped). Sources that
 * carry nothing across the whole horizon are dropped, so a plan with no benefit or no
 * drawdown does not carry an empty band and an unexplained legend entry.
 */
export function buildIncomeChartData(series: ProjectionSeries): IncomeChartData {
  const rows: IncomeMonthRow[] = [];
  // First-seen label/category per source id, and whether it ever carried money.
  const seen = new Map<string, IncomeSourceBand>();
  const order: string[] = [];
  let firstMonthWithNoIncome: number | null = null;
  let firstSavingsDrawdownMonth: number | null = null;
  let firstInsolventMonth: number | null = null;

  for (const m of series.months) {
    const sources = m.flows?.incomeSources;
    if (sources === undefined) continue; // month 0 / any flow-free snapshot

    const centsBySource: Record<string, number> = {};
    let totalCents = 0;
    for (const s of sources) {
      if (s.grossCents === 0) continue;
      centsBySource[s.sourceId] = (centsBySource[s.sourceId] ?? 0) + s.grossCents;
      totalCents += s.grossCents;
      if (!seen.has(s.sourceId)) {
        seen.set(s.sourceId, { id: s.sourceId, label: s.label, category: s.category });
        order.push(s.sourceId);
      }
      if (s.category === "savingsDrawdown" && firstSavingsDrawdownMonth === null) {
        firstSavingsDrawdownMonth = m.month;
      }
    }
    if (totalCents === 0 && firstMonthWithNoIncome === null) firstMonthWithNoIncome = m.month;
    if (m.isInsolvent && firstInsolventMonth === null) firstInsolventMonth = m.month;
    // Obligations = expenses + scheduled liability payments (the waterfall's
    // `sharedObligationCents`, the same figure the decumulation gap covers).
    const spendingNeedCents = (m.flows?.expensesCents ?? 0) + (m.flows?.liabilityPaymentsCents ?? 0);
    rows.push({ month: m.month, centsBySource, totalCents, spendingNeedCents });
  }

  const sources = order
    .map((id) => seen.get(id)!)
    // Sort by category order, ties broken by first-appearance (already in `order`).
    .sort((a, b) => categoryRank(a.category) - categoryRank(b.category));

  return { rows, sources, firstMonthWithNoIncome, firstSavingsDrawdownMonth, firstInsolventMonth };
}

/** The stable band ids the Simple view collapses onto (asymmetric — wages stay per job). */
const SIMPLE_SOCIAL_SECURITY_ID = "social-security";
const SIMPLE_LIVING_OFF_SAVINGS_ID = "living-off-savings";

/**
 * The Simple-view band a source folds into. Wages keep their own identity (each job is
 * its own band — "which job pays" is what a person recognises); the government benefit
 * collapses to one "Social Security" band; and EVERY drawdown — the liquid-buffer
 * `savingsDrawdown` and every asset-sale draw (capital-gains / ordinary / tax-exempt) —
 * folds into a single "Living off savings" band. The Advanced view keeps them separate,
 * and issue #122 will later split that drawdown into gain vs. returned principal.
 */
function simpleBandOf(band: IncomeSourceBand): IncomeSourceBand {
  if (band.category === "wages") return band;
  if (band.category === "governmentRetirementBenefit") {
    return { id: SIMPLE_SOCIAL_SECURITY_ID, label: "Social Security", category: "governmentRetirementBenefit" };
  }
  return { id: SIMPLE_LIVING_OFF_SAVINGS_ID, label: "Living off savings", category: "savingsDrawdown" };
}

/**
 * The bands and per-month rows to draw for a given {@link IncomeMode}. `advanced` is the
 * full per-source data unchanged (every job, every account draw, the benefit, the
 * drawdown). `simple` collapses via {@link simpleBandOf} — re-keying each row's cash onto
 * the collapsed band ids and summing — so "most people" see three ideas (wages, Social
 * Security, living off savings) instead of seven. Pure: the spending-need line and totals
 * ride through untouched.
 */
export function incomeBandsForMode(
  data: IncomeChartData,
  mode: IncomeMode,
): { readonly sources: readonly IncomeSourceBand[]; readonly rows: readonly IncomeMonthRow[] } {
  if (mode === "advanced") return { sources: data.sources, rows: data.rows };

  const bandForSource = new Map<string, IncomeSourceBand>();
  const collapsed = new Map<string, IncomeSourceBand>();
  const order: string[] = [];
  for (const s of data.sources) {
    const band = simpleBandOf(s);
    bandForSource.set(s.id, band);
    if (!collapsed.has(band.id)) {
      collapsed.set(band.id, band);
      order.push(band.id);
    }
  }
  const sources = order
    .map((id) => collapsed.get(id)!)
    .sort((a, b) => categoryRank(a.category) - categoryRank(b.category));

  const rows = data.rows.map((r) => {
    const centsBySource: Record<string, number> = {};
    for (const [srcId, cents] of Object.entries(r.centsBySource)) {
      const bandId = bandForSource.get(srcId)?.id ?? srcId;
      centsBySource[bandId] = (centsBySource[bandId] ?? 0) + cents;
    }
    return { month: r.month, centsBySource, totalCents: r.totalCents, spendingNeedCents: r.spendingNeedCents };
  });
  return { sources, rows };
}

/** Year (1-based) of an absolute month, for a human-facing "Year N" label. */
function yearOf(month: number): number {
  return Math.floor(month / 12) + 1;
}

/**
 * A one-line summary for the a11y label / status line, or `null` when income runs
 * continuously with no savings drawdown. Names the retirement gap for what it actually
 * is — a stretch lived off savings, drawn as its own band — rather than the old,
 * misleading "no income" framing (issue #99).
 */
export function describeIncomeGap(data: IncomeChartData): string | null {
  if (data.firstSavingsDrawdownMonth !== null) {
    return (
      `From Year ${yearOf(data.firstSavingsDrawdownMonth)} you're living off savings — ` +
      `the drawdown band is spending covered by cash, not income.`
    );
  }
  if (data.firstMonthWithNoIncome !== null) {
    return (
      `No income and no savings left from Year ${yearOf(data.firstMonthWithNoIncome)} — ` +
      `nothing is covering spending here.`
    );
  }
  return null;
}
