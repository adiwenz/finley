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
  earliestFeasibleRetirementAge,
  evaluateAtAge,
  type Jurisdiction,
  type ProjectionContext,
  type RetirementEvaluation,
  type EarlyRetireeHealthFlag,
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
  /** On-track % against the pinned age, whole-number and capped at 100 (§7.1). */
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
   * dollars** — the user's own {@link Plan.postMedicareHealthMonthlyCents},
   * not a derived figure. 0 when the plan does not enrol in Medicare (no residual —
   * the pre-65 self-funded line runs for life instead); {@link enrollsInMedicare}
   * tells the panel which story to tell.
   */
  readonly medicareResidualMonthlyCents: number;
  /** Whether the plan enrols in Medicare at 65 (§5.4) — drives the panel's post-65 copy. */
  readonly enrollsInMedicare: boolean;
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
  budget: Plan,
  jurisdiction: Jurisdiction = usJurisdiction,
): RetirementView {
  // The app supplies the engine's projection environment: the frozen "now" plus the
  // jurisdiction the solver resolves the real projection against.
  const ctx: ProjectionContext = { jurisdiction, startYear: START_YEAR };
  const headlineAge = earliestFeasibleRetirementAge(budget, ctx);
  const headlineMonth =
    headlineAge === null ? null : Math.max(0, (headlineAge - budget.currentAge) * 12);
  // Compose the full evaluation: `evaluateAtAge` at the pin gives feasibility + on-track
  // %; the nearest-feasible age is a headline-mode fact — the pin itself when it
  // survives, else the earliest surviving age (the headline we just computed). Doing it
  // here reuses the one binary search and can't drift.
  const evaluation = evaluateAtAge(budget, budget.retirementAge, ctx);
  const target: RetirementEvaluation = {
    ...evaluation,
    nearestFeasibleAge: evaluation.feasible ? evaluation.retirementAge : headlineAge,
  };
  return {
    headlineAge,
    headlineMonth,
    target,
    targetOnTrackPct: Math.min(100, Math.max(0, Math.round(target.onTrackFraction * 100))),
    earlyRetireeHealth: earlyRetireeHealthFlag(budget, jurisdiction),
    // The authored residual (today's dollars); 0 and moot when not enrolling.
    medicareResidualMonthlyCents: budget.enrollsInMedicare
      ? budget.postMedicareHealthMonthlyCents
      : 0,
    enrollsInMedicare: budget.enrollsInMedicare,
  };
}
