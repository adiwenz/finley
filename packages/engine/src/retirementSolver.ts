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
 *
 * §5 (issue #66) splits "retire" into TWO distinct solver outputs off this same
 * substrate, differing only in which jobs keep paying past the pinned age:
 *
 *  - Partial retirement age ({@link earliestPartialRetirementAge}): vary the open-ended
 *    (`null`-end) jobs' ends; keep the authored fixed-term jobs + passive income + government benefit.
 *  - Full retirement age ({@link earliestFullRetirementAge}): cease ALL jobs; survive on
 *    passive income + government benefit + assets alone. Always ≥ the partial retirement age.
 *
 * {@link solveRetirement} returns both plus the derived latest-authored-work-stop age.
 *
 * The solver is pure and jurisdiction-agnostic: it is always handed a
 * {@link ProjectionContext} (the caller's frozen "now" plus the jurisdiction the
 * projection resolves against). There is no default jurisdiction — the app injects it.
 */

import { interpretLedger } from "./ledger/interpret";
import { buildHouseholdSimInput } from "./projection/buildHouseholdInput";
import { simulateHousehold } from "./projection/simulate";
import { withPlan } from "./scenario";
import { createProjectionBase } from "./projectionBase";
import type { ProjectionContext } from "./projectionBase";
import type { ProjectionSeries } from "./projection/simulate";
import type { RetirementEvaluation, RetirementSolution } from "./retirementTypes";
import type { Scenario } from "./scenario";
import type { Job } from "./job";
import type { Plan } from "./plan";

/**
 * Run the full §5 projection for a {@link Scenario} — its plan's standing numbers with
 * the scenario's timeline events (§6) replayed on top. Same pipeline (and same events)
 * the net-worth chart uses, so the panel and graph draw from one model and genuinely
 * agree (#37). The `ctx` supplies the frozen "now" (`startYear`) and the jurisdiction.
 */
export function projectScenario(scenario: Scenario, ctx: ProjectionContext): ProjectionSeries {
  const base = createProjectionBase(scenario.plan, ctx);
  const household = interpretLedger(scenario.ledger, base);
  const simInput = buildHouseholdSimInput(household, base);
  return simulateHousehold(simInput, ctx.jurisdiction);
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
 * Project the scenario with retirement pinned at `age` — its timeline events included —
 * and evaluate that one run (§7.1): does it survive, and (if not) how on-track is it?
 * Both the headline search (which reads only `feasible`) and target mode (the panel, at
 * the user's pinned age) go through here — one projection, one evaluation.
 *
 * It returns the evaluation WITHOUT `nearestFeasibleAge`. That field is the earliest
 * surviving age — the result of {@link earliestPartialRetirementAge}, which calls THIS
 * function for every candidate age. Computing it here would make this function invoke
 * the search that invokes it: infinite recursion. The panel composes it once, after
 * the search finishes.
 */
export function evaluateAtAge(
  scenario: Scenario,
  age: number,
  ctx: ProjectionContext,
): Omit<RetirementEvaluation, "nearestFeasibleAge"> {
  const series = projectScenario(withPlan(scenario, { ...scenario.plan, retirementAge: age }), ctx);
  const feasible = realNetWorthSurvives(series);
  return {
    retirementAge: age,
    feasible,
    onTrackFraction: feasible ? 1 : computeOnTrackFraction(scenario.plan, age, series),
  };
}

/**
 * The earliest integer age in `[currentAge, lifeExpectancy]` at which `survives(age)`
 * holds, or null if even life expectancy fails. Survival is monotonic in the age
 * (working/holding jobs longer never hurts), so a binary search finds the threshold in
 * ~log2(range) projections. Shared by both §5 solvers — they differ only in the
 * per-age projection `survives` runs, not the search.
 */
function earliestSurvivingAge(
  budget: Plan,
  survives: (age: number) => boolean,
): number | null {
  const lo = budget.currentAge;
  const hi = budget.lifeExpectancy;
  if (lo > hi) return null;
  // If even the latest age fails, nothing in range survives.
  if (!survives(hi)) return null;
  let a = lo;
  let b = hi;
  while (a < b) {
    const mid = Math.floor((a + b) / 2);
    if (survives(mid)) b = mid;
    else a = mid + 1;
  }
  return a;
}

/**
 * §5 **partial retirement** solver output — the earliest integer age every **open-ended**
 * (`null`-end) job can end while the authored **fixed-term** jobs + passive income + government benefit
 * keep running and the plan still lasts to life expectancy, or null if even working to
 * life expectancy fails. Pinning the age moves every open-ended job's end (via
 * `retirementTargetAge`); fixed-term jobs keep their authored spans. Survival is monotonic
 * in the age, so a binary search over [currentAge, lifeExpectancy] finds the threshold in
 * ~log2(range) projections. The on-track % (§7.1) pairs with this age.
 */
export function earliestPartialRetirementAge(scenario: Scenario, ctx: ProjectionContext): number | null {
  return earliestSurvivingAge(scenario.plan, (age) => evaluateAtAge(scenario, age, ctx).feasible);
}

/**
 * The plan's jobs with every job's end capped at `age` (§5 full retirement): each job
 * stops no later than the calendar year the owner turns `age`. A `null`-end (open-ended)
 * job is first resolved to its `retirementTargetAge` end (`retirementAge` here), then
 * capped — so a supplemental job that already ends before `age` keeps its earlier end,
 * and nothing is extended. The result has only explicit ends, so `retirementAge` no
 * longer moves any of them. Empty for a scalar (jobs-less) plan.
 */
function ceaseAllJobsAtAge(budget: Plan, age: number, ctx: ProjectionContext): Job[] {
  const birthYear = ctx.startYear - budget.currentAge;
  const capYear = birthYear + age;
  return (budget.jobs ?? []).map((job) => {
    const naturalEndExclusive = job.endYear ?? birthYear + budget.retirementAge;
    return { ...job, endYear: Math.min(naturalEndExclusive, capYear) };
  });
}

/**
 * Run the §5 projection with ALL jobs ceased at `age` (§5 full retirement): every job
 * stops by `age`, leaving passive income + government benefit + assets to carry the plan to life
 * expectancy. For a scalar plan (no jobs) this collapses to a partial-retirement
 * projection at `age` (there is no supplemental income to drop).
 */
export function projectFullRetirement(
  scenario: Scenario,
  age: number,
  ctx: ProjectionContext,
): ProjectionSeries {
  return projectScenario(
    withPlan(scenario, {
      ...scenario.plan,
      jobs: ceaseAllJobsAtAge(scenario.plan, age, ctx),
      retirementAge: age,
    }),
    ctx,
  );
}

/**
 * Evaluate the §5 full-retirement scenario at `age`: cease all jobs at `age` and report
 * whether the plan survives (and, if not, how on-track it is). The full-retirement
 * counterpart of {@link evaluateAtAge}; like it, it omits `nearestFeasibleAge` (the
 * search that computes that calls this, so composing it here would recurse).
 */
export function evaluateFullRetirementAtAge(
  scenario: Scenario,
  age: number,
  ctx: ProjectionContext,
): Omit<RetirementEvaluation, "nearestFeasibleAge"> {
  const series = projectFullRetirement(scenario, age, ctx);
  const feasible = realNetWorthSurvives(series);
  return {
    retirementAge: age,
    feasible,
    onTrackFraction: feasible ? 1 : computeOnTrackFraction(scenario.plan, age, series),
  };
}

/**
 * §5 **full retirement** solver output: the earliest age at which ALL jobs (career +
 * supplemental) can cease and the plan still survive to life expectancy on passive
 * income + government benefit + assets alone. Always ≥ {@link earliestPartialRetirementAge} — dropping
 * the supplemental income can only make survival harder. Null when no age survives.
 */
export function earliestFullRetirementAge(scenario: Scenario, ctx: ProjectionContext): number | null {
  return earliestSurvivingAge(scenario.plan, (age) => evaluateFullRetirementAtAge(scenario, age, ctx).feasible);
}

/**
 * The derived latest-authored-work-stop age (§5): `max(job endYears)` expressed as an
 * age — the latest any authored job is scheduled to stop. A `null`-end (open-ended) job
 * resolves to its `retirementTargetAge` end. Null when the plan has no jobs (a scalar
 * plan stops earned income at `retirementAge`, which the partial retirement age already
 * reports).
 */
export function latestAuthoredWorkStopAge(scenario: Scenario, ctx: ProjectionContext): number | null {
  const { plan } = scenario;
  const jobs = plan.jobs ?? [];
  if (jobs.length === 0) return null;
  const birthYear = ctx.startYear - plan.currentAge;
  const maxEndExclusive = Math.max(
    ...jobs.map((job) => job.endYear ?? birthYear + plan.retirementAge),
  );
  return maxEndExclusive - birthYear;
}

/**
 * Both §5 retirement solver outputs off one {@link Scenario} (#66): the partial
 * retirement age, the full retirement age, and the derived latest-authored-work-stop
 * age. Every field runs off the same real §5 projection substrate (#29) — the plan WITH
 * its timeline events — so the panel and the net-worth graph can never disagree.
 */
export function solveRetirement(scenario: Scenario, ctx: ProjectionContext): RetirementSolution {
  return {
    partialRetirementAge: earliestPartialRetirementAge(scenario, ctx),
    fullRetirementAge: earliestFullRetirementAge(scenario, ctx),
    latestAuthoredWorkStopAge: latestAuthoredWorkStopAge(scenario, ctx),
  };
}
