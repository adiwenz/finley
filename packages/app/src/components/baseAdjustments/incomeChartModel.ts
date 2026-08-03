/**
 * The pure view model behind {@link import("./incomeChart").IncomeChart}: everything the chart
 * needs to draw that is NOT Recharts itself. Collapses the source bands for the chosen mode,
 * assigns each a stable colour, maps rows onto the shared months-from-now axis, formats the
 * insolvency marker as an age, and writes the assistive-technology summary. Testable without
 * rendering React; the component owns only local UI state, event handling and JSX.
 */

import { toAxisX } from "../monthAxis";
import {
  describeIncomeGap,
  incomeBandsForMode,
  type IncomeBasis,
  type IncomeChartData,
  type IncomeMode,
  type IncomeSourceBand,
} from "./incomeChartData";

/** Namespaced so the row's spending-need key can't clash with a source id. */
export const SPENDING_NEED_KEY = "__spendingNeed";

// Wages: one blue step per job, cooler than the budget chart's earth tones so the two charts
// read as different quantities.
const WAGE_COLORS = ["#2f5d7c", "#4a8db5", "#7fb3ce", "#a8cbdd"];
// The government benefit: one teal step per CLAIMANT, so "whose benefit starts when" is
// readable off the chart. Out of the blue family: the old steel blue (#6b93b8) sat ΔE 4.0 from
// the second job's wage band (dataviz palette checker), near-indistinguishable from a paycheck.
// These two steps separate at ΔE 17.9 normal / 17.8 CVD — past the ≥15 / ≥8 floors — while
// staying inside the chart's muted register.
const BENEFIT_COLORS = ["#2f6b66", "#5aa39a"];
// Living off savings is NOT income — a muted earth family, set apart from the cool income
// bands above it.
const DRAW_COLORS = ["#c6b784", "#b08968", "#9c8459", "#d8c79a"];

/**
 * Each family is walked in band order, which is stable across the Simple/Advanced toggle — so a
 * person's benefit keeps its colour when the view changes.
 */
function colorsForBands(sources: readonly IncomeSourceBand[]): Map<string, string> {
  const colors = new Map<string, string>();
  let wage = 0;
  let benefit = 0;
  let draw = 0;
  for (const s of sources) {
    if (s.category === "wages") colors.set(s.id, WAGE_COLORS[wage++ % WAGE_COLORS.length]!);
    else if (s.category === "governmentRetirementBenefit") {
      colors.set(s.id, BENEFIT_COLORS[benefit++ % BENEFIT_COLORS.length]!);
    } else colors.set(s.id, DRAW_COLORS[draw++ % DRAW_COLORS.length]!);
  }
  return colors;
}

/** The household's age at `month`, to the nearest quarter-year: "69¾". */
const QUARTERS = ["", "¼", "½", "¾"] as const;
function formatBrokeAge(currentAge: number, month: number): string {
  const wholeYears = Math.floor(month / 12);
  const quarter = Math.round((month - wholeYears * 12) / 3); // 0..4
  const age = currentAge + wholeYears + (quarter === 4 ? 1 : 0);
  return `${age}${quarter === 4 ? "" : QUARTERS[quarter]}`;
}

/**
 * The engine reports a signed per-source net cash flow — negative when a source's tax + deferral
 * exceed its cash inflow — but a negative segment renders below the axis and distorts the stack.
 * This is the ONLY place the clamp lives; the engine and the data model keep the honest signed
 * figures. No-op on the gross basis.
 */
function clampBandsForStack(centsBySource: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, cents] of Object.entries(centsBySource)) out[id] = Math.max(0, cents);
  return out;
}

export interface IncomeChartBand {
  readonly id: string;
  readonly label: string;
  readonly color: string;
}

/**
 * One Recharts datum: the month on the shared axis, the spending-need under {@link
 * SPENDING_NEED_KEY}, and one stacked (clamped-at-0) figure per band id. Flat so Recharts reads
 * each series by `dataKey` directly.
 */
export type IncomeChartRow = Readonly<Record<string, number>>;

export interface IncomeChartModelOptions {
  readonly mode: IncomeMode;
  /** Take-home (default) is the only basis comparable to the spending-need line; gross is pre-tax. */
  readonly basis?: IncomeBasis;
  /** Names benefit bands by earner when two are on the chart; otherwise a source keeps its label. */
  readonly personNames?: ReadonlyMap<string, string>;
  /** The household's age at month 0, which turns the insolvency month into an age. */
  readonly currentAge?: number;
}

export interface IncomeChartModel {
  readonly bands: readonly IncomeChartBand[];
  readonly rows: readonly IncomeChartRow[];
  readonly spendingNeedKey: string;
  /** Axis x of the last flowed month, for the chart's domain. */
  readonly lastX: number;
  /** First insolvent month (raw, not axis-mapped), or `null` on a solvent plan. */
  readonly brokeMonth: number | null;
  /** The insolvency month as the household's age ("69¾"), or `null` when solvent. */
  readonly brokeAgeLabel: string | null;
  /**
   * The income-gap sentence, or `null` when income covers spending throughout — the raw copy the
   * chart shows as a visible hint. {@link accessibleSummary} wraps it for the a11y label.
   */
  readonly gapSummary: string | null;
  /** A human-readable sentence for the chart's accessible label. Never empty. */
  readonly accessibleSummary: string;
}

/**
 * Fold {@link IncomeChartData} for the chosen mode/basis into render-ready bands and rows. Pure:
 * no memoisation and no React — the caller memoises if a hot render path needs it.
 */
export function buildIncomeChartModel(
  data: IncomeChartData,
  options: IncomeChartModelOptions,
): IncomeChartModel {
  const { mode, basis = "takeHome", personNames = new Map<string, string>(), currentAge = 0 } = options;
  const view = incomeBandsForMode(data, mode, basis, personNames);
  const colors = colorsForBands(view.sources);
  const bands: IncomeChartBand[] = view.sources.map((s) => ({
    id: s.id,
    label: s.label,
    color: colors.get(s.id)!,
  }));
  // This is a chart of FLOWS, so the axis' today slot stays empty — no flow has run at "now" —
  // and the bands start at end-of-month-0. The slot is still reserved, so this chart's x lines
  // up with the net-worth charts above it.
  const rows: IncomeChartRow[] = view.rows.map((r) => ({
    month: toAxisX(r.month),
    [SPENDING_NEED_KEY]: r.spendingNeedCents,
    ...clampBandsForStack(r.centsBySource),
  }));
  const lastX = toAxisX(view.rows[view.rows.length - 1]?.month ?? 0);
  const brokeMonth = data.firstInsolventMonth;
  const summary = describeIncomeGap(data);

  return {
    bands,
    rows,
    spendingNeedKey: SPENDING_NEED_KEY,
    lastX,
    brokeMonth,
    brokeAgeLabel: brokeMonth === null ? null : formatBrokeAge(currentAge, brokeMonth),
    gapSummary: summary,
    accessibleSummary: summary
      ? `Monthly cash flows vs. spending. ${summary}`
      : "Monthly cash flows vs. spending — cash flow continues across the whole horizon.",
  };
}
