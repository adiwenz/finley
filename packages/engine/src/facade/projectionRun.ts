/**
 * One pipeline pass over authored state, and the artifact it answers with.
 *
 * A run reads a {@link ProjectionState} and derives nothing back, so it is a plain function of
 * (state, jurisdiction) rather than a method with a `this` to consult. `Projection.run` is a
 * one-line door onto it, and the separation is what lets a caller holding state alone — a test, a
 * worker, a cached snapshot — project without constructing a handle first.
 *
 * The jurisdiction is the *run* one, passed per call: one plan re-projects under any rule set,
 * which is the whole point of asking it here rather than reading the handle's validation
 * jurisdiction. `ProjectionResult` records the `jurisdictionId` it was answered under so a stale
 * artifact cannot be mistaken for a fresh one.
 */

import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import type { ProjectionState } from "../authoring/state";
import type { ProjectionSeries } from "../projection/simulate";
import {
  householdJobContexts,
  resolveJobPayDisplay,
  type ResolvedJobPayDisplay,
  type StopWorkingBoundary,
} from "../job/householdJob";
import { projectScenarioParts } from "../retirement/retirementSolver";
import { summarizeSimulation } from "../projection/report";
import type { SimulationReport } from "../projection/report";
import { buildSnapshot, membersAt } from "../projection/snapshot";
import type { HouseholdSnapshot } from "../projection/snapshot";
import type { Household } from "../ledger/household";
import type { Person } from "../plan/person";
import { buildPlanAccounts, buildPlanGoals, firstInsolventMonth } from "../compile/projectionBase";
import { computeGoalProgress } from "../goal/goal";
import type { GoalProgress, SimGoal } from "../goal/goal";
import { assessHomePurchase } from "../authoring/housing";
import type { HomePurchaseAssessment, HomePurchaseInput } from "../authoring/housing";
import { assessOneTimeSpendNudge } from "../authoring/spend";
import type { OneTimeSpendNudge } from "../authoring/spend";

/**
 * One pipeline pass under a specific jurisdiction, frozen. Carries every artifact the pass
 * produces so a caller answers the graph, the snapshot roster, and the debug report from a
 * SINGLE simulation — the {@link household} the snapshot reads and the {@link report} the
 * debug panel shows are derived from the very {@link series} the chart draws, never a re-run.
 */
export interface ProjectionResult {
  readonly jurisdictionId: string;
  readonly series: ProjectionSeries;
  /** First month the shortfall cascade exhausted all credit, or `null` if solvent throughout. */
  readonly firstInsolventMonth: number | null;
  /** The interpreted roster the snapshot panel and owner picker read. */
  readonly household: Household;
  /** The debug panel / download view of this run — summarized off {@link series}, not a second pass. */
  readonly report: SimulationReport;

  // Reads over this pass. Methods rather than more fields, because each is a question a
  // caller asks about ONE month or ONE goal — computing all of them eagerly would price
  // every run at the cost of every panel. They close over the artifacts above, so no
  // caller has to hold `household` and `series` side by side to ask.

  /** Household cross-section at `month` — who is present, what is owned, what is owed. */
  readonly snapshot: (month: number) => HouseholdSnapshot;
  /** Who is in the household at `month`; a partner joins and leaves on their own dates. */
  readonly membersAt: (month: number) => Person[];
  /**
   * Every plan goal beside how it is tracking against THIS run, in funding-priority order.
   * Paired, because a row needs both and the two lists are index-aligned only by construction.
   */
  readonly goalProgress: () => readonly { readonly goal: SimGoal; readonly progress: GoalProgress }[];
  /** The soft debt-to-income read on a purchase that has not been authored yet. */
  readonly assessHomePurchase: (input: HomePurchaseInput) => HomePurchaseAssessment;
  /**
   * The post-add whole-month feasibility nudge for an already-authored One-Time Spend event —
   * `null` while nothing about THIS run says the spend wrecks the plan. Advisory only; it never
   * blocks and reads no state beyond this run's own `firstInsolventMonth`.
   */
  readonly oneTimeSpendNudge: (eventId: string, eventMonth: number) => OneTimeSpendNudge | null;
  /**
   * One job's employment, the part of it this household is paid for, and the stretches it is
   * not — everything a surface needs to draw that job, resolved under THIS run's scope. `null`
   * for an id the household does not hold.
   *
   * Off the run, so a preview and an authored pass answer the same question the same way and a
   * chart never has to know which one it is looking at: `runAtStopWorkingAge` resolves these
   * against its own boundary, exactly as it resolves the series.
   */
  readonly jobPayDisplay: (jobId: string) => ResolvedJobPayDisplay | null;
}

/**
 * Project `state` under `jurisdiction`. Read-only — nothing here derives a state, so a run can
 * never be the thing that changed the plan.
 *
 * Delegates to {@link projectScenarioParts}, the pipeline the chart and the solver panel already
 * share, and summarizes the report off the same series so the debug view reuses the run the chart
 * drew rather than simulating twice.
 *
 * `stopWorking` is the retirement solver's non-destructive boundary: absent for the ordinary
 * authored run, and set only for a hypothetical "what if everyone stopped working at this age"
 * preview. It rewrites no job — it caps the compiled spans — so the whole result stays a pure
 * function of state and the authored plan is never mutated.
 *
 * `meta` echoes the whole authored plan plus the run's jurisdiction id, so knobs the sim input
 * compiles away — life expectancy, retirement age, health lines — survive into the report and its
 * download.
 */
export function runProjection(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  stopWorking?: StopWorkingBoundary,
): ProjectionResult {
  const plan = state.scenario.plan;
  const { household, simInput, series } = projectScenarioParts(
    state.scenario,
    { jurisdiction, startYear: state.startYear },
    stopWorking,
  );
  const report = summarizeSimulation(
    simInput,
    series,
    { plan, jurisdictionId: jurisdiction.id },
    jurisdiction,
  );
  // Resolved on first ask and kept: a panel asks once per job per render, and the alternative
  // is re-resolving the household's whole job list for each of them.
  let payDisplays: Map<string, ResolvedJobPayDisplay> | null = null;
  const payDisplaysOf = (): Map<string, ResolvedJobPayDisplay> => {
    if (payDisplays === null) {
      const scope = stopWorking === undefined
        ? ({ kind: "authored" } as const)
        : ({ kind: "hypothetical", stopWorking } as const);
      payDisplays = new Map(
        householdJobContexts(household.memberships).map((ctx) => [
          ctx.job.id,
          resolveJobPayDisplay(ctx, state.startYear, scope),
        ]),
      );
    }
    return payDisplays;
  };

  const firstInsolvent = firstInsolventMonth(series);

  return Object.freeze({
    jurisdictionId: jurisdiction.id,
    series,
    firstInsolventMonth: firstInsolvent,
    household,
    report,
    snapshot: (month: number) => buildSnapshot(household, month, series),
    membersAt: (month: number) => membersAt(household, month),
    goalProgress: () => {
      const accounts = buildPlanAccounts(plan);
      return buildPlanGoals(plan).map((goal) => ({
        goal,
        progress: computeGoalProgress(goal, series, accounts),
      }));
    },
    assessHomePurchase: (input: HomePurchaseInput) =>
      assessHomePurchase(household, series, input),
    oneTimeSpendNudge: (eventId: string, eventMonth: number) =>
      assessOneTimeSpendNudge({
        eventId,
        eventMonth,
        blocked: series.status === "blocked",
        firstInsolventMonth: firstInsolvent,
      }),
    jobPayDisplay: (jobId: string) => payDisplaysOf().get(jobId) ?? null,
  });
}
