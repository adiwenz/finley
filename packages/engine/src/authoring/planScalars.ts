/**
 * The plan's standing scalars — the numbers that hold no identity and so need no mint.
 *
 * Its own module for the same reason the collections have theirs: the facade delegates every
 * write, so there is no write transform it names directly and no path around one.
 */

import type { PlanPatch } from "../plan/plan";
import { withPlanPatch } from "../plan/plan";
import type { ProjectionState } from "./state";
import { withStatePlan } from "./state";

/**
 * Patch the plan's standing scalars — opening balance, the return and inflation rates, the
 * health-cost fields, the ages, the household levers, the name. The collections are NOT reachable
 * from here, in the type or at runtime (see {@link withPlanPatch}): every goal / job /
 * budget-line edit goes through the module that mints its id and enforces its rules.
 *
 * A patch that moves the primary's `birthYear` or `lifeExpectancy` moves the month they die, which
 * everything the primary takes part in is dated against — every marriage and separation in the
 * timeline, every loan and home they own, every job they start. {@link withStatePlan} checks the
 * prospective state for exactly that, so an edit that would strand one of them past somebody's
 * death is refused here rather than quietly leaving an event nobody lives to see.
 */
export function updateProjectionPlan(
  state: ProjectionState,
  patch: PlanPatch,
): ProjectionState {
  return withStatePlan(state, withPlanPatch(state.scenario.plan, patch, state.startYear));
}
