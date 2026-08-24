/**
 * The pure view model behind {@link import("./cashFlowChart").CashFlowChart}: everything the
 * chart needs to draw that is NOT Recharts itself. Folds the bands for the chosen view and mode,
 * assigns each a stable colour, maps rows onto the shared months-from-now axis, formats the
 * insolvency marker as an age, and writes the assistive-technology summary. Testable without
 * rendering React; the component owns only local UI state, event handling and JSX.
 *
 * No clamp lives here any more. Every band on both sides is a positive quantity by construction
 * ({@link import("./cashFlowChartData")}), so there is nothing to clamp and nothing to charge on
 * pro rata — the one figure allowed to be negative is the net line, which stacks against nothing.
 */

import { formatDollars } from "../../format";
import { toDisplayCents } from "./displayShares";
import { toAxisX } from "../monthAxis";
import {
  TAX_OUTFLOW_CATEGORY,
  TAX_REFUND_CATEGORY,
  cashFlowBandsForView,
  describeCashFlowGap,
  type CashFlowBand,
  type CashFlowChartData,
  type CashFlowMode,
  type CashFlowView,
  type CashFlowViewRow,
} from "./cashFlowChartData";

/** Namespaced so the row's own keys can't clash with a band id. */
export const SPENDING_NEED_KEY = "__spendingNeed";
/** The net view's single series. Signed, and the only signed figure the chart draws. */
export const NET_KEY = "__net";

// Wages: one blue step per job, cooler than the budget chart's earth tones so the two charts
// read as different quantities.
const WAGE_COLORS = ["#2f5d7c", "#4a8db5", "#7fb3ce", "#a8cbdd"];
// The government benefit: one teal step per CLAIMANT, so "whose benefit starts when" is
// readable off the chart. Out of the blue family: the old steel blue (#6b93b8) sat ΔE 4.0 from
// the second job's wage band (dataviz palette checker), near-indistinguishable from a paycheck.
// These two steps separate at ΔE 17.9 normal / 17.8 CVD — past the ≥15 / ≥8 floors — while
// staying inside the chart's muted register.
const BENEFIT_COLORS = ["#2f6b66", "#5aa39a"];
// A tax refund is cash arriving, but from a filing rather than from work — one muted violet of
// its own, so it is not mistaken for either family it sits beside.
const TAX_REFUND_COLOR = "#7a6a8c";
// Anything on the inflow side the categories above don't name.
const OTHER_INFLOW_COLORS = ["#c6b784", "#b08968", "#9c8459", "#d8c79a"];

// Tax leaving the household: a muted violet family, keyed to the refund's colour above — the
// same money, in the direction it usually travels.
const TAX_OUTFLOW_COLORS = ["#5c4a63", "#7a6a8c", "#9b8dab"];
// Spending, in the budget chart's own earth register so the two charts agree about what
// spending looks like.
const SPEND_COLORS: Readonly<Record<string, readonly string[]>> = {
  needs: ["#1f3a2e", "#3f7d5f", "#63a183"],
  healthcare: ["#5c6b73", "#7d8f96", "#95a3a8"],
  wants: ["#b5761f", "#c99a3f", "#d9b775"],
  savings: ["#8a8570", "#a39d85"],
  debtService: ["#9c5b39", "#b23a2e", "#7d4a30"],
  // One person's share of the shared lines — the needs green, since needs are most of what it
  // stands in for, one step muted so it never reads as the household's own "Needs" band.
  sharedSpending: ["#2f5c47"],
};
const OTHER_OUTFLOW_COLORS = ["#8a8570", "#a39d85", "#6f6b5c"];

/**
 * Each family is walked in band order, which is stable across the Simple/Advanced toggle — so a
 * person's benefit, or a budget line, keeps its colour when the view changes.
 */
function colorsForBands(bands: readonly CashFlowBand[]): Map<string, string> {
  const colors = new Map<string, string>();
  const taken = new Map<string, number>();
  const next = (family: string, palette: readonly string[]): string => {
    const i = taken.get(family) ?? 0;
    taken.set(family, i + 1);
    return palette[i % palette.length]!;
  };
  for (const b of bands) {
    if (b.category === TAX_REFUND_CATEGORY) colors.set(b.id, TAX_REFUND_COLOR);
    else if (b.category === TAX_OUTFLOW_CATEGORY) colors.set(b.id, next("tax", TAX_OUTFLOW_COLORS));
    else if (b.category === "wages") colors.set(b.id, next("wage", WAGE_COLORS));
    else if (b.category === "governmentRetirementBenefit") {
      colors.set(b.id, next("benefit", BENEFIT_COLORS));
    } else if (SPEND_COLORS[b.category] !== undefined) {
      colors.set(b.id, next(b.category, SPEND_COLORS[b.category]!));
    } else colors.set(b.id, next("other", OTHER_INFLOW_COLORS.concat(OTHER_OUTFLOW_COLORS)));
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
 * How large a MONTH-OVER-MONTH step has to be to count as something happening rather than the
 * plan drifting — 5%, which no inflation-driven figure reaches.
 *
 * The whole filter turns on this being a step against the previous month rather than a drift
 * against some earlier baseline. At 3% a year every band and the spending need move about 0.25%
 * every single month, so the exact `!==` this replaced made a "moment" of 563 of a 660-month
 * projection's months — a table read out month by month, which is not an alternative to the
 * chart but the raw series, and 13,500 DOM nodes, 98% of this panel's total.
 *
 * The drift itself is deliberately NOT sampled here. This table is the narrative of what happens
 * to the plan — a job ending, a benefit starting, the money running out. The trajectory between
 * those points is what the chart draws, and the month-by-month detail is already reachable
 * without sight through the editor below it, whose Month field resolves any month on demand and
 * in more detail than a static table could carry.
 */
const DISCRETE_STEP_FRACTION = 0.05;

/**
 * Did this month step, rather than drift? Guarded against a zero baseline, which only arises
 * where the caller has already classified the month as a band beginning.
 */
function steps(before: number, after: number): boolean {
  return Math.abs(after - before) / Math.max(Math.abs(before), 1) >= DISCRETE_STEP_FRACTION;
}

/**
 * Which months are worth a screen-reader user's attention, and why: the projection's start, any
 * month a band begins or ends, any month a band's amount or the spending need steps
 * ({@link DISCRETE_STEP_FRACTION}), the first savings withdrawal, insolvency — and the month
 * before each of those, so a change is heard as a before-and-after. Walks `view.rows` once
 * against the same clamped-at-0 band figures the stacked chart draws, so the moments never
 * quote a value the chart doesn't.
 *
 * A band beginning or ending is structural and surfaces whatever the amount — but only once the
 * amount is one the reader can SEE. A transition invisible in every figure beside it is not a
 * moment in the plan, it is a moment in the arithmetic.
 */
function buildAccessibleMoments(
  view: { readonly rows: readonly CashFlowViewRow[] },
  bands: readonly CashFlowChartBand[],
  currentAge: number,
  drawdown: { readonly month: number | null; readonly reason: string },
  firstInsolventMonth: number | null,
): CashFlowChartAccessibleMoment[] {
  const reasonsByMonth = new Map<number, string[]>();
  const addReason = (month: number, reason: string) => {
    const list = reasonsByMonth.get(month);
    if (list) list.push(reason);
    else reasonsByMonth.set(month, [reason]);
  };

  let prevDrawn: Readonly<Record<string, number>> | null = null;
  let prevSpendingNeedCents: number | null = null;
  /**
   * Months to state purely as the "before" of a discrete change — see {@link addDiscreteReason}.
   * Collected during the walk and resolved after it, so a context month is never itself treated
   * as a change and can never pull in a context month of its own.
   */
  const contextMonths = new Set<number>();
  /**
   * A change that happens AT a month rather than drifting towards it. Each also marks the
   * preceding month for inclusion.
   *
   * Without that, the row group announcing a change is the first month of the NEW value and the
   * old one is whatever the listener last heard, which may be many months back. Social Security
   * beginning at month 384 was heard against a reading from month 372: not a before-and-after so
   * much as two unrelated facts. A discrete change is exactly where the adjacent pair carries the
   * meaning, so it is worth the extra row group to guarantee it.
   */
  const addDiscreteReason = (month: number, reason: string) => {
    addReason(month, reason);
    contextMonths.add(month - 1);
  };
  for (const [i, r] of view.rows.entries()) {
    const drawn = r.centsByBand;
    if (i === 0) addReason(r.month, "Projection starts");
    if (prevDrawn !== null) {
      for (const b of bands) {
        // Compared as the table PRINTS them, never as the engine holds them. A band is announced
        // beside the figures beneath it, and a 4-cent refund beginning is "Tax refund begins" over
        // a row reading $0 — fifteen of them in one preset, each a transition the reader is told
        // about and cannot see. The threshold is not a tolerance picked here: it is the rounding
        // {@link formatDollars} already does, so a moment exists exactly when the numbers move.
        const before = toDisplayCents(prevDrawn[b.id] ?? 0);
        const after = toDisplayCents(drawn[b.id] ?? 0);
        if (before === after) continue;
        if (before === 0) addDiscreteReason(r.month, `${b.label} begins`);
        else if (after === 0) addDiscreteReason(r.month, `${b.label} ends`);
        // A raise, not the annual indexation: only a step against the month before survives.
        else if (steps(before, after)) addDiscreteReason(r.month, `${b.label} changes`);
      }
    }
    // The spending need is one figure rather than a set of bands, so it has no beginning or
    // ending to be structural about — a new obligation shows up here as a step and nowhere else.
    if (prevSpendingNeedCents !== null && steps(prevSpendingNeedCents, r.spendingNeedCents)) {
      addDiscreteReason(r.month, "Spending need changes");
    }
    prevDrawn = drawn;
    prevSpendingNeedCents = r.spendingNeedCents;
  }
  // Named explicitly even when a band-begins reason already covers the same month, so the
  // reason a screen-reader user hears never depends on which mode collapsed which band.
  if (drawdown.month !== null) addDiscreteReason(drawdown.month, drawdown.reason);
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
      const drawn = row?.centsByBand ?? {};
      return {
        label: formatMomentLabel(currentAge, month),
        reason: reasonsByMonth.get(month)!.join("; "),
        sources:
          bands.length > 0
            ? bands.map((b) => ({ label: b.label, amount: formatDollars(drawn[b.id] ?? 0) }))
            : [{ label: "Net cash flow", amount: formatDollars(row?.netCents ?? 0) }],
        totalCashFlow: formatDollars(row?.totalCents ?? 0),
        spendingNeed: formatDollars(row?.spendingNeedCents ?? 0),
      };
    });
}

export interface CashFlowChartBand {
  readonly id: string;
  readonly label: string;
  readonly color: string;
}

/** One source line within a moment of the chart's nonvisual table: label and formatted dollars. */
export interface CashFlowChartAccessibleRow {
  readonly label: string;
  readonly amount: string;
}

/**
 * One point in time worth reading out: the projection's start, a band beginning, ending or
 * stepping, a spending-need step, the first savings withdrawal, insolvency — or the month before
 * any of those, which is there to be its "before". `label` identifies *when* (age and month, so
 * it stands alone without the moments around it); `reason` says *why* this moment was picked, so
 * a screen-reader user isn't left to infer it from the numbers.
 *
 * A narrative of what HAPPENS to the plan, deliberately not a sampling of it. The drift between
 * those points is the chart's to draw, and any individual month is reachable without sight
 * through the editor below, whose Month field resolves one on demand in more detail than this
 * carries.
 */
export interface CashFlowChartAccessibleMoment {
  readonly label: string;
  readonly reason: string;
  readonly sources: readonly CashFlowChartAccessibleRow[];
  /** This moment's total cash across all bands, formatted — broader than "income": drawdowns count. */
  readonly totalCashFlow: string;
  /** This moment's spending need (expenses + liability payments), formatted. */
  readonly spendingNeed: string;
}

/**
 * One Recharts datum: the month on the shared axis, the spending-need under {@link
 * SPENDING_NEED_KEY}, the signed net under {@link NET_KEY}, and one stacked figure per band id.
 * Flat so Recharts reads each series by `dataKey` directly.
 */
export type CashFlowChartRow = Readonly<Record<string, number>>;

export interface CashFlowChartModelOptions {
  /** Which side of the household's month to draw, or the difference between them. */
  readonly view: CashFlowView;
  /** Ignored by the net view, which has no bands to collapse. */
  readonly mode?: CashFlowMode;
  /** Names a benefit or refund band by its earner when two are on the chart; otherwise a band keeps its label. */
  readonly personNames?: ReadonlyMap<string, string>;
  /**
   * Draw only this person's figures — honoured on all three views, though the two sides are cut
   * differently; see {@link cashFlowBandsForView}.
   */
  readonly ownerId?: string;
  /** The household's age at month 0, which turns the insolvency month into an age. */
  readonly currentAge?: number;
}

export interface CashFlowChartModel {
  readonly view: CashFlowView;
  /** Empty on the net view, which stacks nothing. */
  readonly bands: readonly CashFlowChartBand[];
  readonly rows: readonly CashFlowChartRow[];
  readonly spendingNeedKey: string;
  readonly netKey: string;
  /** Whether this view plots the dashed spending-need line — inflows only; see the chart. */
  readonly showsSpendingNeed: boolean;
  /** Axis x of the last flowed month, for the chart's domain. */
  readonly lastX: number;
  /** First insolvent month (raw, not axis-mapped), or `null` on a solvent plan. */
  readonly brokeMonth: number | null;
  /** The insolvency month as the household's age ("69¾"), or `null` when solvent. */
  readonly brokeAgeLabel: string | null;
  /**
   * The cash-flow-gap sentence, or `null` when income covers spending throughout — the raw copy
   * the chart shows as a visible hint. {@link accessibleSummary} wraps it for the a11y label.
   */
  readonly gapSummary: string | null;
  /** A human-readable sentence for the chart's accessible label. Never empty. */
  readonly accessibleSummary: string;
  /**
   * The chart as a nonvisual table of the moments worth reading out — never every month, and
   * never rendered as raw ids or cents — so a screen-reader user gets the shape of the
   * projection over time, not one unlabeled starting snapshot. See {@link
   * CashFlowChartAccessibleMoment}.
   */
  readonly accessibleMoments: readonly CashFlowChartAccessibleMoment[];
}

/** What each view calls itself, in the hint, the a11y label and the axis description. */
const VIEW_TITLES: Readonly<Record<CashFlowView, string>> = {
  inflows: "Monthly cash coming in",
  outflows: "Monthly cash going out",
  net: "Monthly net cash flow",
};

/**
 * Fold {@link CashFlowChartData} for the chosen view and mode into render-ready bands and rows.
 * Pure: no memoisation and no React — the caller memoises if a hot render path needs it.
 */
export function buildCashFlowChartModel(
  data: CashFlowChartData,
  options: CashFlowChartModelOptions,
): CashFlowChartModel {
  const { view, mode = "simple", personNames = new Map<string, string>(), currentAge = 0, ownerId } = options;
  const folded = cashFlowBandsForView(data, view, mode, personNames, ownerId);
  const colors = colorsForBands(folded.bands);
  const bands: CashFlowChartBand[] = folded.bands.map((b) => ({
    id: b.id,
    label: b.label,
    color: colors.get(b.id)!,
  }));
  // This is a chart of FLOWS, so the axis' today slot stays empty — no flow has run at "now" —
  // and the bands start at end-of-month-0. The slot is still reserved, so this chart's x lines
  // up with the net-worth charts above it.
  const rows: CashFlowChartRow[] = folded.rows.map((r) => {
    const row: Record<string, number> = {
      month: toAxisX(r.month),
      [SPENDING_NEED_KEY]: r.spendingNeedCents,
      [NET_KEY]: r.netCents,
    };
    // EVERY band in EVERY row, zero-filled. A band that pays once a year — an RMD, an April tax
    // settlement — is otherwise absent from the eleven months between, and a stacked area whose
    // neighbours are `undefined` draws zero-width: the spike vanishes while still stretching the
    // y-axis to its value. Simple hid the bug by folding those months into a band that pays
    // continuously.
    for (const b of bands) row[b.id] = r.centsByBand[b.id] ?? 0;
    return row;
  });
  const lastX = toAxisX(folded.rows[folded.rows.length - 1]?.month ?? 0);
  const brokeMonth = data.firstInsolventMonth;
  const summary = describeCashFlowGap(data, ownerId, ownerId === undefined ? undefined : personNames.get(ownerId));
  const title = VIEW_TITLES[view];

  // Scoped like the summary: a household drawdown is a household fact, and a person's cut names
  // only their own. The reasons differ because the claims do.
  const drawdown =
    ownerId === undefined
      ? { month: data.firstHouseholdDrawdownMonth, reason: "Household starts living off savings" }
      : {
          month: data.firstDrawdownMonthByPerson[ownerId] ?? null,
          reason: "First personal savings withdrawal",
        };
  const accessibleMoments = buildAccessibleMoments(
    folded,
    bands,
    currentAge,
    drawdown,
    data.firstInsolventMonth,
  );

  return {
    view,
    bands,
    rows,
    spendingNeedKey: SPENDING_NEED_KEY,
    netKey: NET_KEY,
    // Only the inflow view: on the outflow view the spending IS the bands, and on the net view
    // spending has already been subtracted, so the reference worth drawing is zero. In a
    // person's cut the line is THEIR share of the household's spending, not the household's
    // whole need — held against one earner's pay, the latter reads as a shortfall in a
    // household that has none.
    showsSpendingNeed: view === "inflows",
    lastX,
    brokeMonth,
    brokeAgeLabel: brokeMonth === null ? null : formatAgeAtMonth(currentAge, brokeMonth),
    gapSummary: summary,
    accessibleSummary: summary
      ? `${title}. ${summary}`
      : `${title} — cash flow continues across the whole horizon.`,
    accessibleMoments,
  };
}
