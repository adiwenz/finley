/**
 * The retirement question answered whole: when can this household retire, and does the age it
 * picked work?
 *
 * A plain function of authored state for the same reason a run is — nothing here derives a state
 * back — and separate from `./projectionRun` because it is a *search* over many simulations, each
 * at a candidate retirement age, rather than one pass. A caller that only wants the graph never
 * pays for it.
 *
 * Assembled in one place because the parts are not independent. The target's fallback when the
 * pinned age fails is an age the SAME search found, so a caller stitching the pieces together
 * would have to re-derive that rule — which is how a panel and a chart come to disagree about a
 * household that cannot retire at all.
 */

import type { Jurisdiction } from "./jurisdiction";
import type { ProjectionState } from "./authoring/state";
import type { ProjectionContext } from "./projectionBase";
import { evaluateFullRetirementAtAge, solveRetirement } from "./retirementSolver";
import type { RetirementEvaluation, RetirementSolution } from "./retirementTypes";
import { assessEarlyRetireeHealthCost } from "./earlyRetireeHealthCheck";
import type { EarlyRetireeHealthFlag } from "./earlyRetireeHealthCheck";

/** What {@link buildRetirementOutlook} answers: the whole retirement question, in one value. */
export interface RetirementOutlook {
  /** The earliest ages the search reached, partial and full; `null` where the money runs out. */
  readonly solution: RetirementSolution;
  /**
   * {@link solution}'s full-retirement age as months from "now", or `null` with the age — what
   * a chart draws its retirement reference line at.
   */
  readonly fullRetirementMonth: number | null;
  /**
   * The plan's own `retirementAge`, evaluated as a full retirement. `nearestFeasibleAge` is
   * resolved here: the pinned age when it survives, else the earliest age the same search
   * found.
   */
  readonly target: RetirementEvaluation;
  /** Whether retiring on this plan opens a pre-coverage health gap, and how large. */
  readonly earlyRetireeHealth: EarlyRetireeHealthFlag;
}

/**
 * The context the retirement searches run in. Their own question, not a run's: each re-simulates
 * the scenario at a *candidate* age, so none of them can be answered off a completed pass.
 */
function retirementContext(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
): ProjectionContext {
  return { jurisdiction, startYear: state.startYear };
}

/**
 * The pre-coverage health gap: retiring before the jurisdiction's public-coverage age with an
 * authored health line under the self-funded benchmark. Priced in **today's dollars** — at
 * the plan's own start year rather than indexed out to the retirement year — because the
 * authored line it is compared against is today's-dollars too, and pitting a nominal cost
 * against a real budget would flag every plan. Never fires at or after the coverage age.
 *
 * A jurisdiction naming no coverage age has no gap window at all, so the flag stays quiet
 * rather than treating "unknown" as "never covered".
 */
function earlyRetireeHealth(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
): EarlyRetireeHealthFlag {
  const plan = state.scenario.plan;
  return assessEarlyRetireeHealthCost({
    retirementAge: plan.retirementAge,
    publicHealthCoverageAge: jurisdiction.publicHealthCoverageAge ?? 0,
    authoredHealthMonthlyCents: plan.healthMonthlyCents,
    selfFundedBenchmarkMonthlyCents:
      jurisdiction.healthCostBenchmarkMonthlyCents?.({
        age: plan.retirementAge,
        year: state.startYear,
      }) ?? 0,
  });
}

/**
 * Search `state` for the earliest feasible retirement ages and evaluate the plan's own target
 * against the same search. Neither half is separately callable, because neither is a separate
 * answer.
 */
export function buildRetirementOutlook(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
): RetirementOutlook {
  const ctx = retirementContext(state, jurisdiction);
  const plan = state.scenario.plan;
  const solution = solveRetirement(state.scenario, ctx);
  const evaluation = evaluateFullRetirementAtAge(state.scenario, plan.retirementAge, ctx);
  return Object.freeze({
    solution,
    // The headline is the FULL retirement age: everyone stops all their jobs.
    fullRetirementMonth:
      solution.fullRetirementAge === null
        ? null
        : Math.max(0, (solution.fullRetirementAge - plan.currentAge) * 12),
    target: {
      ...evaluation,
      // One rule for the pin and its fallback: an age the plan cannot reach falls back to the
      // earliest age the same search found, so the two can never name different households.
      nearestFeasibleAge: evaluation.feasible
        ? evaluation.retirementAge
        : solution.fullRetirementAge,
    },
    earlyRetireeHealth: earlyRetireeHealth(state, jurisdiction),
  });
}
