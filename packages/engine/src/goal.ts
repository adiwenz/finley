/**
 * Goal — a funding target competing for the same net cash flow the allocation waterfall
 * distributes. Not a separate subsystem: a prioritized destination in the waterfall with a
 * target amount and date. Retirement is not special — by default it is the highest-priority
 * *horizon* goal, sharing this priority list and on-track math.
 *
 * Owns the goal *disposition* and the projection-based on-track math. Per-month funding
 * lives in `projection/waterfall`.
 */

import type { Cents } from "./money";
import type { SimAccount } from "./simAccount";
import type { ProjectionSeries } from "./projection/simulate";

/**
 * What happens to a goal's money once its target is reached — a purely descriptive axis. A
 * goal never moves its own money out; only a timeline event does. Both dispositions leave
 * the fund in net worth and drawable; they differ only in the story told:
 *
 *  - `retain`   — a liquid reserve (emergency fund, home down payment). Contributions stop
 *    at target; the balance stays in net worth and COUNTS toward the nest egg.
 *  - `drawDown` — withdrawn over the horizon (retirement, college). This fund IS the nest
 *    egg — the horizon withdrawal phase.
 *
 * Nothing in the projection keys on the disposition: both are fully drawable in
 * decumulation. Authoring/presentation only.
 */
export type GoalDisposition = "retain" | "drawDown";

/**
 * Whether a goal is funded from the shared household pool or one person's own
 * leftover. A `personal` goal names its `ownerId`.
 */
export type GoalScope = "shared" | "personal";

/** A target date is either an absolute simulation month or "as soon as possible". */
export type GoalTargetDate = number | "asap";

/** The fields every goal carries, whatever its disposition. */
interface GoalBase {
  readonly id: string;
  readonly name: string;
  readonly targetCents: Cents;
  /** The account (or sub-balance) this goal accumulates into. */
  readonly fundAccountId: string;
  /**
   * Drag-to-order priority, shared with retirement. Lower = funded first. One of the four
   * exposed waterfall levers.
   */
  readonly priority: number;
  readonly scope: GoalScope;
  /** Owner of a `personal` goal; ignored for `shared`. */
  readonly ownerId?: string;
}

/**
 * A goal's `disposition` paired with its `targetDate`. Both dispositions are descriptive and
 * never fire, so either accepts a concrete month OR `"asap"` — a dateless reserve is a real
 * thing to want (an emergency fund has no purchase date, and "as fast as you can" is honest
 * where an invented deadline is not).
 *
 * Shared so {@link SimGoal} and the authoring-side `GoalPlan` cannot drift apart, and so a
 * mapping between them can pass the pair as one value.
 *
 * What `"asap"` MEANS for funding pace (no deadline → no sinking-fund pace) is deliberately
 * still open.
 */
export type GoalDisposal = {
  readonly disposition: GoalDisposition;
  /** Absolute simulation month the target is wanted by, or "asap". */
  readonly targetDate: GoalTargetDate;
};

/** A funding goal. See {@link GoalDisposal} for the `disposition`/`targetDate` pairing. */
export type SimGoal = GoalBase & GoalDisposal;

/**
 * A dated goal this close routes to the immediate feasibility-verdict branch (asset-ratio)
 * rather than the projection path — the curve adds no information over so short a span. An
 * "asap" goal always projects.
 */
export const HORIZON_GOAL_IMMEDIATE_VERDICT_MONTHS = 12;

/**
 * A goal in a high-return account whose target is this close is flagged for honesty: v1 uses
 * fixed rates with NO risk modeling, so a near-term equity-like goal overstates certainty.
 * Wider than the verdict threshold — the "don't hold under-5-year money in equities" rule of
 * thumb.
 */
export const SHORT_HORIZON_RISK_MONTHS = 60;

/** An annual return at or above this is treated as equity-like / risk-bearing. */
export const RISKY_ANNUAL_RATE_THRESHOLD = 0.05;

/** Which verdict branch a goal's on-track question is answered by. */
export type GoalVerdictPath = "immediate" | "projection";

/**
 * A goal's completion state, derived from the projection series — never stored, no
 * cross-reference to any event. Binary and monotone:
 *
 *  - `inProgress` — the fund has not reached target on/before the target date.
 *  - `funded`     — the balance reached target at some month **on or before** the target
 *    date. **Latches**: decided by the *earliest* reaching month, so a later event draining
 *    the account can never move it back.
 */
export type GoalCompletion = "inProgress" | "funded";

export interface GoalProgress {
  readonly goalId: string;
  /**
   * Projected fund balance at the target date ÷ target amount — NOT saved-so-far ÷ target.
   * 1.0+ = on track; 0.6 = 60% of target by your date at current savings rates. A
   * zero-target goal reports 1.
   */
  readonly onTrackFraction: number;
  /**
   * Derived, latched completion state — see {@link GoalCompletion}. Scanned from the
   * projection series (balance vs target across every month up to the target date), not
   * stored.
   */
  readonly completion: GoalCompletion;
  readonly verdictPath: GoalVerdictPath;
  /**
   * True when a near-term goal accumulates into an equity-like account — v1 does not model
   * the short-term market risk that matters most there.
   */
  readonly shortHorizonRiskFlag: boolean;
}

/**
 * A goal's on-track progress against a projection: the fund account's *projected* balance at
 * the target date (future contributions + growth baked in by the simulator) ÷ the target.
 *
 * `nowMonth` is the "now" marker (month 0 by default). The target month is clamped into the
 * projection horizon; an "asap" goal is measured at the horizon end.
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

  // Scan every month up to and including the target month: funded latches the instant the
  // balance first reaches target, so a later draining month cannot undo it. A zero-target
  // goal is trivially funded (balance 0 already reaches target 0).
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

  // A near-term dated goal may use the asset-ratio branch; an "asap" goal always projects.
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
