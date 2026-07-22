/**
 * Presentation logic for the retirement panel (§7). Reads the two things the UI
 * needs off the REAL projection (§5): the Mode-1 headline ("when can we retire?")
 * and the target-mode assessment against the pinned retirement age (on-track % +
 * honest nearest-feasible date, §7.1). The survival math lives in the engine's
 * retirement solver (`@finley/engine`), which runs the same `simulateHousehold` the
 * net-worth graph does — so the panel's answer and the graph can never disagree (#37).
 *
 * The Medicare / early-retiree health honesty flags (§5.4) stay here: they are a
 * today's-dollars read on the authored health line, independent of the projection.
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
   * Absolute simulation month for the chart's retirement reference line — the
   * headline age converted to months from "now". Null when there is no feasible age.
   */
  readonly headlineMonth: number | null;
  /** The plan's evaluation at the pinned retirement age (§7.1). */
  readonly target: RetirementEvaluation;
  /**
   * On-track % against the pinned age (§7.1), rounded DOWN to a tenth of a percent and
   * clamped to [0, 100]. Rounding down (not to-nearest) is deliberate: a plan 99.97% of
   * the way must not round UP to a reassuring "100%" it hasn't earned — and an infeasible
   * plan's fraction is strictly < 1 (#78), so the floor keeps it honestly below 100.
   */
  readonly targetOnTrackPct: number;
  /**
   * Medicare honesty flag (§5.4): fires when the plan retires before the
   * Medicare-eligibility age but its authored health line is below the elevated
   * pre-65 self-funded benchmark. The panel surfaces it as a "you'll self-fund
   * coverage until 65" nudge — an estimate, not advice.
   */
  readonly earlyRetireeHealth: EarlyRetireeHealthFlag;
  /**
   * The authored Medicare residual the plan carries from 65 (§5.4), in **today's
   * dollars** — the user's own {@link Plan.postCoverageHealthMonthlyCents},
   * not a derived figure. 0 when the plan does not enrol in Medicare (no residual —
   * the pre-65 self-funded line runs for life instead); {@link enrollsInPublicHealthCoverage}
   * tells the panel which story to tell.
   */
  readonly residualHealthMonthlyCents: number;
  /** Whether the plan enrols in Medicare at 65 (§5.4) — drives the panel's post-65 copy. */
  readonly enrollsInPublicHealthCoverage: boolean;
}

/**
 * The pre-65 early-retiree health honesty flag for the plan (§5.4), in **today's
 * dollars**. The retirement panel is a real / today's-dollars surface (§0.5) and
 * the authored health line is a today's-dollars figure, so the benchmark is priced
 * at the base year too — NOT indexed out to the future retirement year, which would
 * pit a nominal 2040s cost against a today's-dollars budget. (The rules seam still
 * indexes forward for the nominal projection; this panel just asks in today's
 * terms.) Retiring at/after Medicare eligibility never flags (no self-funded gap).
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
  // The panel reasons about the whole scenario — the plan AND its timeline events (a
  // child at 40, a new expense, a separation) — so "when can we retire?" accounts for
  // everything on the user's timeline, exactly as the net-worth graph does.
  const { plan: budget } = scenario;
  // The app supplies the engine's projection environment: the frozen "now" plus the
  // jurisdiction the solver resolves the real projection against.
  const ctx: ProjectionContext = { jurisdiction, startYear: START_YEAR };
  // `solveRetirement` runs all §5 searches off the same real projection. The headline
  // "when can we retire?" is the FULL retirement age — the honest "you can stop ALL your
  // jobs" milestone people actually ask about (issue #66).
  const solution = solveRetirement(scenario, ctx);
  const headlineAge = solution.fullRetirementAge;
  const headlineMonth =
    headlineAge === null ? null : Math.max(0, (headlineAge - budget.currentAge) * 12);
  // The target assessment asks the SAME full-retirement question at the user's pinned
  // age: if they stop all jobs at `retirementAge`, do they survive, and how on-track are
  // they? So the nearest-feasible age when the pin can't make it is the earliest full
  // retirement age — which is exactly the headline. Grading the pin and its fallback by
  // one rule keeps the panel consistent, and reusing the solver's search can't drift.
  const evaluation = evaluateFullRetirementAtAge(scenario, budget.retirementAge, ctx);
  const target: RetirementEvaluation = {
    ...evaluation,
    nearestFeasibleAge: evaluation.feasible ? evaluation.retirementAge : headlineAge,
  };
  return {
    headlineAge,
    headlineMonth,
    target,
    // Floor to 0.1% so a hair under 100 never rounds up to 100 (§7.1, #78).
    targetOnTrackPct: Math.min(100, Math.max(0, Math.floor(target.onTrackFraction * 1000) / 10)),
    earlyRetireeHealth: earlyRetireeHealthFlag(budget, jurisdiction),
    // The authored residual (today's dollars); 0 and moot when not enrolling.
    residualHealthMonthlyCents: budget.enrollsInPublicHealthCoverage
      ? budget.postCoverageHealthMonthlyCents
      : 0,
    enrollsInPublicHealthCoverage: budget.enrollsInPublicHealthCoverage,
  };
}
