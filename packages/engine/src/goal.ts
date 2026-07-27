/**
 * Goal — a funding target competing for the same net cash flow the allocation
 * waterfall distributes. A goal is NOT a separate subsystem:
 * it is a prioritized destination in the waterfall with a target amount and
 * target date. Retirement is not special — it is the highest-priority *horizon*
 * goal by default, sharing this same priority list and on-track math.
 *
 * This module owns the goal *disposition* and the projection-based on-track math.
 * The per-month funding of goals lives in the waterfall (see `projection/waterfall`).
 */

import type { Cents } from "./money";
import type { SimAccount } from "./simAccount";
import type { ProjectionSeries } from "./projection/simulate";

/**
 * What happens to a goal's accumulated money once its target is reached — a purely
 * descriptive axis. A goal never moves its own money out; only a timeline event does
 * (#150). Both dispositions leave the fund in net worth and drawable — they differ
 * only in the story they tell the user:
 *
 *  - `retain`   — held as a liquid reserve (emergency fund, or a savings target such as
 *    a home down payment). Contributions stop at target; the balance stays in net worth
 *    indefinitely and COUNTS toward the retirement nest egg (real, drawable money).
 *  - `drawDown` — withdrawn over the horizon (retirement, college). This fund IS the
 *    nest egg — the existing horizon withdrawal phase.
 *
 * Nothing keys on the disposition in the projection: both `retain` and `drawDown` are
 * fully drawable in decumulation. The distinction is authoring/presentation only.
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
   * Drag-to-order priority, shared with retirement. Lower number = funded
   * first. This is one of the four exposed waterfall levers.
   */
  readonly priority: number;
  readonly scope: GoalScope;
  /** Owner of a `personal` goal; ignored for `shared`. */
  readonly ownerId?: string;
}

/**
 * A goal's `disposition` paired with its `targetDate`. Both dispositions are purely
 * descriptive and never fire, so either accepts a concrete month OR `"asap"`: a dateless
 * reserve is a real thing to want (an emergency fund has no purchase date, and "as fast
 * as you can" is honest where an invented deadline is not).
 *
 * Carried as a shared type so {@link SimGoal} and the authoring-side `GoalPlan` cannot
 * drift apart, and so a mapping between them can pass the pair along as one value.
 *
 * What `"asap"` should MEAN for funding pace (a goal with no deadline has no
 * sinking-fund pace to compute) is still open — deliberately not settled here.
 */
export type GoalDisposal = {
  readonly disposition: GoalDisposition;
  /** Absolute simulation month the target is wanted by, or "asap". */
  readonly targetDate: GoalTargetDate;
};

/** A funding goal. See {@link GoalDisposal} for the `disposition`/`targetDate` pairing. */
export type SimGoal = GoalBase & GoalDisposal;

/**
 * A near-term goal with a concrete target date routes to the immediate
 * feasibility-verdict branch (asset-ratio path) rather than the projection path —
 * its target date is so close that the projection curve adds no information. An
 * "asap" goal (no concrete date) always projects.
 */
export const HORIZON_GOAL_IMMEDIATE_VERDICT_MONTHS = 12;

/**
 * A goal held in a high-return / high-risk account whose target is this close is
 * flagged for honesty: v1 uses fixed rates with NO risk modeling, so a near-term
 * goal in an equity-like account overstates certainty. "Near term"
 * for market-risk purposes is wider than the verdict threshold — the standard
 * "don't hold under-5-year money in equities" rule of thumb.
 */
export const SHORT_HORIZON_RISK_MONTHS = 60;

/** An annual return at or above this is treated as equity-like / risk-bearing. */
export const RISKY_ANNUAL_RATE_THRESHOLD = 0.05;

/** Which verdict branch a goal's on-track question is answered by. */
export type GoalVerdictPath = "immediate" | "projection";

/**
 * A goal's completion state, derived from the projection series — never stored, and
 * carrying zero cross-reference to any event (#129/#150). It is binary and monotone:
 *
 *  - `inProgress` — the fund has not yet reached target on/before the target date.
 *  - `funded`     — the fund balance reached target at some month **on or before** the
 *    target date. This **latches**: because it is decided by the *earliest* reaching
 *    month, a later event draining the account can never move it back to `inProgress`.
 */
export type GoalCompletion = "inProgress" | "funded";

export interface GoalProgress {
  readonly goalId: string;
  /**
   * Projection-based on-track fraction: projected fund balance at the
   * target date ÷ target amount — NOT saved-so-far ÷ target. 1.0+ = on track;
   * 0.6 = you'll have 60% of the target by your date at current savings rates.
   * A zero-target goal reports 1 (nothing to fund).
   */
  readonly onTrackFraction: number;
  /**
   * Derived, latched completion state — see {@link GoalCompletion}. Scanned from the
   * projection series (fund balance vs target across every month up to the target
   * date); not a stored status.
   */
  readonly completion: GoalCompletion;
  readonly verdictPath: GoalVerdictPath;
  /**
   * True when a near-term goal accumulates into an equity-like account — v1 does
   * not model the short-term market risk that matters most for near-term goals.
   */
  readonly shortHorizonRiskFlag: boolean;
}

/**
 * Compute a goal's on-track progress against a projection. The on-track
 * fraction is projection-based: it reads the fund account's *projected* balance
 * at the target date (future contributions + growth already baked in by the
 * simulator), divided by the target — the entire point of having a simulator.
 *
 * `nowMonth` is the "now" marker (month 0 by default). The target month is
 * clamped into the projection horizon; an "asap" goal is measured at the horizon
 * end (the furthest the projection can see it accumulate).
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

  // Completion is derived by scanning every month up to (and including) the target
  // month: Funded latches the instant the balance first reaches target on/before the
  // date, so a later draining month — never scanned once we've latched — cannot undo it.
  // A zero-target goal is trivially Funded (balance 0 already reaches target 0).
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
