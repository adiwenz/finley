/**
 * Presentation logic for the retirement panel: the headline answer to "when could this household
 * stop working?", read off the REAL projection. The survival math lives in the engine's
 * retirement solver, which runs the same `simulateHousehold` the net-worth graph does — so panel
 * and graph can never disagree.
 *
 * The whole answer comes from one `retirement()` call, which leaves this module a thin read: the
 * solved age, what reaching it assumed, when the authored plan stops earning on its own AND
 * whether that plan survives, and the health flag beside them.
 *
 * The authored plan and the solved age are two results, not one number and a caveat — see
 * {@link RetirementView.authoredPlanSurvives}.
 */

import type {
  ContinuedJob,
  Jurisdiction,
  Projection,
  EarlyRetireeHealthFlag,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";

export interface RetirementView {
  /**
   * The headline: the earliest age at which every job in the household could cease and the plan
   * still fund itself to life expectancy, in the PRIMARY's own years. `null` when no age does.
   *
   * Not unconditional on its own — reaching it may have assumed {@link continuedJobs}, which is
   * why the panel states the two in one sentence rather than asserting this and qualifying it
   * afterwards.
   */
  readonly headlineAge: number | null;
  /**
   * The headline age in months from "now", for the chart's retirement reference line.
   */
  readonly headlineMonth: number | null;
  /**
   * The age the plan AS AUTHORED stops earning — the last year any job pays this household,
   * read off the jobs rather than solved, and `null` for a household holding none.
   *
   * The counterpart to {@link headlineAge}, and not a second opinion about it: this is when the
   * money stops if nothing changes, where the headline is the earliest it COULD stop. The plan
   * used to state this as `retirementAge`; it is a read now, so it cannot drift from the jobs.
   */
  readonly plannedWorkStopAge: number | null;
  /**
   * Does the plan as authored — every job running exactly the years it was given — fund itself to
   * life expectancy?
   *
   * Rendered beside {@link plannedWorkStopAge} as the "current plan" half of the panel, and it is
   * the half {@link headlineAge} cannot supply: the solved age is reached under a continuation
   * hypothesis, so a household whose authored plan already works can still see a headline age
   * that assumed something, and one with no feasible headline age at all may have an authored
   * plan that survives perfectly well. Two questions, two answers, shown as two.
   */
  readonly authoredPlanSurvives: boolean;
  /**
   * Fires when the SOLVED age lands before the Medicare-eligibility age with an authored health
   * line below the pre-65 self-funded benchmark. Surfaced as a nudge — an estimate, not
   * advice. Quiet when no age is feasible: there is no retirement to open a gap.
   */
  readonly earlyRetireeHealth: EarlyRetireeHealthFlag;
  /**
   * The jobs {@link headlineAge} assumed would carry on past their authored end — empty when it
   * assumed none, and empty when there is no headline age.
   *
   * Shown beside the age rather than left in the engine's answer, because it is half of what the
   * age claims: "you could stop working at 71" means something different if it quietly took five
   * more years of consulting, and the household may never have opened the picker that chose it.
   */
  readonly continuedJobs: readonly ContinuedJob[];
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
  const { solution, fullRetirementMonth, earlyRetireeHealth } = projection.retirement(jurisdiction);
  return {
    headlineAge: solution.fullRetirementAge,
    headlineMonth: fullRetirementMonth,
    plannedWorkStopAge: solution.plannedWorkStopAge,
    authoredPlanSurvives: solution.authoredPlanSurvives,
    earlyRetireeHealth,
    continuedJobs: solution.continuedJobs,
  };
}
