/**
 * Goal — a funding target competing for the net cash flow the allocation waterfall
 * distributes. Retirement is not special: by default it is the highest-priority *horizon*
 * goal, sharing this priority list and on-track math.
 *
 * Owns disposition and the projection-based on-track math; per-month funding lives in
 * `projection/waterfall`.
 */

import type { Cents } from "./money";
import type { SimAccount } from "./simAccount";
import type { ProjectionSeries } from "./projection/simulate";

/**
 * What happens to a goal's money once its target is reached. Purely descriptive: `retain`
 * (an emergency fund) and `drawDown` (retirement) both leave the fund in net worth and
 * fully drawable. Nothing in the projection keys on it; only a timeline event moves a
 * goal's money out.
 */
export type GoalDisposition = "retain" | "drawDown";

/** Funded from the shared household pool, or from one person's own leftover. */
export type GoalScope = "shared" | "personal";

export type GoalTargetDate = number | "asap";

interface GoalBase {
  readonly id: string;
  readonly name: string;
  readonly targetCents: Cents;
  readonly fundAccountId: string;
  /** Lower = funded first; the priority list is shared with retirement. */
  readonly priority: number;
  readonly scope: GoalScope;
  /** Owner of a `personal` goal; ignored for `shared`. */
  readonly ownerId?: string;
}

/**
 * Either disposition accepts a concrete month OR `"asap"` — an emergency fund has no
 * purchase date, and "as fast as you can" is honest where an invented deadline is not.
 *
 * Shared so {@link SimGoal} and the authoring-side `GoalPlan` cannot drift apart. What
 * `"asap"` means for funding pace is still open.
 */
export type GoalDisposal = {
  readonly disposition: GoalDisposition;
  /** Absolute simulation month the target is wanted by, or "asap". */
  readonly targetDate: GoalTargetDate;
};

export type SimGoal = GoalBase & GoalDisposal;

/**
 * A dated goal this close takes the immediate asset-ratio verdict instead of the projection
 * path — the curve adds no information over so short a span. An "asap" goal always projects.
 */
export const HORIZON_GOAL_IMMEDIATE_VERDICT_MONTHS = 12;

/**
 * A goal in a high-return account whose target is this close is flagged for honesty: v1
 * uses fixed rates with NO risk modeling. Wider than the verdict threshold — the "don't
 * hold under-5-year money in equities" rule of thumb.
 */
export const SHORT_HORIZON_RISK_MONTHS = 60;

/** An annual return at or above this is treated as equity-like / risk-bearing. */
export const RISKY_ANNUAL_RATE_THRESHOLD = 0.05;

export type GoalVerdictPath = "immediate" | "projection";

/**
 * Derived from the projection series, never stored. **Latches**: `funded` is decided by the
 * *earliest* month the balance reached target on or before the target date, so a later
 * event draining the account can never move it back.
 */
export type GoalCompletion = "inProgress" | "funded";

export interface GoalProgress {
  readonly goalId: string;
  /**
   * Projected fund balance at the target date ÷ target amount — NOT saved-so-far ÷
   * target. 1.0+ = on track. A zero-target goal reports 1 (0 if the fund is negative).
   */
  readonly onTrackFraction: number;
  readonly completion: GoalCompletion;
  readonly verdictPath: GoalVerdictPath;
  /** True when a near-term goal accumulates into an equity-like account. */
  readonly shortHorizonRiskFlag: boolean;
}

/**
 * The target month is clamped into the projection horizon; an "asap" goal is measured at
 * the horizon end.
 */
export function computeGoalProgress(
  goal: SimGoal,
  projection: ProjectionSeries,
  accounts: readonly SimAccount[],
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

  // Scanning every month up to the target is what makes `funded` latch. A zero-target goal
  // is trivially funded (balance 0 already reaches target 0).
  let completion: GoalCompletion = "inProgress";
  for (let m = 0; m <= targetMonth; m++) {
    const balCents = projection.months[m]?.accountBalancesCents[goal.fundAccountId] ?? 0;
    if (balCents >= goal.targetCents) {
      completion = "funded";
      break;
    }
  }

  const monthsToTarget =
    goal.targetDate === "asap" ? 0 : Math.max(0, goal.targetDate - nowMonth);

  const verdictPath: GoalVerdictPath =
    goal.targetDate !== "asap" &&
    monthsToTarget < HORIZON_GOAL_IMMEDIATE_VERDICT_MONTHS
      ? "immediate"
      : "projection";

  const fundAccount = accounts.find((a) => a.id === goal.fundAccountId);
  const fundRate = fundAccount ? fundAccount.getRateAt(nowMonth) : 0;
  const shortHorizonRiskFlag =
    monthsToTarget < SHORT_HORIZON_RISK_MONTHS && fundRate >= RISKY_ANNUAL_RATE_THRESHOLD;

  return { goalId: goal.id, onTrackFraction, completion, verdictPath, shortHorizonRiskFlag };
}
