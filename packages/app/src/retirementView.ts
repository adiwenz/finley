/**
 * Presentation logic for the retirement panel: the Mode-1 headline ("when can we retire?")
 * and the assessment against the pinned retirement age (on-track % + nearest-feasible
 * date), both read off the REAL projection. The survival math lives in the engine's
 * retirement solver, which runs the same `simulateHousehold` the net-worth graph does — so
 * panel and graph can never disagree.
 *
 * The Medicare / early-retiree health flags stay here: a today's-dollars read on the
 * authored health line, independent of the projection.
 */

import {
  assessEarlyRetireeHealthCost,
  solveRetirement,
  evaluateFullRetirementAtAge,
  type Jurisdiction,
  type ProjectionContext,
  type RetirementEvaluation,
  type EarlyRetireeHealthFlag,
  type Scenario,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { START_YEAR } from "./config";
import type { Plan } from "@finley/engine";

export interface RetirementView {
  /** Mode-1 headline: the earliest age everyone can retire, or null if unreachable. */
  readonly headlineAge: number | null;
  /**
   * The headline age in months from "now", for the chart's retirement reference line.
   */
  readonly headlineMonth: number | null;
  /** The plan's evaluation at the pinned retirement age. */
  readonly target: RetirementEvaluation;
  /**
   * On-track % against the pinned age, rounded DOWN to a tenth of a percent and clamped to
   * [0, 100]. Down, not to-nearest: a plan 99.97% of the way must not round up to a "100%"
   * it hasn't earned, and an infeasible plan's fraction is strictly < 1.
   */
  readonly targetOnTrackPct: number;
  /**
   * Fires when the plan retires before the Medicare-eligibility age with an authored health
   * line below the pre-65 self-funded benchmark. Surfaced as a nudge — an estimate, not
   * advice.
   */
  readonly earlyRetireeHealth: EarlyRetireeHealthFlag;
  /**
   * The authored Medicare residual carried from 65, in **today's dollars** — the user's own
   * {@link Plan.postCoverageHealthMonthlyCents}, not derived. 0 when the plan does not enrol
   * (the pre-65 self-funded line runs for life instead), which
   * {@link enrollsInPublicHealthCoverage} distinguishes.
   */
  readonly residualHealthMonthlyCents: number;
  readonly enrollsInPublicHealthCoverage: boolean;
}

/**
 * The pre-65 early-retiree health flag, in **today's dollars**: the panel and the authored
 * health line are both today's-dollars, so the benchmark is priced at the base year rather
 * than indexed out to the retirement year, which would pit a nominal 2040s cost against a
 * today's-dollars budget. (The rules seam still indexes forward for the nominal
 * projection.) Retiring at/after Medicare eligibility never flags.
 */
function earlyRetireeHealthFlag(
  budget: Plan,
  jurisdiction: Jurisdiction,
): EarlyRetireeHealthFlag {
  return assessEarlyRetireeHealthCost({
    retirementAge: budget.retirementAge,
    // The jurisdiction owns the coverage age (65 under US law). Absent → 0, so the
    // gap window is empty and the flag never fires.
    publicHealthCoverageAge: jurisdiction.publicHealthCoverageAge ?? 0,
    authoredHealthMonthlyCents: budget.healthMonthlyCents,
    selfFundedBenchmarkMonthlyCents:
      jurisdiction.healthCostBenchmarkMonthlyCents?.({
        age: budget.retirementAge,
        year: START_YEAR,
      }) ?? 0,
  });
}

export function retirementView(
  scenario: Scenario,
  jurisdiction: Jurisdiction = usJurisdiction,
): RetirementView {
  // The panel reasons about the whole scenario — plan AND timeline events — exactly as the
  // net-worth graph does.
  const { plan: budget } = scenario;
  const ctx: ProjectionContext = { jurisdiction, startYear: START_YEAR };
  // The headline is the FULL retirement age: everyone stops all their jobs.
  const solution = solveRetirement(scenario, ctx);
  const headlineAge = solution.fullRetirementAge;
  const headlineMonth =
    headlineAge === null ? null : Math.max(0, (headlineAge - budget.currentAge) * 12);
  // The target asks the SAME full-retirement question at the pinned age, so when the pin
  // can't make it the nearest-feasible age is the headline — one rule for pin and fallback,
  // reusing the solver's search rather than a second one that could drift.
  const evaluation = evaluateFullRetirementAtAge(scenario, budget.retirementAge, ctx);
  const target: RetirementEvaluation = {
    ...evaluation,
    nearestFeasibleAge: evaluation.feasible ? evaluation.retirementAge : headlineAge,
  };
  return {
    headlineAge,
    headlineMonth,
    target,
    targetOnTrackPct: Math.min(100, Math.max(0, Math.floor(target.onTrackFraction * 1000) / 10)),
    earlyRetireeHealth: earlyRetireeHealthFlag(budget, jurisdiction),
    residualHealthMonthlyCents: budget.enrollsInPublicHealthCoverage
      ? budget.postCoverageHealthMonthlyCents
      : 0,
    enrollsInPublicHealthCoverage: budget.enrollsInPublicHealthCoverage,
  };
}
