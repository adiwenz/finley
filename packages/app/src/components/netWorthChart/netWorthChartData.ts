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
 * What replaces it is {@link NetWorthChartData.runsOut}: a DASHED segment dropping from the last
 * funded point by the month's `uncoveredCents`. That endpoint is illustrative — "this is the size
 * of the hole", not a net worth. It is never fed back into the simulation, never mixed into the
 * solid series, and never reported as a balance.
 */

import type { ProjectionSeries } from "@finley/engine";
import { TODAY_X, toAxisX, yearTickXs } from "../monthAxis";

export interface NetWorthChartPoint {
  /** Axis position, not a model month — see {@link import("../monthAxis")}. */
  readonly x: number;
  /** Null from the first insolvent month on; Recharts breaks the line there. */
  readonly nominalCents: number | null;
  readonly realCents: number | null;
  /**
   * The dashed illustrative drop, non-null at exactly two points: the last funded month (where
   * it equals `nominalCents`, so the segment joins the solid curve) and the first insolvent one
   * (where it equals that value minus the uncovered shortfall). Null everywhere else, so a
   * `connectNulls` line draws one segment and nothing more.
   */
  readonly unfundedCents: number | null;
}

/** Where the plan fails, in chart terms. Null for a plan that survives the horizon. */
export interface RunsOutMarker {
  /** Axis position of the FIRST INSOLVENT month — where the marker goes. */
  readonly x: number;
  /** The illustrative y the dashed segment lands on. NOT a net worth. */
  readonly illustrativeCents: number;
  /** The month's dropped, unfundable shortfall — the tooltip's "Unfunded obligations". */
  readonly uncoveredCents: number;
}

export interface NetWorthChartData {
  readonly points: readonly NetWorthChartPoint[];
  /** Axis position of the last point carrying a real net worth. */
  readonly lastFundedX: number;
  /** That point's nominal net worth — the last honest figure the plan produced. */
  readonly lastFundedNominalCents: number | null;
  readonly runsOut: RunsOutMarker | null;
  readonly xMax: number;
  readonly yearTicks: readonly number[];
}

/**
 * `xMax` zooms just past where the story ends, so an early failure is legible instead of a
 * spike against decades of empty chart. The 2-year floor keeps a very early failure roomy, and
 * the span always reaches the runs-out marker — a marker off the right edge is worse than a
 * slightly wider chart.
 */
function computeXMax(horizonX: number, lastDrawnX: number): number {
  return Math.min(horizonX, Math.max(24, Math.ceil((lastDrawnX + 6) / 12) * 12));
}

export function buildNetWorthChartData(series: ProjectionSeries): NetWorthChartData {
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

  const firstInsolvent = series.months.find((m) => m.isInsolvent) ?? null;
  const runsOut: RunsOutMarker | null =
    firstInsolvent && lastFundedNominalCents !== null
      ? {
          x: toAxisX(firstInsolvent.month),
          // Subtraction, never addition: the shortfall is money the household owed and could
          // not pay, so the illustrative point is strictly BELOW the last funded one whenever
          // there is anything uncovered at all.
          illustrativeCents: lastFundedNominalCents - firstInsolvent.uncoveredCents,
          uncoveredCents: firstInsolvent.uncoveredCents,
        }
      : null;

  const points: NetWorthChartPoint[] = base.map((p) => ({
    ...p,
    unfundedCents:
      runsOut === null
        ? null
        : p.x === lastFundedX
          ? lastFundedNominalCents
          : p.x === runsOut.x
            ? runsOut.illustrativeCents
            : null,
  }));

  const horizonX = base[base.length - 1]?.x ?? TODAY_X;
  const xMax = computeXMax(horizonX, Math.max(lastFundedX, runsOut?.x ?? lastFundedX));

  return {
    points,
    lastFundedX,
    lastFundedNominalCents,
    runsOut,
    xMax,
    yearTicks: yearTickXs(xMax),
  };
}
