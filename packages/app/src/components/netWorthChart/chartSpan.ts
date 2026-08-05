/**
 * How far a projection chart's x-axis reaches, and what part of it the projection never answered.
 * Shared by the total {@link import("./netWorthChartData")} and the
 * {@link import("./netWorthBreakdown")} beneath it, so the two cannot end at different years while
 * drawing the same plan — the pair is read as one picture, and a mismatch reads as a data bug.
 *
 * **The axis spans the whole plan, not the data.** Where a curve ends is a finding; where the axis
 * ends must not be, or a plan that failed in year 3 and a plan that ran 55 years draw the same
 * width and only the tick labels tell them apart. A blocked series is truncated at the block, so
 * deriving the axis from the data alone would do exactly that.
 */

import type { ProjectionSeries } from "@finley/engine";
import { TODAY_X, toAxisX } from "../monthAxis";

/**
 * The stretch of the plan a projection never simulated: from where it stopped to the end of the
 * axis. Present only for a BLOCKED projection, whose series is truncated at the blocked month —
 * an insolvent plan keeps simulating (it just stops reporting a net worth), so it has no such span.
 *
 * Shaded rather than plotted, because there is no data here and that absence IS the content: the
 * axis runs to life expectancy either way, so the band is the visible difference between a plan
 * that reached the end and one that stopped part-way.
 */
export interface StoppedSpan {
  /** Axis position where the projection stopped — the blocked month. */
  readonly fromX: number;
  /** The end of the axis. */
  readonly toX: number;
}

/**
 * The axis' right edge: the plan's own `horizonMonths` ("now" to life expectancy, the same figure
 * the timeline and the event year picker span), held against whatever the chart actually has to
 * draw. Taking the max keeps every point and marker in view even if a series outruns the stated
 * horizon — a marker off the right edge is worse than a slightly wider chart.
 *
 * `horizonMonths` omitted falls back to the data's own span, which for an untruncated run is the
 * same full horizon.
 */
export function chartXMax(
  lastPointX: number,
  horizonMonths: number | undefined,
  ...markerXs: readonly (number | null | undefined)[]
): number {
  return Math.max(
    lastPointX,
    horizonMonths !== undefined ? toAxisX(horizonMonths - 1) : lastPointX,
    ...markerXs.map((x) => x ?? TODAY_X),
  );
}

/**
 * What the projection never reached, or null when it reached the end. Anchored on the blocked
 * month rather than on the last point drawn, so the shading starts exactly where the blocked
 * marker sits. Null too when the block lands at the very end of the axis, where nothing is left
 * to shade.
 */
export function stoppedSpan(series: ProjectionSeries, xMax: number): StoppedSpan | null {
  if (series.status !== "blocked" || series.blockedAtMonth === undefined) return null;
  const fromX = toAxisX(series.blockedAtMonth);
  return fromX < xMax ? { fromX, toX: xMax } : null;
}
