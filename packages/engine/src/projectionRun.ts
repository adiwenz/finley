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

import type { Jurisdiction } from "./jurisdiction";
import type { ProjectionState } from "./authoring/state";
import type { ProjectionSeries } from "./projection/simulate";
import { projectScenarioParts } from "./retirementSolver";
import { summarizeSimulation } from "./projection/report";
import type { SimulationReport } from "./projection/report";
import { buildSnapshot, membersAt } from "./projection/snapshot";
import type { HouseholdSnapshot } from "./projection/snapshot";
import type { Household } from "./ledger/household";
import type { Person } from "./person";
import { buildPlanAccounts, buildPlanGoals, firstInsolventMonth } from "./projectionBase";
import { computeGoalProgress } from "./goal";
import type { GoalProgress, SimGoal } from "./goal";
import { assessHomePurchase } from "./authoring/housing";
import type { HomePurchaseAssessment, HomePurchaseInput } from "./authoring/housing";

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
}

/**
 * Project `state` under `jurisdiction`. Read-only — nothing here derives a state, so a run can
 * never be the thing that changed the plan.
 *
 * Delegates to {@link projectScenarioParts}, the pipeline the chart and the solver panel already
 * share, and summarizes the report off the same series so the debug view reuses the run the chart
 * drew rather than simulating twice.
 *
 * `meta` echoes the whole authored plan plus the run's jurisdiction id, so knobs the sim input
 * compiles away — life expectancy, retirement age, health lines — survive into the report and its
 * download.
 */
export function runProjection(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
): ProjectionResult {
  const plan = state.scenario.plan;
  const { household, simInput, series } = projectScenarioParts(state.scenario, {
    jurisdiction,
    startYear: state.startYear,
  });
  const report = summarizeSimulation(
    simInput,
    series,
    { plan, jurisdictionId: jurisdiction.id },
    jurisdiction,
  );
  return Object.freeze({
    jurisdictionId: jurisdiction.id,
    series,
    firstInsolventMonth: firstInsolventMonth(series),
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
  });
}
