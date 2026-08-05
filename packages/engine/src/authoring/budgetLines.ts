/**
 * Budget-line authoring, plus the one read that resolves a line to what it is at a month.
 *
 * Every line is standing plan data — there is no ledger plane here — so each write is a plan
 * swap guarded by the shared existence check, and nothing needs a jurisdiction.
 */

import type {
  BudgetCategory,
  BudgetLine,
  BudgetLineOverride,
  BudgetLinePatch,
} from "../budgetLine";
import { withLineOverride, withLinePatch, withoutLine } from "../budgetLine";
import { compileExpenseBudgetLines } from "../compile/compileBudget";
import type { Cents } from "../money";
import type { ProjectionState, Written } from "./state";
import { planSite, withStatePlan } from "./state";
import { mint } from "./mint";

/**
 * A budget line as a caller authors it — no `id`. Unlike a job, a line is never handed between
 * owners and nothing outside the engine needs to choose its name, so there is no reason for a
 * caller to supply one: {@link addProjectionBudgetLine} always mints.
 */
export type BudgetLineInput = Omit<BudgetLine, "id">;

/** One expense line as it stands at a month. See {@link resolveExpenseRows}. */
export interface ResolvedExpenseRow {
  readonly lineId: string;
  readonly label: string;
  readonly category: BudgetCategory;
  /** In that month's dollars — the figure the projection charges and the graph draws. */
  readonly monthlyCents: Cents;
  /** True when a dated override, rather than the base amount, is what is showing. */
  readonly overridden: boolean;
}

/**
 * Owner tag for the throwaway compilation behind {@link resolveExpenseRows}. Expense owners are inert
 * in the pipeline; the preview never reaches a simulation.
 */
const EXPENSE_PREVIEW_OWNER = "expense-preview";

/** Answers with the minted `"line-N"` id — always minted; a caller cannot name a line. */
export function addProjectionBudgetLine(
  state: ProjectionState,
  line: BudgetLineInput,
): Written<string> {
  const { id, nextSeq } = mint(state, "line");
  const newLine: BudgetLine = { id, ...line };
  const plan = state.scenario.plan;
  return {
    state: withStatePlan(state, { ...plan, budgetLines: [...plan.budgetLines, newLine] }, nextSeq),
    result: id,
  };
}

/**
 * See {@link withLinePatch} — span, dated overrides and priority carry through. Refused for an
 * id the plan does not hold.
 */
export function updateProjectionBudgetLine(
  state: ProjectionState,
  id: string,
  patch: BudgetLinePatch,
): ProjectionState {
  const plan = planSite(state, "budgetLines", id);
  return withStatePlan(state, {
    ...plan,
    budgetLines: withLinePatch(plan.budgetLines, id, patch),
  });
}

/**
 * Layer a dated amount override onto one line — the "just this month" / "from here forward"
 * answer, which is a fact about the line rather than a new authored amount (see
 * {@link withLineOverride} for the one-per-(scope, month) rule).
 *
 * Beside {@link updateProjectionBudgetLine} rather than inside it: a patch REPLACES the
 * `overrides` array it is given, so routing an override through one would drop every other dated
 * change on the line unless the caller re-sent them all — exactly the read-modify-write this API
 * exists to keep out of callers.
 */
export function addProjectionBudgetLineOverride(
  state: ProjectionState,
  lineId: string,
  override: BudgetLineOverride,
): ProjectionState {
  const plan = planSite(state, "budgetLines", lineId);
  return withStatePlan(state, {
    ...plan,
    budgetLines: withLineOverride(plan.budgetLines, lineId, override),
  });
}

/**
 * Drop a budget line. Nothing to guard beyond its existence: a line derives no account an event
 * can reference, so no ledger reference can dangle.
 */
export function removeProjectionBudgetLine(
  state: ProjectionState,
  id: string,
): ProjectionState {
  const plan = planSite(state, "budgetLines", id);
  return withStatePlan(state, { ...plan, budgetLines: withoutLine(plan.budgetLines, id) });
}

/**
 * Every expense line resolved to what it is **at `month`**: base amount, any dated override
 * layered on, and the price growth accrued by then. The amounts come off the very series the
 * simulator charges, so an editor showing a month and the projection running it cannot drift.
 *
 * Resolved rows, not the compiled series they are read from: a caller wants the number and
 * whether an override is what is showing, and the compiler's `SimOwnedSeries` is an internal
 * with a lifetime and an owner tag that mean nothing outside the pipeline.
 *
 * Contribution lines are absent by construction — they pay a literal amount into an account and
 * have no month-resolved value to preview.
 */
export function resolveExpenseRows(
  state: ProjectionState,
  month: number,
): readonly ResolvedExpenseRow[] {
  const plan = state.scenario.plan;
  const lines = plan.budgetLines.filter((line) => line.target.kind === "expense");
  const compiled = new Map(
    compileExpenseBudgetLines(lines, EXPENSE_PREVIEW_OWNER, plan.inflationPct / 100).map((s) => [
      s.lineId,
      s.series,
    ]),
  );
  return lines.map((line) => ({
    lineId: line.id,
    label: line.label,
    category: line.category,
    monthlyCents: compiled.get(line.id)?.getMonthlyCents(month) ?? 0,
    overridden: (line.overrides ?? []).some(
      (o) =>
        (o.scope === "thisMonthOnly" && o.month === month) ||
        (o.scope === "fromHereForward" && o.month <= month),
    ),
  }));
}
