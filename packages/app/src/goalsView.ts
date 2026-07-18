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
  isDisposingDisposition,
  type ProjectionSeries,
} from "@finley/engine";
import type { Plan, GoalPlan, GoalDisposition, GoalDisposal } from "@finley/engine";

/**
 * Plain-language rendering of a goal's {@link GoalDisposition} — the fate of the
 * accumulated money at target (§5.2). The engine drives the money's actual
 * behavior off the disposition; this only names it for the user so the Goals
 * panel makes explicit *what becomes of it* (issue #28), which the on-track %
 * alone never conveys.
 */
export function dispositionLabel(disposition: GoalDisposition): string {
  switch (disposition) {
    case "retain":
      return "Kept as a reserve";
    case "convertToEquity":
      return "Becomes home equity";
    case "spend":
      return "Spent at target";
    case "drawDown":
      return "Drawn down over time";
  }
}

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
  /** What becomes of the money at target (§5.2) — see {@link GoalDisposition}. */
  readonly disposition: GoalDisposition;
  /** Plain-language rendering of {@link disposition} for display. */
  readonly dispositionLabel: string;
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
      disposition: goal.disposition,
      dispositionLabel: dispositionLabel(goal.disposition),
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
 * The user-authorable shape of a goal — every field on {@link GoalPlan} EXCEPT its
 * stable `id`, which the plan owns (add mints a fresh one; edit keeps the old). The
 * `disposition`/`targetDate` pair is carried as the engine's {@link GoalDisposal}
 * union so an authoring form cannot construct an illegal pairing (a firing
 * disposition with no month to fire at — §5.2).
 */
export type GoalDraft = {
  readonly name: string;
  readonly targetCents: number;
  readonly annualReturnPct: number;
} & GoalDisposal;

/**
 * Build a legal {@link GoalDisposal} from an independently-held disposition and date
 * — the shape an authoring form keeps its two controls in. A firing disposition
 * (`spend`/`convertToEquity`) MUST land on a concrete month, so a stray `"asap"`
 * collapses to month 0 rather than producing the illegal pair the engine's
 * {@link GoalDisposal} exists to forbid. Standing dispositions keep their date as-is.
 */
export function goalDisposal(
  disposition: GoalDisposition,
  targetDate: number | "asap",
): GoalDisposal {
  if (isDisposingDisposition(disposition)) {
    return { disposition, targetDate: targetDate === "asap" ? 0 : targetDate };
  }
  return { disposition, targetDate };
}

/**
 * A goal id not already used by any goal in the list — deterministic (same list →
 * same id), so the transforms that mint it stay pure. Ids drive each goal's derived
 * `goal-<id>` fund account, so they only need to be unique, not meaningful.
 */
export function freshGoalId(goals: readonly GoalPlan[]): string {
  const used = new Set(goals.map((g) => g.id));
  let n = 1;
  while (used.has(`goal${n}`)) n++;
  return `goal${n}`;
}

/**
 * Append a new goal at lowest priority (last position; §5.2 priority is array index),
 * returning a new array. A direct value-plane override — no timeline event (§4.2/§10.3).
 * The id is minted from the current list so the transform stays pure.
 */
export function addGoal(goals: readonly GoalPlan[], draft: GoalDraft): GoalPlan[] {
  return [...goals, { id: freshGoalId(goals), ...draft }];
}

/**
 * Replace one goal's authorable fields with `draft`, keeping its id and list position
 * (so priority is unchanged), returning a new array. A no-op (still a fresh array) when
 * `id` matches nothing. Re-projecting the result moves this goal's on-track % — and,
 * where funding competes, the others' — the same live feedback loop reorder has (§5.2).
 */
export function updateGoal(
  goals: readonly GoalPlan[],
  id: string,
  draft: GoalDraft,
): GoalPlan[] {
  return goals.map((g) => (g.id === id ? { id, ...draft } : g));
}

/**
 * Drop a goal, returning a new array. Its derived `goal-<id>` fund account falls away
 * with it — `buildPlanAccounts` mints one account per remaining goal, so removing the
 * goal removes the account (§5.2). A direct override — no timeline event (§4.2/§10.3).
 */
export function removeGoal(goals: readonly GoalPlan[], id: string): GoalPlan[] {
  return goals.filter((g) => g.id !== id);
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
