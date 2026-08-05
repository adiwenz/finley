/**
 * Plot data for the total {@link import("./netWorthChart").NetWorthChart} — the pure companion
 * to the component, in the same relationship {@link import("./netWorthBreakdown")} has to the
 * breakdown chart. Everything that decides WHERE the curve ends and what the failure looks like
 * lives here, so it can be asserted without rendering Recharts.
 *
 * The rule this module exists to enforce: **the solid curve stops at the last fully funded
 * month.** The engine nulls net worth from the first insolvent month onward
 * ({@link import("@finley/engine").ProjectionMonth}) precisely because that month's balance
 * sheet is contaminated — the shortfall cascade charged only the sliver of spending credit could
 * still absorb and silently dropped the rest, so the month keeps its appreciation and principal
 * paydown while losing most of its cost and reads HIGHER than the solvent month before it. A
 * chart that plotted it would draw an upward tick at exactly the point labelled "runs out".
 *
 * What replaces it is {@link NetWorthChartData.runsOut}: a DASHED segment from the last funded
 * point to a single endpoint at the first insolvent month, taken from the engine's
 * {@link InsolvencyReport.debtFundedNetWorthNominalCents} — what the month would have been worth
 * had the dropped obligations been honoured with equivalent additional borrowing.
 *
 * **No financial arithmetic happens in this module.** The endpoint is read, not computed. That
 * boundary is deliberate: the figure encodes a claim about what insolvency costs a household,
 * which is the engine's to make. This module decides only where things sit on an axis.
 *
 * The endpoint is counterfactual. It is never mixed into the solid series, never reported as a
 * balance, and no LATER counterfactual point is drawn — the engine emits the report for one
 * month only, and the chart draws one endpoint, then stops.
 *
 * **The axis spans the whole plan, not the data.** Where the curve ends is a finding; where the
 * axis ends must not be, or a plan that failed in year 3 and a plan that ran 55 years draw the
 * same width and the reader has to check the tick labels to tell them apart. So the x-axis runs to
 * life expectancy in every case (`horizonMonths`), and what a failure costs is shown as the
 * remaining span going unanswered: the curve stopping short, and — for a blocked projection, whose
 * series is genuinely truncated — the {@link StoppedSpan} shaded behind the rest of the axis.
 */

import type { InsolvencyReport, ProjectionSeries } from "@finley/engine";
import { TODAY_X, toAxisX, yearTickXs } from "../monthAxis";
import { chartXMax, stoppedSpan, type StoppedSpan } from "./chartSpan";

export type { StoppedSpan };

/**
 * The terminal marker for a BLOCKED projection: the attempted obligation that could not be funded,
 * and the gap that stopped it. Presentation-only — never a simulated month, never compounded,
 * never fed back to the engine. Every figure is READ off {@link ProjectionSeries.blockingObligation}
 * (the y off the engine's already-adjusted `markerNetWorthCents`), so this module does no arithmetic
 * on cents.
 */
export interface BlockedMarker {
  /** Axis position of the blocked month — where the marker sits. */
  readonly x: number;
  /**
   * The marker's y: the blocked month's genuine net worth dropped by the shortfall, straight off
   * the engine. NOT a net worth the household holds — a visualization of the missing capital.
   */
  readonly netWorthCents: number;
  /** The blocking obligation's human name. */
  readonly label: string;
  readonly requiredCents: number;
  readonly availableCents: number;
  readonly shortfallCents: number;
}

export interface NetWorthChartPoint {
  /** Axis position, not a model month — see {@link import("../monthAxis")}. */
  readonly x: number;
  /** Null from the first insolvent month on; Recharts breaks the line there. */
  readonly nominalCents: number | null;
  readonly realCents: number | null;
  /**
   * The dashed segment, non-null at exactly two points: the last funded month (where it equals
   * `nominalCents`, so the segment joins the solid curve) and the first insolvent one (the
   * engine's debt-funded endpoint). Null everywhere else, so a `connectNulls` line draws one
   * segment and nothing more.
   */
  readonly debtFundedNetWorthCents: number | null;
}

/** Where the plan fails, in chart terms. Null for a plan that survives the horizon. */
export interface RunsOutMarker {
  /** Axis position of the FIRST INSOLVENT month — where the marker goes. */
  readonly x: number;
  /**
   * The y the dashed segment lands on, straight off
   * {@link InsolvencyReport.debtFundedNetWorthNominalCents}. NOT a net worth, and not carried
   * forward.
   */
  readonly debtFundedNetWorthCents: number;
  /** The month's dropped, unfundable shortfall — what the counterfactual assumes was borrowed. */
  readonly uncoveredCents: number;
}

export interface NetWorthChartData {
  readonly points: readonly NetWorthChartPoint[];
  /** Axis position of the last point carrying a real net worth. */
  readonly lastFundedX: number;
  /** That point's nominal net worth — the last honest figure the plan produced. */
  readonly lastFundedNominalCents: number | null;
  readonly runsOut: RunsOutMarker | null;
  /** The terminal blocked marker, or null for a projection that ran to the horizon. */
  readonly blocked: BlockedMarker | null;
  /** The unsimulated tail of a blocked plan; null when the projection ran to the horizon. */
  readonly stopped: StoppedSpan | null;
  readonly xMax: number;
  readonly yearTicks: readonly number[];
}

/**
 * Plot data for the chart.
 *
 * `horizonMonths` is the plan's OWN span — "now" to life expectancy, the same figure the timeline
 * and the event year picker use. Pass it so the axis spans the whole plan whatever the projection
 * did: a blocked series is truncated at the blocked month, so deriving the axis from the data
 * alone ends the chart exactly where the failure is, which reads as a plan that simply finishes
 * early. Held to the full span instead, the block lands mid-axis with the {@link StoppedSpan}
 * shaded behind it, and the reader can see how much of the plan went unanswered.
 *
 * Omitted, the axis falls back to the last point in the data — which for an untruncated run is the
 * same full span.
 */
export function buildNetWorthChartData(
  series: ProjectionSeries,
  horizonMonths?: number,
): NetWorthChartData {
  const base = [
    {
      x: TODAY_X,
      nominalCents: series.opening.netWorthNominalCents,
      realCents: series.opening.netWorthRealCents,
    },
    ...series.months.map((m) => ({
      x: toAxisX(m.month),
      nominalCents: m.netWorthNominalCents,
      realCents: m.netWorthRealCents,
    })),
  ];

  // The last point the engine was willing to state a net worth for. `opening` always carries
  // one, so this never comes up empty — even a plan insolvent in month 0 has "today".
  let lastFundedX = TODAY_X;
  let lastFundedNominalCents: number | null = null;
  for (let i = base.length - 1; i >= 0; i--) {
    const p = base[i];
    if (p.nominalCents !== null) {
      lastFundedX = p.x;
      lastFundedNominalCents = p.nominalCents;
      break;
    }
  }

  // The engine emits a report for the first insolvent month and no other, so finding the month
  // that HAS one is the same as finding the failure — and there is nothing to compute from it.
  const firstInsolvent = series.months.find((m) => m.insolvencyReport !== undefined) ?? null;
  const report = firstInsolvent?.insolvencyReport;
  const runsOut: RunsOutMarker | null =
    firstInsolvent && report && lastFundedNominalCents !== null
      ? {
          x: toAxisX(firstInsolvent.month),
          debtFundedNetWorthCents: report.debtFundedNetWorthNominalCents,
          uncoveredCents: report.uncoveredCents,
        }
      : null;

  const points: NetWorthChartPoint[] = base.map((p) => ({
    ...p,
    debtFundedNetWorthCents:
      runsOut === null
        ? null
        : p.x === lastFundedX
          ? lastFundedNominalCents
          : p.x === runsOut.x
            ? runsOut.debtFundedNetWorthCents
            : null,
  }));

  // The terminal blocked marker. Only the y is financial, and it is READ from the engine's
  // already-adjusted figure — no cents arithmetic happens here, exactly as the runs-out endpoint
  // is read, not computed. Absent unless the projection blocked and the engine anchored a marker.
  const blocking = series.blockingObligation;
  const blocked: BlockedMarker | null =
    series.status === "blocked" &&
    blocking !== undefined &&
    blocking.markerNetWorthCents !== null &&
    series.blockedAtMonth !== undefined
      ? {
          x: toAxisX(series.blockedAtMonth),
          netWorthCents: blocking.markerNetWorthCents,
          label: blocking.label,
          requiredCents: blocking.requiredCents,
          availableCents: blocking.availableCents,
          shortfallCents: blocking.shortfallCents,
        }
      : null;

  // Axis and shaded tail both from `./chartSpan`, the one definition the breakdown chart below
  // shares — the pair is read as one picture, so they must end at the same year.
  const lastPointX = base[base.length - 1]?.x ?? TODAY_X;
  const xMax = chartXMax(lastPointX, horizonMonths, runsOut?.x, blocked?.x);

  return {
    points,
    lastFundedX,
    lastFundedNominalCents,
    runsOut,
    blocked,
    stopped: stoppedSpan(series, xMax),
    xMax,
    yearTicks: yearTickXs(xMax),
  };
}
