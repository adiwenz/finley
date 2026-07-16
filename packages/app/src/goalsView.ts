/**
 * Pure presentation logic for the Goals panel (§5.2). Scores each plan goal
 * against the projection via the engine's projection-based on-track math, and
 * reprioritizes the goal list. Reordering here changes who the waterfall funds
 * first, so the *other* goals' on-track numbers visibly move (§5.2 tradeoff) —
 * the whole point of a shared priority list.
 */

import {
  computeGoalProgress,
  buildPlanAccounts,
  buildPlanGoals,
  type ProjectionSeries,
} from "@finley/engine";
import type { Plan, GoalPlan } from "@finley/engine";

export interface GoalRow {
  readonly id: string;
  readonly name: string;
  readonly targetCents: number;
  readonly targetDate: number | "asap";
  /** 0-based priority (position in the funding order); 0 is funded first. */
  readonly priority: number;
  /**
   * Projected fund at target ÷ target, as a whole-number percent, capped at 100
   * (§5.2). A funded goal keeps earning its account's return, so its raw fraction
   * drifts past 1.0 — but the waterfall stops depositing once the target is met
   * and the surplus flows on, so "done" is 100%, never more.
   */
  readonly onTrackPct: number;
  /** Annual return on this goal's fund account, whole-number percent. */
  readonly annualReturnPct: number;
  /** True when a near-term goal accumulates into an equity-like account (§5.2). */
  readonly shortHorizonRiskFlag: boolean;
}

/**
 * One row per goal, in priority order, each scored against the projection. The
 * projection must be the one built from the SAME `budget`, so the fund-account
 * balances it reports line up with the goals' `fundAccountId`s.
 */
export function goalRows(budget: Plan, projection: ProjectionSeries): GoalRow[] {
  const goals = buildPlanGoals(budget);
  const accounts = buildPlanAccounts(budget);
  // `goals` is `budget.goals` mapped in order, so the plan goal at the same index
  // carries this row's editable rate.
  return goals.map((goal, i) => {
    const progress = computeGoalProgress(goal, projection, accounts);
    return {
      id: goal.id,
      name: goal.name,
      targetCents: goal.targetCents,
      targetDate: goal.targetDate,
      priority: goal.priority,
      onTrackPct: Math.min(100, Math.round(progress.onTrackFraction * 100)),
      annualReturnPct: budget.goals[i].annualReturnPct,
      shortHorizonRiskFlag: progress.shortHorizonRiskFlag,
    };
  });
}

/** Set one goal's fund-account return rate (whole-number percent), returning a new array. */
export function setGoalRate(
  goals: readonly GoalPlan[],
  id: string,
  annualReturnPct: number,
): GoalPlan[] {
  return goals.map((g) => (g.id === id ? { ...g, annualReturnPct } : g));
}

/**
 * Move a goal one slot earlier ("up", funded sooner) or later ("down") in the
 * priority order, returning a new array. A no-op at the ends. Since priority is
 * array position, this is the only reprioritization primitive the panel needs.
 */
export function reorderGoal(
  goals: readonly GoalPlan[],
  id: string,
  direction: "up" | "down",
): GoalPlan[] {
  const index = goals.findIndex((g) => g.id === id);
  if (index === -1) return [...goals];
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= goals.length) return [...goals];
  const next = [...goals];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
