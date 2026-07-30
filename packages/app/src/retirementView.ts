/**
 * Presentation logic for the retirement panel: the Mode-1 headline ("when can we retire?")
 * and the assessment against the pinned retirement age (on-track % + nearest-feasible
 * date), both read off the REAL projection. The survival math lives in the engine's
 * retirement solver, which runs the same `simulateHousehold` the net-worth graph does — so
 * panel and graph can never disagree.
 *
 * The whole answer comes from one `retirement()` call, so the headline and the pinned-age
 * verdict are always two readings of the same search. What is left in this module is
 * presentation: the on-track rounding rule, and the two authored health figures the panel
 * shows beside the flag.
 */

import type {
  Jurisdiction,
  Plan,
  Projection,
  RetirementEvaluation,
  EarlyRetireeHealthFlag,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";

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
 * What this view reads, and nothing else. Narrow on purpose: it says the view cannot author,
 * and a test standing in for it states two members rather than a whole projection.
 */
type RetirementSource = Pick<Projection, "plan" | "retirement">;

export function retirementView(
  projection: RetirementSource,
  jurisdiction: Jurisdiction = usJurisdiction,
): RetirementView {
  // The panel reasons about the whole scenario — plan AND timeline events — exactly as the
  // net-worth graph does, because it asks the same handle.
  const budget: Plan = projection.plan;
  const { solution, fullRetirementMonth, target, earlyRetireeHealth } =
    projection.retirement(jurisdiction);
  return {
    headlineAge: solution.fullRetirementAge,
    headlineMonth: fullRetirementMonth,
    target,
    targetOnTrackPct: Math.min(100, Math.max(0, Math.floor(target.onTrackFraction * 1000) / 10)),
    earlyRetireeHealth,
    residualHealthMonthlyCents: budget.enrollsInPublicHealthCoverage
      ? budget.postCoverageHealthMonthlyCents
      : 0,
    enrollsInPublicHealthCoverage: budget.enrollsInPublicHealthCoverage,
  };
}
