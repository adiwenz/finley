/**
 * One account's projected balance over time, read straight off {@link
 * import("@finley/engine").ProjectionSeries.opening} and {@link
 * import("@finley/engine").ProjectionSeries.months} — the same per-account balances the
 * net-worth breakdown chart stacks (`accountBalancesCents`), never recomputed here. This
 * module only reshapes an already-simulated series onto the shared months-from-now axis for
 * a single account id; it holds no interest/contribution/withdrawal arithmetic of its own.
 */

import type { ProjectionSeries } from "@finley/engine";
import { TODAY_X, toAxisX } from "../monthAxis";
import { chartXMax, stoppedSpan, type StoppedSpan } from "../netWorthChart/chartSpan";

export interface AccountBalancePoint {
  readonly x: number;
  readonly balanceCents: number;
}

export interface AccountBalanceData {
  /** Today's balance first (from `opening`), then one point per simulated month. */
  readonly points: readonly AccountBalancePoint[];
  /** The axis' right edge — the plan's own span, shared with the other projection charts. */
  readonly xMax: number;
  /** The unsimulated tail of a blocked plan, shaded like the other charts; null otherwise. */
  readonly stopped: StoppedSpan | null;
}

/**
 * Rows stop at the first insolvent month, matching every other stock chart in this app (the
 * total net-worth chart and the breakdown): a series marked insolvent keeps simulating, but
 * its reported balances past that point are the "what if we'd borrowed further" counterfactual,
 * not a projected account balance.
 */
export function buildAccountBalanceData(
  series: ProjectionSeries,
  accountId: string,
  horizonMonths?: number,
): AccountBalanceData {
  const points: AccountBalancePoint[] = [
    { x: TODAY_X, balanceCents: series.opening.accountBalancesCents[accountId] ?? 0 },
  ];
  for (const m of series.months) {
    if (m.isInsolvent) break;
    points.push({ x: toAxisX(m.month), balanceCents: m.accountBalancesCents[accountId] ?? 0 });
  }
  const xMax = chartXMax(points[points.length - 1]!.x, horizonMonths);
  return { points, xMax, stopped: stoppedSpan(series, xMax) };
}
