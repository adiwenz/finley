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
 */
export function updateProjectionPlan(
  state: ProjectionState,
  patch: PlanPatch,
): ProjectionState {
  return withStatePlan(state, withPlanPatch(state.scenario.plan, patch));
}
