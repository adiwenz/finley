/**
 * The retirement solver, run off the REAL projection: it uses the same `simulateHousehold` the
 * net-worth graph does, so panel and graph can never disagree.
 *
 * **Two results, not one.** The plan as authored is run once and asked whether it survives
 * ({@link authoredPlanSurvives}); separately, candidate ages are binary-searched for the earliest
 * at which the household could stop ALL work and still fund itself to life expectancy
 * ({@link earliestFullRetirementAge}). They are kept apart because the search cannot answer the
 * first question — every candidate resolves the household under the continuation hypothesis, so
 * the authored staggering of jobs is not among the scenarios it tries. Beside them sits
 * {@link plannedWorkStopAge}, a plain READ of when the authored jobs stop paying. Nothing here is
 * pinned by the user.
 *
 * A candidate never edits the scenario. It travels as a {@link StopWorkingBoundary} — a
 * compilation input — which caps every job at the candidate year, and runs PAST an authored end
 * for exactly one job per person: the one they named as the job they would continue, from the
 * moment the candidate passes that job's own end. What that assumed is reported back beside the
 * answer ({@link continuedJobsAt}).
 *
 * Pure and jurisdiction-agnostic: always handed a {@link ProjectionContext} (frozen "now" plus
 * jurisdiction); there is no default.
 */

import { interpretLedger } from "../ledger/interpret";
import { buildHouseholdSimInput } from "../projection/buildHouseholdInput";
import { simulateHousehold } from "../projection/simulate";
import { createProjectionBase, PRIMARY_PERSON_ID } from "../compile/projectionBase";
import { jobDisplayNames } from "../compile/compilePerson";
import type { ProjectionContext } from "../compile/projectionBase";
import {
  addedHouseholdPaidMonths,
  householdJobContexts,
  householdPaidMonths,
  householdPaidYears,
  householdWageEndYearExclusive,
  intersectHouseholdPaidMonths,
  resolveHouseholdJobs,
  type StopWorkingBoundary,
} from "../job/householdJob";
import type { ProjectionSeries, HouseholdSimInput } from "../projection/simulate";
import type {
  ContinuedJob,
  HorizonAnchor,
  RetirementEvaluation,
  RetirementSolution,
} from "./retirementTypes";
import type { Scenario } from "../plan/scenario";
import type { Job } from "../job/job";
import type { Plan } from "../plan/plan";
import type { Household } from "../ledger/household";

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

/**
 * The three answers a projection can give about survival. `"blocked"` is NOT a survival verdict:
 * the projection stopped before life expectancy, so whether the remaining months would have
 * survived is unknowable — and must never be read as "survives".
 */
export type SurvivalOutcome = "survives" | "fails" | "blocked";

/**
 * Survival read off the projection, block-aware. A blocked series is `"blocked"` BEFORE the
 * per-month test, because `Array.every` over a truncated series is vacuously `true` — a blocked
 * plan would otherwise report as surviving, promising a retirement age beside a graph that stops.
 */
export function planOutcome(series: ProjectionSeries): SurvivalOutcome {
  if (series.status === "blocked") return "blocked";
  return series.months.every(monthSurvives) ? "survives" : "fails";
}

/**
 * Does the plan fund itself through life expectancy? The signal every mode reads. A truncated
 * (blocked) projection is never a success — {@link planOutcome} guards the vacuous `every`.
 */
export function planSurvives(series: ProjectionSeries): boolean {
  return planOutcome(series) === "survives";
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
 * One boundary means one thing: everybody stops. It is a calendar year rather than an age so the
 * same instant reaches every earner, whatever their own birthday — see
 * {@link StopWorkingBoundary} for the rule deciding whether it caps a person's jobs or carries
 * their continuation job out to it.
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
  // Horizon is derived from the plan (months to life expectancy), NOT `series.months.length - 1`:
  // once a projection can truncate, the series length collapses to the blocked month and would
  // make the retirement window meaningless. This matches `createProjectionBase`'s `horizonMonths`
  // for an untruncated run, so the fraction is unchanged wherever it already worked.
  const horizon = Math.max(0, (budget.lifeExpectancy - budget.currentAge) * 12) - 1;
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
 * Fold a projection at `age` into the evaluation fields both modes share. A blocked projection is
 * neither feasible nor on-track — its survival is unknowable — so it carries `blocked` and the
 * month it stopped rather than a fraction read off a truncated curve.
 */
function evaluateSeries(
  budget: Plan,
  age: number,
  series: ProjectionSeries,
): RetirementEvaluation {
  const outcome = planOutcome(series);
  const feasible = outcome === "survives";
  const blocked = outcome === "blocked";
  return {
    retirementAge: age,
    feasible,
    blocked,
    ...(blocked ? { blockedAtMonth: series.blockedAtMonth } : {}),
    onTrackFraction: feasible ? 1 : blocked ? 0 : computeOnTrackFraction(budget, age, series),
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
  return evaluateSeries(scenario.plan, age, series);
}

/**
 * The earliest age at which ALL jobs can cease and the plan still survive to life expectancy on
 * passive income + government benefit + assets alone.
 *
 * The only retirement search there is: every job states its own end, so there is no category of
 * job that stops separately from the rest, and "when could we stop working" has one answer.
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
 * stops counting at the separation rather than running on to an end this household will never
 * see. A job that never pays the household at all does not count.
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
  // `"authored"`, and no `stopWorking` on the base either: a solver candidate is a hypothesis
  // about a plan the user has not adopted, and must never move what their own plan says.
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
 * Which jobs a stop at `age` pays this household for **beyond what the authored plan pays** —
 * the disclosure behind an answer, and a pure read of the SAME resolution the run at that age
 * performed.
 *
 * The comparison is between the two resolutions of each job — authored and hypothetical — and it
 * is made on the **household-paid** span, never on the employment span alone. Employment is not
 * income: a partner who separates at 60 goes on being employed to 65 as far as their job is
 * concerned, and the household stops being paid at the separation either way. Extending that
 * employment to a candidate 70 therefore moves `endYearExclusive` and moves not one cent, and
 * the sentence "you could stop at 70 if their job continued through 70" would credit the answer
 * to work that never funded it. A continuation is disclosed only where it actually paid.
 *
 * Read off the resolution rather than re-derived from each person's selection, so a job appears
 * here exactly when the projection really did pay it for months the plan does not contain. A
 * selection that changed nothing at this age — because the boundary falls inside the selected
 * job's own span, so every job was merely capped — correctly reports nothing.
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
  // The same contexts under both scopes, paired by index — one job, asked two questions. The
  // authored pass is what the household is paid without the hypothesis; nothing else can say
  // what the hypothesis added.
  const contexts = householdJobContexts(household.memberships);
  const authored = resolveHouseholdJobs(contexts, ctx.startYear, { kind: "authored" });
  const resolved = resolveHouseholdJobs(contexts, ctx.startYear, {
    kind: "hypothetical",
    stopWorking,
  });

  return resolved.flatMap((r, i) => {
    // The months the hypothesis ADDED. Overlap is measured against this window and not the whole
    // span, because the months the job was authored for are not a consequence of continuing it —
    // and it is already clipped to the membership and to "now", so no rule of either kind is
    // restated here.
    const extension = addedHouseholdPaidMonths(authored[i]!, r);
    if (extension === null) return [];

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

    const overlaps = resolved.flatMap((o, j) => {
      if (j === i || o.owner.id !== r.owner.id) return [];
      // Not named `window` — the purity guard reads that as the browser global, and it is right to.
      const both = intersectHouseholdPaidMonths(extension, householdPaidMonths(o));
      if (both === null) return [];
      const years = householdPaidYears(both, ctx.startYear);
      return [
        {
          ...named(o.job),
          fromAge: years.fromYear - ownerBirthYear,
          toAge: years.toYearExclusive - ownerBirthYear,
          fromYear: years.fromYear,
          toYear: years.toYearExclusive,
        },
      ];
    });

    // The terminus is where the money stops, not where the employment does — the same reading
    // the emission test above is made on, so the two can never tell different stories.
    const throughYear = householdPaidYears(extension, ctx.startYear).toYearExclusive;
    return [
      {
        ...named(r.job),
        ownerId: r.owner.id,
        ownerName: r.owner.name,
        throughAge: throughYear - ownerBirthYear,
        throughYear,
        overlaps,
      },
    ];
  });
}

/**
 * Does the plan **as authored** survive to life expectancy? One run with no
 * {@link StopWorkingBoundary} at all, so every job pays exactly the years it was given.
 *
 * Its own run rather than a candidate of the search, because the search cannot produce this
 * scenario: a candidate resolves the household under the continuation hypothesis, so a boundary
 * at the plan's own final year still models the selected job as having run to it. The authored
 * staggering — this job to 65, that one 65 to 70 — exists nowhere in the candidate space. See
 * {@link RetirementSolution.authoredPlanSurvives}.
 */
export function authoredPlanSurvives(scenario: Scenario, ctx: ProjectionContext): boolean {
  return planSurvives(projectScenario(scenario, ctx));
}

/**
 * Whose expectancy the horizon rests on — the member present to the end (never separated) who
 * reaches their expectancy in the latest calendar year, and the age they reach. This mirrors the
 * horizon the sim runs (`buildHouseholdInput` takes the max member reach): a younger partner who
 * stays outlives the primary and sets it; a partner who separates leaves before their own
 * expectancy and never does. A member's expectancy is their own, or the household's when they
 * state none — the same resolution the sim uses. Ties fall to the primary, so an all-same-age
 * household names the reader.
 *
 * No simulation: the household is interpreted and read, the way `plannedWorkStopAge` is.
 */
export function horizonAnchorOf(scenario: Scenario, ctx: ProjectionContext): HorizonAnchor {
  const base = createProjectionBase(scenario.plan, ctx);
  const household = interpretLedger(scenario.ledger, base);
  const householdAge = scenario.plan.lifeExpectancy;
  let best: { age: number; deathYear: number; isPrimary: boolean; name: string } | null = null;
  for (const m of household.memberships) {
    // A separated member leaves before their expectancy, so they never set the horizon.
    if (m.endMonth !== null) continue;
    const isPrimary = m.person.id === PRIMARY_PERSON_ID;
    const age = m.person.lifeExpectancy ?? householdAge;
    const deathYear = m.person.birthYear + age;
    const wins =
      best === null || deathYear > best.deathYear || (deathYear === best.deathYear && isPrimary);
    if (wins) best = { age, deathYear, isPrimary, name: m.person.name };
  }
  // The primary is always a member, so `best` is set; the fallback only keeps the type total.
  if (best === null) return { age: householdAge, memberName: null };
  return { age: best.age, memberName: best.isPrimary ? null : best.name };
}

/**
 * The default retirement result off one {@link Scenario}: the retirement search
 * ({@link RetirementSolution.fullRetirementAge} — solved, "can we afford to stop"), the planned
 * work-stop age ({@link plannedWorkStopAge} — read, "when does the authored plan stop on its
 * own"), whether the authored plan survives at all ({@link authoredPlanSurvives} — a run of the
 * plan itself), and what the search had to assume to get there.
 */
export function solveRetirement(scenario: Scenario, ctx: ProjectionContext): RetirementSolution {
  const fullRetirementAge = earliestFullRetirementAge(scenario, ctx);
  // Blocked and "no age works" both surface as a null age, so tell them apart. Only worth a probe
  // when the search found nothing: a plan that survives at some age is, by definition, not blocked.
  // Life expectancy is the best-funded case — jobs run longest — so if even it blocks, no earlier
  // age un-blocks the stranded obligation.
  const blockProbe =
    fullRetirementAge === null
      ? projectFullRetirement(scenario, scenario.plan.lifeExpectancy, ctx)
      : undefined;
  const blocked = blockProbe?.status === "blocked";
  return {
    fullRetirementAge,
    plannedWorkStopAge: plannedWorkStopAge(scenario, ctx),
    blocked,
    ...(blocked ? { blockedAtMonth: blockProbe?.blockedAtMonth } : {}),
    authoredPlanSurvives: authoredPlanSurvives(scenario, ctx),
    // Read at the age that was actually reported. With no feasible age there is no scenario to
    // describe, so there is nothing to disclose either.
    continuedJobs:
      fullRetirementAge === null ? [] : continuedJobsAt(scenario, fullRetirementAge, ctx),
    horizonAnchor: horizonAnchorOf(scenario, ctx),
  };
}
