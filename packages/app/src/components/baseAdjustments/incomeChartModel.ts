/**
 * The pure view model behind {@link import("./incomeChart").IncomeChart}: everything the chart
 * needs to draw that is NOT Recharts itself. Collapses the source bands for the chosen mode,
 * assigns each a stable colour, maps rows onto the shared months-from-now axis, formats the
 * insolvency marker as an age, and writes the assistive-technology summary. Testable without
 * rendering React; the component owns only local UI state, event handling and JSX.
 */

import { formatDollars } from "../../format";
import { toAxisX } from "../monthAxis";
import {
  describeIncomeGap,
  incomeBandsForMode,
  type IncomeBasis,
  type IncomeChartData,
  type IncomeMode,
  type IncomeMonthRow,
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
function formatAgeAtMonth(currentAge: number, month: number): string {
  const wholeYears = Math.floor(month / 12);
  const quarter = Math.round((month - wholeYears * 12) / 3); // 0..4
  const age = currentAge + wholeYears + (quarter === 4 ? 1 : 0);
  return `${age}${quarter === 4 ? "" : QUARTERS[quarter]}`;
}

/** Identifies a moment on the nonvisual table unambiguously, regardless of `currentAge`. */
function formatMomentLabel(currentAge: number, month: number): string {
  return `age ${formatAgeAtMonth(currentAge, month)} (month ${month})`;
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

/**
 * How far a band or the spending need must drift from the last figure this table actually
 * REPORTED before the drift is worth another row group — 5%, a move a listener would notice
 * stated aloud.
 *
 * Load-bearing, and the reason it is measured against the last reported figure rather than
 * against the previous month: under inflation nearly every figure moves by a few cents every
 * single month, so an exact `!==` made a "moment" of 563 of a 660-month projection's months.
 * That is the thing {@link IncomeChartModel.accessibleMoments} promises never to be — a table
 * read out month by month is not an alternative to the chart, it is the raw series — and it
 * put ~13,500 DOM nodes on the page, 98% of this panel's total.
 *
 * Diffing against the previous month with a threshold would instead lose the drift entirely:
 * 0.25% a month never clears 5%, so a wage that doubles over thirty years would go unmentioned.
 * Carrying the last REPORTED figure makes the threshold cumulative, so a steady ramp is sampled
 * about every 20 months and the trajectory survives at a size someone can listen to.
 */
const MATERIAL_DRIFT_FRACTION = 0.05;

/**
 * Has `after` moved materially from the last figure reported for this signal? Guarded against a
 * zero baseline, which only arises where the caller has already classified the month as a band
 * beginning.
 */
function driftsMaterially(lastReported: number, after: number): boolean {
  const scale = Math.max(Math.abs(lastReported), 1);
  return Math.abs(after - lastReported) / scale >= MATERIAL_DRIFT_FRACTION;
}

/**
 * Which months are worth a screen-reader user's attention, and why: the projection's start,
 * any month a band begins or ends, any month a band's amount or the spending need has drifted
 * materially ({@link MATERIAL_DRIFT_FRACTION}) from the figure last read out, the first savings
 * withdrawal, and insolvency. Walks `view.rows` once against the same clamped-at-0 band figures
 * the stacked chart draws, so the moments never quote a value the chart doesn't.
 *
 * A band beginning or ending is structural and always surfaces, however small the amount: those
 * are the transitions the chart's shape is made of. Only the continuous middle is sampled.
 */
function buildAccessibleMoments(
  view: { readonly rows: readonly IncomeMonthRow[] },
  bands: readonly IncomeChartBand[],
  currentAge: number,
  firstSavingsDrawdownMonth: number | null,
  firstInsolventMonth: number | null,
): IncomeChartAccessibleMoment[] {
  const reasonsByMonth = new Map<number, string[]>();
  const addReason = (month: number, reason: string) => {
    const list = reasonsByMonth.get(month);
    if (list) list.push(reason);
    else reasonsByMonth.set(month, [reason]);
  };

  // The last figure actually READ OUT for each signal, not the previous month's — see
  // {@link MATERIAL_DRIFT_FRACTION}. A signal's baseline moves only when that signal itself
  // surfaces a moment, so each samples its own drift independently of the others.
  const lastReportedBand = new Map<string, number>();
  let lastReportedSpendingNeedCents: number | null = null;
  let prevClamped: Record<string, number> | null = null;
  /**
   * Months to state purely as the "before" of a discrete change — see {@link addDiscreteReason}.
   * Collected during the walk and resolved after it, so a context month is never itself treated
   * as a change and can never pull in a context month of its own.
   */
  const contextMonths = new Set<number>();
  /**
   * A change that happens AT a month rather than drifting towards it: a band beginning or ending,
   * the first savings withdrawal, insolvency. Each also marks the preceding month for inclusion.
   *
   * Without that, the row group announcing a change is the first month of the NEW value, and the
   * old one is whatever was last read out — up to a sampling interval earlier. Social Security
   * beginning at month 384 was heard against a reading from month 372, which is not a before-and-
   * after so much as two unrelated facts. A discrete change is exactly where the adjacent pair
   * carries the meaning, so it is the one place worth spending a row group to guarantee it.
   */
  const addDiscreteReason = (month: number, reason: string) => {
    addReason(month, reason);
    contextMonths.add(month - 1);
  };
  for (const [i, r] of view.rows.entries()) {
    const clamped = clampBandsForStack(r.centsBySource);
    if (i === 0) {
      addReason(r.month, "Projection starts");
      // The opening row states every figure, so it is the baseline each signal drifts from.
      for (const b of bands) lastReportedBand.set(b.id, clamped[b.id] ?? 0);
      lastReportedSpendingNeedCents = r.spendingNeedCents;
    }
    if (prevClamped !== null) {
      for (const b of bands) {
        const before = prevClamped[b.id] ?? 0;
        const after = clamped[b.id] ?? 0;
        if (before === after) continue;
        // Structural first: a band appearing or disappearing is always a moment, and it resets
        // the baseline to the figure the listener was just given either way.
        if (before === 0) addDiscreteReason(r.month, `${b.label} begins`);
        else if (after === 0) addDiscreteReason(r.month, `${b.label} ends`);
        else if (driftsMaterially(lastReportedBand.get(b.id) ?? before, after)) {
          addReason(r.month, `${b.label} changes`);
        } else continue;
        lastReportedBand.set(b.id, after);
      }
    }
    if (
      lastReportedSpendingNeedCents !== null &&
      driftsMaterially(lastReportedSpendingNeedCents, r.spendingNeedCents)
    ) {
      addReason(r.month, "Spending need changes");
      lastReportedSpendingNeedCents = r.spendingNeedCents;
    }
    prevClamped = clamped;
  }
  // Named explicitly even when a band-begins reason already covers the same month, so the
  // reason a screen-reader user hears never depends on which mode collapsed which band.
  if (firstSavingsDrawdownMonth !== null) {
    addDiscreteReason(firstSavingsDrawdownMonth, "First savings withdrawal");
  }
  if (firstInsolventMonth !== null) addDiscreteReason(firstInsolventMonth, "Plan becomes insolvent");

  const rowByMonth = new Map(view.rows.map((r) => [r.month, r]));
  // Resolved last, and only where the month is real and says nothing already: a context row
  // exists to be the "before" of the row group after it, so one that displaced a reason of its
  // own, or that named a month the projection never ran, would be worse than none.
  for (const month of contextMonths) {
    if (rowByMonth.has(month) && !reasonsByMonth.has(month)) {
      addReason(month, "Last reading before the change");
    }
  }
  return [...reasonsByMonth.keys()]
    .sort((a, b) => a - b)
    .map((month) => {
      const row = rowByMonth.get(month);
      const clamped = clampBandsForStack(row?.centsBySource ?? {});
      const totalCents = bands.reduce((sum, b) => sum + (clamped[b.id] ?? 0), 0);
      return {
        label: formatMomentLabel(currentAge, month),
        reason: reasonsByMonth.get(month)!.join("; "),
        sources: bands.map((b) => ({ label: b.label, amount: formatDollars(clamped[b.id] ?? 0) })),
        totalCashFlow: formatDollars(totalCents),
        spendingNeed: formatDollars(row?.spendingNeedCents ?? 0),
      };
    });
}

export interface IncomeChartBand {
  readonly id: string;
  readonly label: string;
  readonly color: string;
}

/** One source line within a moment of the chart's nonvisual table: label and formatted dollars. */
export interface IncomeChartAccessibleRow {
  readonly label: string;
  readonly amount: string;
}

/**
 * One point in time worth reading out: the projection's start, a band beginning, ending or
 * changing, a spending-need change, the first savings withdrawal, or insolvency. `label`
 * identifies *when* (age and month, so it stands alone without the moments around it); `reason`
 * says *why* this moment was picked, so a screen-reader user isn't left to infer it from the
 * numbers.
 */
export interface IncomeChartAccessibleMoment {
  readonly label: string;
  readonly reason: string;
  readonly sources: readonly IncomeChartAccessibleRow[];
  /** This moment's total cash across all bands, formatted — broader than "income": drawdowns count. */
  readonly totalCashFlow: string;
  /** This moment's spending need (expenses + liability payments), formatted. */
  readonly spendingNeed: string;
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
  /**
   * The chart as a nonvisual table of the moments worth reading out — never every month, and
   * never rendered as raw ids or cents — so a screen-reader user gets the shape of the
   * projection over time, not one unlabeled starting snapshot. See {@link
   * IncomeChartAccessibleMoment}.
   */
  readonly accessibleMoments: readonly IncomeChartAccessibleMoment[];
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

  const accessibleMoments = buildAccessibleMoments(
    view,
    bands,
    currentAge,
    data.firstSavingsDrawdownMonth,
    data.firstInsolventMonth,
  );

  return {
    bands,
    rows,
    spendingNeedKey: SPENDING_NEED_KEY,
    lastX,
    brokeMonth,
    brokeAgeLabel: brokeMonth === null ? null : formatAgeAtMonth(currentAge, brokeMonth),
    gapSummary: summary,
    accessibleSummary: summary
      ? `Monthly cash flows vs. spending. ${summary}`
      : "Monthly cash flows vs. spending — cash flow continues across the whole horizon.",
    accessibleMoments,
  };
}
