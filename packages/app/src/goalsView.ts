/**
 * Pure presentation logic for the Goals panel: scores each plan goal against the projection
 * via the engine's on-track math, and reprioritizes the list. Reordering changes who the
 * waterfall funds first, so the *other* goals' on-track numbers move — the tradeoff a
 * shared priority list exists to show.
 */

import {
  computeGoalProgress,
  buildPlanAccounts,
  buildPlanGoals,
  type ProjectionSeries,
} from "@finley/engine";
import type {
  Plan,
  GoalPlan,
  GoalDisposition,
  GoalDisposal,
  GoalAccountType,
  GoalCompletion,
} from "@finley/engine";

export function dispositionLabel(disposition: GoalDisposition): string {
  switch (disposition) {
    case "retain":
      return "Kept as a reserve";
    case "drawDown":
      return "Drawn down over time";
  }
}

export interface GoalRow {
  readonly id: string;
  readonly name: string;
  readonly targetCents: number;
  readonly targetDate: number | "asap";
  /** Position in the funding order; 0 is funded first. */
  readonly priority: number;
  /**
   * Projected fund at target ÷ target, whole-number percent, capped at 100. A funded goal
   * keeps earning its account's return so the raw fraction drifts past 1.0, but the
   * waterfall stops depositing at target — "done" is 100%, never more.
   */
  readonly onTrackPct: number;
  /** Whole-number percent. */
  readonly annualReturnPct: number;
  /** True when a near-term goal accumulates into an equity-like account. */
  readonly shortHorizonRiskFlag: boolean;
  /** Latched: In Progress until the fund reaches target on/before the date, then Funded. */
  readonly completion: GoalCompletion;
  /** True when a still-In-Progress goal is off pace (raw on-track fraction < 1). */
  readonly behindPace: boolean;
  readonly disposition: GoalDisposition;
  readonly dispositionLabel: string;
}

/**
 * Rows in priority order. The projection MUST be built from the SAME `budget`, so its
 * fund-account balances line up with the goals' `fundAccountId`s.
 */
export function goalRows(budget: Plan, projection: ProjectionSeries): GoalRow[] {
  const goals = buildPlanGoals(budget);
  const accounts = buildPlanAccounts(budget);
  // `goals` is `budget.goals` mapped in order, so the plan goal at the same index carries
  // this row's editable rate.
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
      completion: progress.completion,
      behindPace: progress.completion === "inProgress" && progress.onTrackFraction < 1,
      disposition: goal.disposition,
      dispositionLabel: dispositionLabel(goal.disposition),
    };
  });
}

export function setGoalRate(
  goals: readonly GoalPlan[],
  id: string,
  annualReturnPct: number,
): GoalPlan[] {
  return goals.map((g) => (g.id === id ? { ...g, annualReturnPct } : g));
}

/**
 * The user-authorable shape of a goal — every {@link GoalPlan} field EXCEPT the stable
 * `id`, which the plan owns (add mints a fresh one; edit keeps the old).
 */
export type GoalDraft = {
  readonly name: string;
  readonly targetCents: number;
  readonly annualReturnPct: number;
  /**
   * Optional so a draft omitting it keeps the engine's legacy default (a capital-gains
   * investment); the form always supplies one.
   */
  readonly accountType?: GoalAccountType;
} & GoalDisposal;

/** Selectable goal account types, in the order the form lists them; the default is `"cash"`. */
export const GOAL_ACCOUNT_TYPES: readonly {
  readonly value: GoalAccountType;
  readonly label: string;
}[] = [
  { value: "cash", label: "Cash / savings" },
  { value: "brokerage", label: "Taxable brokerage" },
  { value: "taxExempt", label: "Tax-exempt (Roth-like)" },
  { value: "preTax", label: "Pre-tax retirement" },
];

/** Pair two independently-held form controls; every disposition accepts either date form. */
export function goalDisposal(
  disposition: GoalDisposition,
  targetDate: number | "asap",
): GoalDisposal {
  return { disposition, targetDate };
}

/**
 * Deterministic (same list → same id), so the transforms that mint it stay pure. Ids only
 * drive each goal's derived `goal-<id>` fund account, so they need not be meaningful.
 */
export function freshGoalId(goals: readonly GoalPlan[]): string {
  const used = new Set(goals.map((g) => g.id));
  let n = 1;
  while (used.has(`goal${n}`)) n++;
  return `goal${n}`;
}

/** Append a goal at lowest priority — priority is array index. A direct value-plane
 * override, no timeline event. */
export function addGoal(goals: readonly GoalPlan[], draft: GoalDraft): GoalPlan[] {
  return [...goals, { id: freshGoalId(goals), ...draft }];
}

/**
 * Replace one goal's authorable fields, keeping its id and list position so priority is
 * unchanged. Returns a fresh array even when `id` matches nothing.
 */
export function updateGoal(
  goals: readonly GoalPlan[],
  id: string,
  draft: GoalDraft,
): GoalPlan[] {
  return goals.map((g) => (g.id === id ? { id, ...draft } : g));
}

/**
 * Drop a goal. Its derived `goal-<id>` fund account falls away with it —
 * `buildPlanAccounts` mints one account per remaining goal.
 */
export function removeGoal(goals: readonly GoalPlan[], id: string): GoalPlan[] {
  return goals.filter((g) => g.id !== id);
}

/**
 * Move a goal one slot earlier ("up", funded sooner) or later ("down"); a no-op at the
 * ends. Since priority is array position, this is the only reprioritization primitive.
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
