/**
 * The retirement solver, run off the REAL projection: every mode uses the same
 * `simulateHousehold` the net-worth graph does, so panel and graph can never disagree. Each
 * mode reads one survival signal off the real net-worth curve with a retirement age pinned —
 * headline mode binary-searches the earliest surviving age; target mode pins the user's age
 * and reports feasibility, on-track %, and the nearest feasible age. The two outputs differ
 * only in which jobs keep paying past the pinned age.
 *
 * Pure and jurisdiction-agnostic: always handed a {@link ProjectionContext} (frozen "now" plus
 * jurisdiction); there is no default.
 */

import { interpretLedger } from "./ledger/interpret";
import { buildHouseholdSimInput } from "./projection/buildHouseholdInput";
import { simulateHousehold } from "./projection/simulate";
import { createProjectionBase } from "./projectionBase";
import type { ProjectionContext } from "./projectionBase";
import {
  householdJobContexts,
  householdWageEndYearExclusive,
  resolveHouseholdJobs,
  type StopWorkingBoundary,
} from "./householdJob";
import type { ProjectionSeries, HouseholdSimInput } from "./projection/simulate";
import type { RetirementEvaluation, RetirementSolution } from "./retirementTypes";
import type { Scenario } from "./scenario";
import type { Plan } from "./plan";
import type { Household } from "./ledger/household";

/**
 * Every intermediate one pipeline pass produces, kept rather than discarded. The `run()`
 * facade needs the {@link Household} (snapshot roster) and the {@link HouseholdSimInput} (to
 * summarize the report) beside the series, and it must get all three from ONE simulate pass —
 * the app deliberately shares a single input between graph and debug report.
 *
 * Engine-internal: exported for `Projection.run`, a sibling module, but deliberately absent
 * from the package barrel. {@link HouseholdSimInput} is a simulator artifact, and the facade's
 * whole point is that a caller outside the engine never has to hold one — `run()` consumes the
 * sim input here and hands out the finished `SimulationReport` instead. Publishing this
 * type would make that artifact part of the public contract and block ever withdrawing it.
 */
export interface ScenarioProjection {
  readonly household: Household;
  readonly simInput: HouseholdSimInput;
  readonly series: ProjectionSeries;
}

/**
 * Run the full projection for a {@link Scenario} — its plan's standing numbers with the
 * scenario's timeline events replayed on top — keeping each stage's output. The interpreted
 * household and the sim input are computed here on the way to the series regardless, so
 * returning them rather than dropping them costs nothing and spares the caller a second run.
 */
export function projectScenarioParts(
  scenario: Scenario,
  ctx: ProjectionContext,
  stopWorking?: StopWorkingBoundary,
): ScenarioProjection {
  const base = createProjectionBase(scenario.plan, ctx, stopWorking);
  const household = interpretLedger(scenario.ledger, base);
  const simInput = buildHouseholdSimInput(household, base);
  const series = simulateHousehold(simInput, ctx.jurisdiction);
  return { household, simInput, series };
}

/**
 * Run the full projection for a {@link Scenario} — its plan's standing numbers with the
 * scenario's timeline events replayed on top. `stopWorking` caps every earner's jobs at a
 * candidate boundary while the retirement solver searches; it edits nothing on the scenario, so
 * the search leaves the plan and its jobs byte-for-byte untouched.
 */
export function projectScenario(
  scenario: Scenario,
  ctx: ProjectionContext,
  stopWorking?: StopWorkingBoundary,
): ProjectionSeries {
  return projectScenarioParts(scenario, ctx, stopWorking).series;
}

/**
 * Authoritative per-month failure signal: **insolvency** — savings AND credit both exhausted —
 * not the sign of net worth. Judging on `netWorthRealCents >= 0` failed a new graduate with a
 * student loan at month 0.
 *
 * The null guard is load-bearing: net worth is null for every month after the first insolvent
 * one, and `null >= 0` is true in JS.
 */
function monthSurvives(m: ProjectionSeries["months"][number]): boolean {
  return m.netWorthRealCents !== null && !m.isInsolvent;
}

/** Does the plan fund itself through life expectancy? The signal every mode reads. */
export function planSurvives(series: ProjectionSeries): boolean {
  return series.months.every(monthSurvives);
}

function retirementMonth(budget: Plan, age: number): number {
  return Math.max(0, (age - budget.currentAge) * 12);
}

/**
 * The candidate boundary for a solve at `age`: the calendar year the primary turns `age`, applied
 * to every earner. `mode` decides whether the fixed-term jobs cap with the rest (`"full"`) or only
 * the open-ended ones move (`"partial"`). Purely a compilation input — it rewrites no job, which is
 * what makes a solve non-destructive.
 */
function stopWorkingBoundaryAt(
  budget: Plan,
  age: number,
  ctx: ProjectionContext,
  mode: StopWorkingBoundary["mode"],
): StopWorkingBoundary {
  const birthYear = ctx.startYear - budget.currentAge;
  return { boundaryYearExclusive: birthYear + age, mode };
}

/**
 * On-track fraction for a plan that does NOT survive: the fraction of the
 * retirement-to-life-expectancy window it stays solvent. Read from WHEN it first fails, not
 * from how far net worth dipped — insolvency nulls the curve rather than driving it negative,
 * so the deepest value seen could be positive → a meaningless 1.0. The denominator counts the
 * window inclusively, so an infeasible plan is never 100%.
 */
function computeOnTrackFraction(
  budget: Plan,
  age: number,
  series: ProjectionSeries,
): number {
  const horizon = series.months.length - 1;
  const boundary = Math.min(retirementMonth(budget, age), horizon);
  // Inclusive, so ≥ 1 after the clamp: a safe denominator.
  const retirementWindow = horizon - boundary + 1;
  // -1 is defensive; callers gate on `!feasible`.
  const firstFailureMonth = series.months.findIndex((m) => !monthSurvives(m));
  if (firstFailureMonth < 0) return 1;
  const solventInRetirement = Math.max(0, firstFailureMonth - boundary);
  return Math.min(1, solventInRetirement / retirementWindow);
}

/**
 * Project with retirement pinned at `age` and evaluate that run. Omits `nearestFeasibleAge`:
 * {@link earliestPartialRetirementAge} calls this for every candidate age to produce it, so
 * computing it here would recurse.
 */
export function evaluateAtAge(
  scenario: Scenario,
  age: number,
  ctx: ProjectionContext,
): Omit<RetirementEvaluation, "nearestFeasibleAge"> {
  const series = projectScenario(scenario, ctx, stopWorkingBoundaryAt(scenario.plan, age, ctx, "partial"));
  const feasible = planSurvives(series);
  return {
    retirementAge: age,
    feasible,
    onTrackFraction: feasible ? 1 : computeOnTrackFraction(scenario.plan, age, series),
  };
}

/**
 * Earliest integer age in `[currentAge, lifeExpectancy]` at which `survives(age)` holds, else
 * null. Survival is monotonic in the age (holding jobs longer never hurts), so a binary search
 * finds the threshold in ~log2(range) projections.
 */
function earliestSurvivingAge(
  budget: Plan,
  survives: (age: number) => boolean,
): number | null {
  const lo = budget.currentAge;
  const hi = budget.lifeExpectancy;
  if (lo > hi) return null;
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
 * **Partial retirement**: the earliest age every **open-ended** (`null`-end) job can end while
 * the authored fixed-term jobs + passive income + government benefit keep running and the plan
 * still lasts to life expectancy. Pinning the age moves every open-ended job's end via a
 * partial-mode {@link StopWorkingBoundary} the compiler applies to every earner.
 *
 * Opt-in and standalone: it is NOT part of {@link solveRetirement}'s default result. A caller
 * that wants the partial-retirement milestone (e.g. a "stepped back" option in the panel) runs
 * this search itself, so the default query never pays for a second binary search the panel does
 * not show.
 */
export function earliestPartialRetirementAge(scenario: Scenario, ctx: ProjectionContext): number | null {
  return earliestSurvivingAge(scenario.plan, (age) => evaluateAtAge(scenario, age, ctx).feasible);
}

/**
 * Run the projection with ALL jobs ceased at `age`, leaving passive income + government
 * benefit + assets to carry the plan to life expectancy. The full-mode boundary caps every
 * earner's jobs — the primary's AND a partner's — at the calendar year the primary turns `age`,
 * without rewriting a single one. For a scalar plan (no jobs) it collapses to a partial-retirement
 * projection at `age` — nothing left to drop.
 */
export function projectFullRetirement(
  scenario: Scenario,
  age: number,
  ctx: ProjectionContext,
): ProjectionSeries {
  return projectScenario(scenario, ctx, stopWorkingBoundaryAt(scenario.plan, age, ctx, "full"));
}

/**
 * Full-retirement counterpart of {@link evaluateAtAge}: cease all jobs at `age`. Omits
 * `nearestFeasibleAge` for the same reason.
 */
export function evaluateFullRetirementAtAge(
  scenario: Scenario,
  age: number,
  ctx: ProjectionContext,
): Omit<RetirementEvaluation, "nearestFeasibleAge"> {
  const series = projectFullRetirement(scenario, age, ctx);
  const feasible = planSurvives(series);
  return {
    retirementAge: age,
    feasible,
    onTrackFraction: feasible ? 1 : computeOnTrackFraction(scenario.plan, age, series),
  };
}

/**
 * **Full retirement**: the earliest age at which ALL jobs (open-ended + fixed-term) can cease
 * and the plan still survive to life expectancy on passive income + government benefit +
 * assets alone. Always ≥ {@link earliestPartialRetirementAge} — dropping the still-running
 * income can only make survival harder.
 */
export function earliestFullRetirementAge(scenario: Scenario, ctx: ProjectionContext): number | null {
  return earliestSurvivingAge(scenario.plan, (age) => evaluateFullRetirementAtAge(scenario, age, ctx).feasible);
}

/**
 * The exclusive calendar year the household's authored plan collects its final WAGE — a plain
 * READ of what's already authored, not a search: `max` over every resolved household job of the
 * year that job stops paying THIS HOUSEHOLD.
 *
 * "Paying this household" is {@link resolveHouseholdJobs}'s answer, not a rule restated here,
 * which is what makes this agree with the projection by construction. In particular a job is
 * bounded by its owner's membership as well as by its own end, so a separated partner's job
 * stops counting at the separation rather than running on to a retirement target they will
 * reach outside this household. A job that never pays the household at all does not count.
 *
 * `null` when no job in the household ever pays it (a scalar plan stops earned income at
 * `retirementAge`, already reported by the partial retirement age).
 *
 * Distinct from {@link fullRetirementAge}, which is a SOLVED value: the earliest age the
 * household can stop working and still remain solvent. This is the opposite direction — it
 * never asks whether the plan survives, only when the plan as authored today runs out of
 * income of its own accord.
 */
function plannedWorkStopYear(scenario: Scenario, ctx: ProjectionContext): number | null {
  const base = createProjectionBase(scenario.plan, ctx);
  const household = interpretLedger(scenario.ledger, base);
  // No `stopWorking`: this reads the plan AS AUTHORED. A solver candidate is a hypothesis about
  // a plan the user has not adopted, and must never move what their own plan says.
  const resolved = resolveHouseholdJobs(householdJobContexts(household.memberships), ctx.startYear);
  const paying = resolved.filter((r) => r.paysHousehold);
  if (paying.length === 0) return null;
  return Math.max(...paying.map((r) => householdWageEndYearExclusive(r, ctx.startYear)));
}

/**
 * {@link plannedWorkStopYear} as an age — the convention every other solver output uses, so a
 * partner's later calendar-year stop is converted through the PRIMARY's birth year, never
 * reported as if it were the partner's own age. `null` when the household has no jobs.
 */
export function plannedWorkStopAge(scenario: Scenario, ctx: ProjectionContext): number | null {
  const year = plannedWorkStopYear(scenario, ctx);
  if (year === null) return null;
  const primaryBirthYear = ctx.startYear - scenario.plan.currentAge;
  return year - primaryBirthYear;
}

/**
 * The default retirement result off one {@link Scenario}: the full-retirement search
 * ({@link fullRetirementAge} — solved, "can we afford to stop") plus the planned work-stop age
 * ({@link plannedWorkStopAge} — read, "when does the authored plan stop on its own"). Partial
 * retirement is a separate, opt-in solve ({@link earliestPartialRetirementAge}) and is
 * deliberately not run here, so the default query performs a single binary search rather than
 * two.
 */
export function solveRetirement(scenario: Scenario, ctx: ProjectionContext): RetirementSolution {
  return {
    fullRetirementAge: earliestFullRetirementAge(scenario, ctx),
    plannedWorkStopAge: plannedWorkStopAge(scenario, ctx),
  };
}
