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
import { assertSeparationsStillReachable } from "./relationships";

/**
 * Patch the plan's standing scalars — opening balance, the return and inflation rates, the
 * health-cost fields, the ages, the household levers, the name. The collections are NOT reachable
 * from here, in the type or at runtime (see {@link withPlanPatch}): every goal / job /
 * budget-line edit goes through the module that mints its id and enforces its rules.
 *
 * A patch that moves the primary's `birthYear` or `lifeExpectancy` moves the month they die, which
 * every separation in the timeline is dated against — the primary is a partner in all of them. The
 * prospective state is therefore checked before it is returned, so an edit that would strand a
 * separation past somebody's death is refused instead of quietly leaving one unreachable.
 */
export function updateProjectionPlan(
  state: ProjectionState,
  patch: PlanPatch,
): ProjectionState {
  const next = withStatePlan(state, withPlanPatch(state.scenario.plan, patch, state.startYear));
  assertSeparationsStillReachable(next);
  return next;
}
