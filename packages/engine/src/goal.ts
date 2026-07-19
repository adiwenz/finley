/**
 * Goal — a funding target competing for the same net cash flow the allocation
 * waterfall (§5 step 3) distributes (§5.2). A goal is NOT a separate subsystem:
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
 * What happens to a goal's accumulated money once its target is reached (§5.2) — the
 * single axis describing a goal's fate. This *also* fixes the money's timing, so a
 * separate goal "type" is redundant: the {@link DisposingDisposition} fire all at once
 * at a month (the old `oneTime`), the {@link StandingDisposition} are held or drawn over
 * time (the old `horizon`). Read timing off the disposition, never a parallel field.
 *
 *  - `retain`          — held as a liquid reserve (emergency fund). Contributions
 *    stop at target; the balance stays in net worth indefinitely and COUNTS toward
 *    the retirement nest egg (it is real, drawable money in retirement).
 *  - `convertToEquity` — an equity transfer (a home down payment feeding
 *    `HomePurchaseEvent`, §4.5). At maturity the cash leaves the fund and reappears as
 *    an illiquid home-equity holding, so net worth is unchanged at the swap — but the
 *    fund is NOT part of the investable nest egg (earmarked for the purchase, then
 *    swapped to illiquid equity that decumulation cannot draw).
 *  - `spend`           — genuinely consumed by an event (a vacation, a wedding). At
 *    maturity the fund is zeroed and the money leaves net worth; it is earmarked out
 *    of the nest egg until then.
 *  - `drawDown`        — withdrawn over the horizon (retirement, college). This fund
 *    IS the nest egg — the existing horizon withdrawal phase.
 *
 * Disposition drives retirement-portfolio inclusion (which the decumulation withdrawal
 * reads via {@link isEarmarkedForDisposition}): `retain` / `drawDown` count as
 * drawable; `convertToEquity` / `spend` are earmarked out until they FIRE at maturity
 * (the simulator's `fireGoalDispositions`), after which the fund is gone (spend) or
 * an illiquid property outside the accounts (convertToEquity).
 */
export type GoalDisposition = "retain" | "convertToEquity" | "spend" | "drawDown";

/**
 * Whether a goal's fund is *earmarked* out of the drawable retirement portfolio by
 * its disposition (§5.2). Only `convertToEquity` and `spend` earmark — that money is
 * committed to an imminent purchase / expense, not available for retirement
 * drawdown. `retain` (liquid reserve) and `drawDown` (the nest egg itself) are always
 * drawable. The earmark holds up to AND INCLUDING the target month, so the
 * decumulation channel never taps the fund in the very month it is about to be
 * consumed / converted: the disposition fires at that month's end (see the simulator's
 * `fireGoalDispositions`), zeroing the fund (`spend`) or swapping it to illiquid equity
 * (`convertToEquity`) and dropping the goal from the funding set, so no later month
 * sees a stale earmarked balance to release.
 *
 * Takes the {@link GoalDisposal} pair rather than the two fields separately: passing them
 * apart would let a caller ask about a `spend`-at-`"asap"` goal, which the pairing exists
 * to forbid. Because a firing disposition is typed to a numeric month, no `"asap"` case
 * arises here and none is guarded for — the date is a number by construction.
 */
export function isEarmarkedForDisposition(disposal: GoalDisposal, month: number): boolean {
  // Checks the discriminant directly (not {@link isDisposingDisposition}) so TypeScript
  // narrows the whole GoalDisposal union — that is what pins `targetDate` to a number
  // below; a guard on the `.disposition` field alone would not narrow the parent.
  if (disposal.disposition !== "convertToEquity" && disposal.disposition !== "spend") {
    return false;
  }
  return disposal.targetDate >= month;
}

/**
 * Whether a goal is funded from the shared household pool or one person's own
 * leftover (§5.0 steps 4–5). A `personal` goal names its `ownerId`.
 */
export type GoalScope = "shared" | "personal";

/** A target date is either an absolute simulation month or "as soon as possible". */
export type GoalTargetDate = number | "asap";

/**
 * Dispositions that FIRE at a maturity month — the money is consumed (`spend`) or
 * swapped to illiquid equity (`convertToEquity`) when the target month arrives.
 * A concrete month is structural for these, not a nicety: the firing rule keys off
 * it (`goal.targetDate !== month`), and so does the earmark that keeps the fund out
 * of the drawable nest egg until then.
 */
export type DisposingDisposition = Extract<GoalDisposition, "spend" | "convertToEquity">;

/**
 * Dispositions with no maturity event — the money is held (`retain`) or drawn over a
 * horizon (`drawDown`). Nothing fires, so these may legitimately be dateless: an
 * emergency fund has no purchase date, and "as fast as you can" ({@link GoalTargetDate}
 * `"asap"`) is the honest input rather than an invented deadline.
 */
export type StandingDisposition = Exclude<GoalDisposition, DisposingDisposition>;

/**
 * Whether a disposition FIRES at its maturity month — the money is consumed (`spend`)
 * or swapped to illiquid equity (`convertToEquity`) when the target arrives. The firing
 * dispositions are exactly {@link DisposingDisposition}; the standing ones
 * (`retain`/`drawDown`) never fire. This is the single source of truth for the
 * firing/standing split its boolean consumers key off: the authoring form's date gating
 * (a firing goal needs a concrete month, so it cannot be "as soon as possible") and the
 * verdict-path family — standing goals also encode the old "horizon" timing that may use
 * the near-term asset-ratio branch (see {@link computeGoalProgress}).
 * {@link isEarmarkedForDisposition} instead checks the discriminant directly, because it
 * needs the whole {@link GoalDisposal} union narrowed, not just a boolean.
 */
export function isDisposingDisposition(d: GoalDisposition): d is DisposingDisposition {
  return d === "spend" || d === "convertToEquity";
}

/** The fields every goal carries, whatever its disposition. */
interface GoalBase {
  readonly id: string;
  readonly name: string;
  readonly targetCents: Cents;
  /** The account (or sub-balance) this goal accumulates into. */
  readonly fundAccountId: string;
  /**
   * Drag-to-order priority, shared with retirement (§5.2). Lower number = funded
   * first. This is one of the four exposed waterfall levers (§5.0).
   */
  readonly priority: number;
  readonly scope: GoalScope;
  /** Owner of a `personal` goal; ignored for `shared`. */
  readonly ownerId?: string;
}

/**
 * The legal pairings of a goal's `disposition` with its `targetDate` (§5.2). The two
 * fields are declared as ONE value rather than independently, because only a subset of
 * the combinations means anything:
 *
 * A {@link DisposingDisposition} REQUIRES a numeric month; `"asap"` is rejected. "Spend
 * this as soon as possible" names no month for the spend to happen at, and the engine
 * has no way to invent one — so such a goal would never fire (`fireGoalDispositions`
 * matches `targetDate !== month`) and never be earmarked
 * ({@link isEarmarkedForDisposition} needs a number), leaving its fund to compound
 * forever as drawable money. That is exactly the phantom-fund defect §5.2 / #28 exists
 * to correct, surviving in the one corner the disposition rules couldn't reach.
 *
 * A {@link StandingDisposition} accepts either, since nothing fires and a dateless
 * reserve is a real thing to want: an emergency fund has no purchase date, and "as fast
 * as you can" is honest where an invented deadline is not.
 *
 * Carried as a shared type so {@link Goal} and the authoring-side `GoalPlan` cannot
 * drift apart, and so a mapping between them can pass the pair along as one value —
 * rebuilding the fields separately would decorrelate them and lose the guarantee.
 *
 * What `"asap"` should MEAN for funding pace (a goal with no deadline has no
 * sinking-fund pace to compute) is still open in #26 — deliberately not settled here.
 * This pairing only removes the combinations that cannot be given a meaning at all.
 */
export type GoalDisposal =
  | {
      /** Consumed (`spend`) or swapped to equity (`convertToEquity`) at `targetDate`. */
      readonly disposition: DisposingDisposition;
      /** Absolute simulation month the target is wanted by. Required — see {@link GoalDisposal}. */
      readonly targetDate: number;
    }
  | {
      /** Held as a reserve (`retain`) or drawn over a horizon (`drawDown`); never fires. */
      readonly disposition: StandingDisposition;
      /** Absolute simulation month the target is wanted by, or "asap". */
      readonly targetDate: GoalTargetDate;
    };

/** A funding goal (§5.2). See {@link GoalDisposal} for the `disposition`/`targetDate` pairing. */
export type SimGoal = GoalBase & GoalDisposal;

/**
 * A near-term *standing* goal (`retain`/`drawDown` — the old "horizon") routes to the
 * §8.6 immediate feasibility-verdict branch (asset-ratio path) rather than the
 * projection path — its target date is so close that the projection curve adds no
 * information (§5.2 / §11.3). Firing goals (`spend`/`convertToEquity` — the old
 * "one-time") always use the projection path regardless of proximity.
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

  const monthsToTarget =
    goal.targetDate === "asap" ? 0 : Math.max(0, goal.targetDate - nowMonth);

  // Standing goals (not firing) carry the old "horizon" timing, so a near-term one may
  // use the §8.6 asset-ratio branch; firing goals always project.
  const verdictPath: GoalVerdictPath =
    !isDisposingDisposition(goal.disposition) &&
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
