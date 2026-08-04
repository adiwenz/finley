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
import { jobDisplayNames } from "./compilePerson";
import type { ProjectionContext } from "./projectionBase";
import {
  authoredJobEndYearExclusive,
  householdJobContexts,
  householdWageEndYearExclusive,
  resolveHouseholdJobs,
  type StopWorkingBoundary,
} from "./householdJob";
import type { ProjectionSeries, HouseholdSimInput } from "./projection/simulate";
import type { ContinuedJob, RetirementEvaluation, RetirementSolution } from "./retirementTypes";
import type { Scenario } from "./scenario";
import type { Job } from "./job";
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

/** The calendar year the primary turns `age` — the boundary a stop at `age` applies to every earner. */
function stopWorkingBoundaryYear(budget: Plan, age: number, startYear: number): number {
  return startYear - budget.currentAge + age;
}

/**
 * The candidate boundary for a solve at `age`: the calendar year the primary turns `age`, applied
 * to every earner. Purely a compilation input — it rewrites no job, which is what makes a solve
 * non-destructive.
 *
 * Also the boundary a caller outside the solver's own search uses:
 * {@link Projection.runAtStopWorkingAge} previews a candidate age's charts through it.
 *
 * There used to be two of these, a "partial" one that ended only the open-ended jobs and a
 * "full" one that ended everything. Every job now carries its own end, so there is no
 * open-ended category to stop separately, and one boundary means one thing: everybody stops.
 */
export function stopWorkingBoundaryAt(
  budget: Plan,
  age: number,
  startYear: number,
): StopWorkingBoundary {
  return { boundaryYearExclusive: stopWorkingBoundaryYear(budget, age, startYear) };
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
 * Run the projection with ALL jobs ceased at `age`, leaving passive income + government
 * benefit + assets to carry the plan to life expectancy. The boundary caps every earner's jobs
 * — the primary's AND a partner's — at the calendar year the primary turns `age`, without
 * rewriting a single one.
 */
export function projectFullRetirement(
  scenario: Scenario,
  age: number,
  ctx: ProjectionContext,
): ProjectionSeries {
  return projectScenario(scenario, ctx, stopWorkingBoundaryAt(scenario.plan, age, ctx.startYear));
}

/** Evaluate a run with all jobs ceased at `age`. */
export function evaluateFullRetirementAtAge(
  scenario: Scenario,
  age: number,
  ctx: ProjectionContext,
): RetirementEvaluation {
  const series = projectFullRetirement(scenario, age, ctx);
  const feasible = planSurvives(series);
  return {
    retirementAge: age,
    feasible,
    onTrackFraction: feasible ? 1 : computeOnTrackFraction(scenario.plan, age, series),
  };
}

/**
 * The earliest age at which ALL jobs can cease and the plan still survive to life expectancy on
 * passive income + government benefit + assets alone.
 *
 * The only retirement search there is. A second one used to sit beside it — "partial"
 * retirement, ending the open-ended jobs while fixed-term ones kept paying — which depended on
 * a job with no end date being a recognisably different KIND of job. Every job states its own
 * end now, so there is nothing to tell apart, and "when can we stop working" has one answer.
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
 * `null` when no job in the household ever pays it — a household with no jobs has no planned
 * stop, which is a different answer from stopping today.
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
  // `"authored"` — see above. A solver candidate is a hypothesis about a plan the user has not
  // adopted, and must never move what their own plan says.
  const resolved = resolveHouseholdJobs(householdJobContexts(household.memberships), ctx.startYear, {
    kind: "authored",
  });
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
 * Which jobs a stop at `age` runs past their authored end — the disclosure behind an answer, and
 * a pure read of the SAME resolution the run at that age performed.
 *
 * Compared against {@link authoredJobEndYearExclusive} rather than re-derived from each person's
 * selection, so a job appears here exactly when the projection really did pay it for years the
 * plan does not contain. A selection that changed nothing at this age — because the boundary
 * falls inside the authored plan, so every job was merely capped — correctly reports nothing.
 *
 * No simulation: the household is interpreted and its jobs resolved, which is what a run does
 * before any month is computed. Cheap enough to run once for the solved age.
 */
export function continuedJobsAt(
  scenario: Scenario,
  age: number,
  ctx: ProjectionContext,
): readonly ContinuedJob[] {
  const stopWorking = stopWorkingBoundaryAt(scenario.plan, age, ctx.startYear);
  const base = createProjectionBase(scenario.plan, ctx, stopWorking);
  const household = interpretLedger(scenario.ledger, base);
  const resolved = resolveHouseholdJobs(householdJobContexts(household.memberships), ctx.startYear, {
    kind: "hypothetical",
    stopWorking,
  });
  return resolved
    .filter((r) => r.endYearExclusive > authoredJobEndYearExclusive(r.job))
    .map((r) => {
      // Every age on THIS value is its owner's own, unlike `fullRetirementAge` and
      // `plannedWorkStopAge`, which are the primary's by convention. A continued job belongs to
      // one person and the sentence names them, so "Sam's Nursing job continued through when
      // Sam is 71" is the only reading that can be right — reporting the primary's 66 there
      // attached a number from Alex's life to a fact about Sam's. The calendar years travel
      // alongside so a reader can reconcile the two clocks without knowing either birth year.
      const ownerBirthYear = r.owner.birthYear;
      // The SAME naming the income legend uses, not a second rule: an untitled job is named
      // after its owner rather than by its minted id, which means nothing to whoever reads it.
      const names = jobDisplayNames(r.owner);
      const named = (job: Job) => ({
        jobId: job.id,
        jobLabel: names.get(job.id) ?? job.id,
        jobName: job.name?.trim() || null,
      });
      // The years the extension ADDED — everything past this job's own authored end. Overlap is
      // measured against that window and not the whole span, because the years the job was
      // authored for are not a consequence of continuing it.
      const extensionFrom = authoredJobEndYearExclusive(r.job);
      const overlaps = resolved
        .filter((o) => o.owner.id === r.owner.id && o.job.id !== r.job.id)
        .map((o) => ({
          other: o,
          // Clipped to "now" as well: a job continued from an end date already behind us
          // overlaps on paper from that date, but the projection pays no month before 0, so
          // reporting the earlier year would name years of doubled income that never happen.
          from: Math.max(extensionFrom, o.job.startYear, ctx.startYear),
          to: Math.min(r.endYearExclusive, o.endYearExclusive),
        }))
        .filter((w) => w.to > w.from)
        .map((w) => ({
          ...named(w.other.job),
          fromAge: w.from - ownerBirthYear,
          toAge: w.to - ownerBirthYear,
          fromYear: w.from,
          toYear: w.to,
        }));

      return {
        ...named(r.job),
        ownerId: r.owner.id,
        ownerName: r.owner.name,
        throughAge: r.endYearExclusive - ownerBirthYear,
        throughYear: r.endYearExclusive,
        overlaps,
      };
    });
}

/**
 * The default retirement result off one {@link Scenario}: the retirement search
 * ({@link RetirementSolution.fullRetirementAge} — solved, "can we afford to stop"), the planned
 * work-stop age ({@link plannedWorkStopAge} — read, "when does the authored plan stop on its
 * own"), and what the search had to assume to get there.
 */
export function solveRetirement(scenario: Scenario, ctx: ProjectionContext): RetirementSolution {
  const fullRetirementAge = earliestFullRetirementAge(scenario, ctx);
  return {
    fullRetirementAge,
    plannedWorkStopAge: plannedWorkStopAge(scenario, ctx),
    // Read at the age that was actually reported. With no feasible age there is no scenario to
    // describe, so there is nothing to disclose either.
    continuedJobs:
      fullRetirementAge === null ? [] : continuedJobsAt(scenario, fullRetirementAge, ctx),
  };
}
