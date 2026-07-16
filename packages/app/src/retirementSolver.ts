/**
 * The retirement solver (§7), run off the REAL projection (§5): every mode uses the
 * same `simulateHousehold` the net-worth graph does, so the panel and graph can never
 * disagree (#37). Each mode reads one survival signal off the real (today's-dollars,
 * §0.5) net-worth curve, with a different retirement age pinned:
 *
 *  - Headline ("when can we retire?"): binary-search the earliest surviving age.
 *    Survival is monotonic in the age — retiring later never hurts.
 *  - Target mode: pin the user's age; report feasibility, on-track %, and the honest
 *    nearest-feasible age when the pin is out of reach (§7.1).
 */

import {
  interpretLedger,
  buildHouseholdSimInput,
  simulateHousehold,
  emptyLedger,
  type Jurisdiction,
  type ProjectionSeries,
  type RetirementEvaluation,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { createProjectionBase } from "./projectionBase";
import type { Plan } from "@finley/engine";

/**
 * Run the full §5 projection for `budget` (no life events — the panel reasons about
 * the authored plan). Same pipeline `main.tsx` feeds the chart, so panel and graph
 * draw from one model.
 */
export function projectPlan(
  budget: Plan,
  jurisdiction: Jurisdiction = usJurisdiction,
): ProjectionSeries {
  const base = createProjectionBase(budget);
  const household = interpretLedger(emptyLedger, base);
  const simInput = buildHouseholdSimInput(household, base);
  return simulateHousehold(simInput, jurisdiction);
}

/**
 * Does the plan's real net worth stay ≥ 0 through life expectancy with no insolvent
 * month (§0.5, §5.1)? The single signal every mode reads — and what the graph plots.
 */
export function realNetWorthSurvives(series: ProjectionSeries): boolean {
  // Net worth is null once insolvent (§5.1) and `null >= 0` is true in JS, so guard
  // null explicitly — else post-insolvency months would wrongly count as surviving.
  return series.months.every(
    (m) => m.netWorthRealCents !== null && m.netWorthRealCents >= 0 && !m.isInsolvent,
  );
}

/** Absolute simulation month a retirement `age` falls at, floored at 0. */
function retirementMonth(budget: Plan, age: number): number {
  return Math.max(0, (age - budget.currentAge) * 12);
}

/**
 * On-track fraction (§7.1) for a plan that does NOT survive: the real nest egg it has
 * at the retirement boundary ÷ the nest egg it needed there to avoid running dry
 * (boundary balance + the deepest real shortfall it later hits). 0 with nothing at the
 * boundary; a surviving plan is 1.0 and never reaches here. Reporting caps it at 100%.
 */
function computeOnTrackFraction(
  budget: Plan,
  age: number,
  series: ProjectionSeries,
): number {
  const boundary = Math.min(retirementMonth(budget, age), series.months.length - 1);
  // Net worth is null once insolvent (§5.1); a null boundary or low reads as 0.
  const availableCents = series.months[boundary]?.netWorthRealCents ?? 0;
  const realNetWorths = series.months
    .map((m) => m.netWorthRealCents)
    .filter((c): c is number => c !== null);
  const lowestRealCents = realNetWorths.length > 0 ? Math.min(...realNetWorths) : 0;
  const shortfallCents = Math.max(0, -lowestRealCents);
  const requiredCents = availableCents + shortfallCents;
  return availableCents <= 0 || requiredCents <= 0 ? 0 : availableCents / requiredCents;
}

/**
 * Project the plan with retirement pinned at `age` and evaluate that one run (§7.1):
 * does it survive, and (if not) how on-track is it? Both the headline search (which
 * reads only `feasible`) and target mode (the panel, at the user's pinned age) go
 * through here — one projection, one evaluation.
 *
 * It returns the evaluation WITHOUT `nearestFeasibleAge`. That field is the earliest
 * surviving age — the result of `earliestFeasibleRetirementAge`, which calls THIS
 * function for every candidate age. Computing it here would make this function invoke
 * the search that invokes it: infinite recursion. The panel composes it once, after
 * the search finishes.
 */
export function evaluateAtAge(
  budget: Plan,
  age: number,
  jurisdiction: Jurisdiction = usJurisdiction,
): Omit<RetirementEvaluation, "nearestFeasibleAge"> {
  const series = projectPlan({ ...budget, retirementAge: age }, jurisdiction);
  const feasible = realNetWorthSurvives(series);
  return {
    retirementAge: age,
    feasible,
    onTrackFraction: feasible ? 1 : computeOnTrackFraction(budget, age, series),
  };
}

/**
 * The earliest integer age the plan can retire and still last to life expectancy, or
 * null if even working to life expectancy fails. Survival is monotonic in the age, so a
 * binary search over [currentAge, lifeExpectancy] finds the threshold in ~log2(range)
 * projections.
 */
export function earliestFeasibleRetirementAge(
  budget: Plan,
  jurisdiction: Jurisdiction = usJurisdiction,
): number | null {
  const lo = budget.currentAge;
  const hi = budget.lifeExpectancy;
  if (lo > hi) return null;
  // If even retiring at life expectancy fails, nothing in range survives.
  if (!evaluateAtAge(budget, hi, jurisdiction).feasible) return null;
  let a = lo;
  let b = hi;
  while (a < b) {
    const mid = Math.floor((a + b) / 2);
    if (evaluateAtAge(budget, mid, jurisdiction).feasible) b = mid;
    else a = mid + 1;
  }
  return a;
}

