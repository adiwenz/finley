/**
 * The retirement question answered whole: when can this household stop working?
 *
 * A plain function of authored state for the same reason a run is — nothing here derives a state
 * back — and separate from `../projectionRun` because it is a *search* over many simulations, each
 * at a candidate retirement age, rather than one pass. A caller that only wants the graph never
 * pays for it.
 *
 * There is no second half any more. This used to also score the plan's own pinned `retirementAge`
 * and report an on-track percentage against it, with a fallback rule tying the two together. The
 * plan no longer pins an age — every job states its own end — so the search's answer is the whole
 * answer, and the health flag below reads that answer rather than a figure beside it.
 */

import type { Jurisdiction } from "../jurisdiction";
import type { ProjectionState } from "../authoring/state";
import type { ProjectionContext } from "../compile/projectionBase";
import { solveRetirement } from "./retirementSolver";
import type { RetirementSolution } from "./retirementTypes";
import { healthcareMonthlyCents } from "../budgetLine";
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
   * {@link RetirementSolution.blockedAtMonth} as the primary's age, or `null` when the projection
   * was not blocked — the mirror of {@link fullRetirementMonth}, which converts the other way.
   *
   * Here rather than at the caller because the primary's clock is the engine's: months and ages
   * are the same axis read two ways, and a surface that converts between them is re-deriving where
   * "now" sits on a plan it can only see the outside of. Floored to whole years, like every age
   * the engine reports.
   */
  readonly blockedAtAge: number | null;
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
 *
 * Measured at the SOLVED age — the earliest the household could actually stop — because that is
 * the retirement whose gap they would live through. It was measured against the plan's pinned
 * `retirementAge` while one existed, which flagged a gap for a retirement the plan could not
 * afford to take. A household with no feasible age has no retirement to open a gap, so the flag
 * stays quiet rather than guessing one.
 */
function earlyRetireeHealth(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  retirementAge: number | null,
): EarlyRetireeHealthFlag {
  const plan = state.scenario.plan;
  if (retirementAge === null) {
    return { flagged: false, gapYears: 0, shortfallMonthlyCents: 0 };
  }
  return assessEarlyRetireeHealthCost({
    retirementAge,
    publicHealthCoverageAge: jurisdiction.publicHealthCoverageAge ?? 0,
    authoredHealthMonthlyCents: healthcareMonthlyCents(plan.budgetLines),
    selfFundedBenchmarkMonthlyCents:
      jurisdiction.healthCostBenchmarkMonthlyCents?.({
        age: retirementAge,
        year: state.startYear,
      }) ?? 0,
  });
}

/**
 * Search `state` for the earliest feasible retirement age, and read the health gap off the age
 * that search returned. Not separately callable, because the flag is a fact about the solved
 * age rather than an answer of its own.
 */
export function buildRetirementOutlook(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
): RetirementOutlook {
  const ctx = retirementContext(state, jurisdiction);
  const plan = state.scenario.plan;
  const solution = solveRetirement(state.scenario, ctx);
  return Object.freeze({
    solution,
    // The headline is the FULL retirement age: everyone stops all their jobs.
    fullRetirementMonth:
      solution.fullRetirementAge === null
        ? null
        : Math.max(0, (solution.fullRetirementAge - plan.currentAge) * 12),
    // The block's month back on the primary's clock, for a panel that reports an age rather than
    // a month offset. `blocked` without a month cannot happen, but is read as "no age to state"
    // rather than as age `currentAge`.
    blockedAtAge:
      solution.blocked && solution.blockedAtMonth !== undefined
        ? plan.currentAge + Math.floor(solution.blockedAtMonth / 12)
        : null,
    earlyRetireeHealth: earlyRetireeHealth(state, jurisdiction, solution.fullRetirementAge),
  });
}
