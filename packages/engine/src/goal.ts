/**
 * Goal — a funding target competing for the same net cash flow the allocation
 * waterfall (§5 step 3) distributes (§5.2). A goal is NOT a separate subsystem:
 * it is a prioritized destination in the waterfall with a target amount and
 * target date. Retirement is not special — it is the highest-priority *horizon*
 * goal by default, sharing this same priority list and on-track math.
 *
 * This module owns the goal *type* and the projection-based on-track math. The
 * per-month funding of goals lives in the waterfall (see `projection/waterfall`).
 */

import type { Cents } from "./money";
import type { Account } from "./account";
import type { ProjectionSeries } from "./projection/simulate";

/**
 * Two structurally different goal types (§5.2):
 *  - `oneTime`  — accumulate to target, then the balance is *spent* by an event
 *    (a house down payment feeding `HomePurchaseEvent`, a wedding, a trip).
 *  - `horizon`  — accumulate toward a target by a date, then *draw down over time*
 *    (college fund, baby fund, retirement). The withdrawal phase is a later slice.
 */
export type GoalType = "oneTime" | "horizon";

/**
 * What happens to a goal's accumulated money once its target is reached (§5.2) —
 * ORTHOGONAL to {@link GoalType}, which only says *when* the money is used. `type`
 * conflated timing with fate; disposition names the fate explicitly:
 *
 *  - `retain`          — held as a liquid reserve (emergency fund). Contributions
 *    stop at target; the balance stays in net worth indefinitely and COUNTS toward
 *    the retirement nest egg (it is real, drawable money in retirement).
 *  - `convertToEquity` — an equity transfer (a home down payment feeding
 *    `HomePurchaseEvent`, §4.5). Cash leaves the fund and reappears as an illiquid
 *    asset, so net worth is unchanged at the swap — but the fund is NOT part of the
 *    investable nest egg (it is earmarked for the purchase, not for drawdown).
 *  - `spend`           — genuinely consumed by an event (a vacation, a wedding). It
 *    leaves net worth, so it is earmarked out of the nest egg until spent.
 *  - `drawDown`        — withdrawn over the horizon (retirement, college). This fund
 *    IS the nest egg — the existing horizon withdrawal phase.
 *
 * Disposition drives retirement-portfolio inclusion (which is what the decumulation
 * withdrawal reads via {@link isEarmarkedForDisposition}): `retain` / `drawDown`
 * count as drawable; `convertToEquity` / `spend` are earmarked out until consumed.
 */
export type GoalDisposition = "retain" | "convertToEquity" | "spend" | "drawDown";

/**
 * Whether a goal's fund is *earmarked* out of the drawable retirement portfolio by
 * its disposition (§5.2). Only `convertToEquity` and `spend` earmark — that money is
 * committed to an imminent purchase / expense, not available for retirement
 * drawdown. `retain` (liquid reserve) and `drawDown` (the nest egg itself) are always
 * drawable. A goal PAST its target date is no longer held back (a matured fund the
 * consuming event never fired is made reachable rather than left compounding forever
 * — firing the actual event stays in #28), so the earmark only applies before then.
 */
export function isEarmarkedForDisposition(
  disposition: GoalDisposition,
  targetDate: GoalTargetDate,
  month: number,
): boolean {
  if (disposition !== "convertToEquity" && disposition !== "spend") return false;
  return typeof targetDate === "number" && targetDate > month;
}

/**
 * Whether a goal is funded from the shared household pool or one person's own
 * leftover (§5.0 steps 4–5). A `personal` goal names its `ownerId`.
 */
export type GoalScope = "shared" | "personal";

/** A target date is either an absolute simulation month or "as soon as possible". */
export type GoalTargetDate = number | "asap";

export interface Goal {
  readonly id: string;
  readonly name: string;
  readonly targetCents: Cents;
  /** Absolute simulation month the target is wanted by, or "asap". */
  readonly targetDate: GoalTargetDate;
  /** The account (or sub-balance) this goal accumulates into. */
  readonly fundAccountId: string;
  /**
   * Drag-to-order priority, shared with retirement (§5.2). Lower number = funded
   * first. This is one of the four exposed waterfall levers (§5.0).
   */
  readonly priority: number;
  readonly type: GoalType;
  /** What becomes of the accumulated money at target (§5.2) — see {@link GoalDisposition}. */
  readonly disposition: GoalDisposition;
  readonly scope: GoalScope;
  /** Owner of a `personal` goal; ignored for `shared`. */
  readonly ownerId?: string;
}

/**
 * A near-term *horizon* goal routes to the §8.6 immediate feasibility-verdict
 * branch (asset-ratio path) rather than the projection path — its target date is
 * so close that the projection curve adds no information (§5.2 / §11.3).
 * One-time goals always use the projection path regardless of proximity.
 */
export const HORIZON_GOAL_IMMEDIATE_VERDICT_MONTHS = 12;

/**
 * A goal held in a high-return / high-risk account whose target is this close is
 * flagged for honesty: v1 uses fixed rates with NO risk modeling, so a near-term
 * goal in an equity-like account overstates certainty (§5.2 RESOLVED). "Near term"
 * for market-risk purposes is wider than the verdict threshold — the standard
 * "don't hold under-5-year money in equities" rule of thumb.
 */
export const SHORT_HORIZON_RISK_MONTHS = 60;

/** An annual return at or above this is treated as equity-like / risk-bearing. */
export const RISKY_ANNUAL_RATE_THRESHOLD = 0.05;

/** Which verdict branch a goal's on-track question is answered by (§5.2). */
export type GoalVerdictPath = "immediate" | "projection";

export interface GoalProgress {
  readonly goalId: string;
  /**
   * Projection-based on-track fraction (§5.2): projected fund balance at the
   * target date ÷ target amount — NOT saved-so-far ÷ target. 1.0+ = on track;
   * 0.6 = you'll have 60% of the target by your date at current savings rates.
   * A zero-target goal reports 1 (nothing to fund).
   */
  readonly onTrackFraction: number;
  readonly verdictPath: GoalVerdictPath;
  /**
   * True when a near-term goal accumulates into an equity-like account — v1 does
   * not model the short-term market risk that matters most for near-term goals.
   */
  readonly shortHorizonRiskFlag: boolean;
}

/**
 * Compute a goal's on-track progress against a projection (§5.2). The on-track
 * fraction is projection-based: it reads the fund account's *projected* balance
 * at the target date (future contributions + growth already baked in by the
 * simulator), divided by the target — the entire point of having a simulator.
 *
 * `nowMonth` is the "now" marker (month 0 by default). The target month is
 * clamped into the projection horizon; an "asap" goal is measured at the horizon
 * end (the furthest the projection can see it accumulate).
 */
export function computeGoalProgress(
  goal: Goal,
  projection: ProjectionSeries,
  accounts: readonly Account[],
  nowMonth = 0,
): GoalProgress {
  const lastMonth = projection.months.length - 1;
  const targetMonth =
    goal.targetDate === "asap"
      ? lastMonth
      : Math.max(0, Math.min(goal.targetDate, lastMonth));

  const projectedFundCents =
    projection.months[targetMonth]?.accountBalancesCents[goal.fundAccountId] ?? 0;

  const onTrackFraction =
    goal.targetCents > 0
      ? projectedFundCents / goal.targetCents
      : projectedFundCents >= 0
        ? 1
        : 0;

  const monthsToTarget =
    goal.targetDate === "asap" ? 0 : Math.max(0, goal.targetDate - nowMonth);

  const verdictPath: GoalVerdictPath =
    goal.type === "horizon" &&
    goal.targetDate !== "asap" &&
    monthsToTarget < HORIZON_GOAL_IMMEDIATE_VERDICT_MONTHS
      ? "immediate"
      : "projection";

  const fundAccount = accounts.find((a) => a.id === goal.fundAccountId);
  const fundRate = fundAccount ? fundAccount.getRateAt(nowMonth) : 0;
  const shortHorizonRiskFlag =
    monthsToTarget < SHORT_HORIZON_RISK_MONTHS && fundRate >= RISKY_ANNUAL_RATE_THRESHOLD;

  return { goalId: goal.id, onTrackFraction, verdictPath, shortHorizonRiskFlag };
}
