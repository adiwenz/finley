/**
 * Goal authoring, and the funding guard that makes removal different from every other plan edit.
 *
 * A goal is the one authored thing whose id the ledger can point at: its `fund-<id>` account is
 * what a money-out event spends from. So removal has to ask the timeline first, and the same
 * reading is offered ahead of time through {@link projectionEventsFundedByGoal} — a caller can
 * say which events to fix rather than only that it cannot delete.
 */

import type { GoalPatch, GoalPlan } from "../plan";
import { withGoalPatch, withGoalReordered, withoutGoal } from "../plan";
import { eventsFundedByGoal, validateGoalRemoval } from "../goalFunding";
import type { LifeEvent } from "../ledger/eventTypes";
import type { ProjectionState, Written } from "./state";
import { planSite, withStatePlan } from "./state";
import { mint } from "./mint";

export type GoalInput = Omit<GoalPlan, "id">;

/** Appended, so lowest funding priority. Answers with the minted `"goal-N"` id. */
export function addProjectionGoal(
  state: ProjectionState,
  goal: GoalInput,
): Written<string> {
  const { id, nextSeq } = mint(state, "goal");
  const newGoal = { id, ...goal } as GoalPlan;
  const plan = state.scenario.plan;
  return {
    state: withStatePlan(state, { ...plan, goals: [...plan.goals, newGoal] }, nextSeq),
    result: id,
  };
}

/**
 * See {@link withGoalPatch}. Editing keeps the `id`, so the `fund-<id>` fund account is stable
 * and no funding reference can dangle — which is why, unlike {@link removeProjectionGoal}, this
 * needs no funding guard. Refused for an id the plan does not hold.
 */
export function updateProjectionGoal(
  state: ProjectionState,
  id: string,
  patch: GoalPatch,
): ProjectionState {
  const plan = planSite(state, "goals", id);
  return withStatePlan(state, { ...plan, goals: withGoalPatch(plan.goals, id, patch) });
}

/**
 * Drop a goal and, with it, the derived fund account that is its balance. REFUSED while any
 * event still spends from that account: the account would vanish out from under a reference the
 * ledger keeps, so the removal is a no-op and this throws with nothing derived — the same
 * contract a refused transaction gives.
 *
 * Removing a goal that no event funds is a plain plan swap; an id the plan does not hold is
 * refused like any other edit.
 */
export function removeProjectionGoal(state: ProjectionState, id: string): ProjectionState {
  const plan = planSite(state, "goals", id);
  const check = validateGoalRemoval(plan.goals, id, state.scenario.ledger);
  if (!check.ok) {
    throw new Error(`Projection: cannot remove goal — ${check.reason}`);
  }
  return withStatePlan(state, { ...plan, goals: withoutGoal(plan.goals, id) });
}

/**
 * See {@link withGoalReordered}. {@link addProjectionGoal} only appends, so this is the sole way
 * a caller reprioritizes a goal after authoring it.
 *
 * Refused at the ends, like any other edit that cannot happen: "move the first goal up" is a
 * caller believing it changed the funding order when it did not, and priority IS the order. A UI
 * offering the control disables it there rather than calling and ignoring the answer.
 */
export function reorderProjectionGoal(
  state: ProjectionState,
  id: string,
  direction: "up" | "down",
): ProjectionState {
  const plan = planSite(state, "goals", id);
  const index = plan.goals.findIndex((g) => g.id === id);
  const edge = direction === "up" ? 0 : plan.goals.length - 1;
  if (index === edge) {
    const place = direction === "up" ? "first" : "last";
    throw new Error(`Projection: cannot reorder goal — "${id}" is already ${place}`);
  }
  return withStatePlan(state, { ...plan, goals: withGoalReordered(plan.goals, id, direction) });
}

/**
 * The timeline events a goal's fund account pays for — what blocks its deletion, in timeline
 * order. {@link removeProjectionGoal} refuses on the same reading; this is it asked ahead of
 * time.
 */
export function projectionEventsFundedByGoal(
  state: ProjectionState,
  goalId: string,
): readonly LifeEvent[] {
  const s = state.scenario;
  return eventsFundedByGoal(s.plan.goals, goalId, s.ledger);
}
