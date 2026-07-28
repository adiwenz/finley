/**
 * The **Base + Adjustments** budget editor. Every row resolves *at the selected month*; typing
 * a number asks "just this month, or from here forward?", and {@link routeMonthEdit}
 * decomposes the answer into existing primitives — there is no `Adjustment` entity underneath.
 *
 * A non-empty `Plan.budgetLines` replaces the scalar `expenseCents` series outright
 * (`projectionBase.ts`) — hence no separate scalar monthly-expenses control.
 *
 * The children own no state: the selected month, the staged edit and the open line form (one
 * at a time across both lists) live here.
 *
 * Standing pay lives on the person's jobs, authored in the Jobs panel; only a one-off
 * single-month change is written here, as a per-job
 * {@link import("@finley/engine").JobIncomeOverride}.
 */

import type { Dispatch, SetStateAction } from "react";
import { useCallback, useMemo, useState } from "react";
import {
  dollarsToCents,
  type BudgetLine,
  type Household,
  type Job,
  type Ledger,
  type Plan,
  type ProjectionSeries,
} from "@finley/engine";
import { START_YEAR } from "../../config";
import { formatDollars } from "../../format";
import { NumInput } from "../numInput/numInput";
import { redistributeToTiers } from "./budgetTemplate";
import { BudgetLineForm } from "./budgetLineForm";
import { PayChangeEditor } from "./payChangeEditor";
import {
  addLineFromDraft,
  blankLineDraft,
  contributionLinesOf,
  expenseLinesOf,
  removeLine,
  updateLineFromDraft,
  type BudgetLineDraft,
} from "./budgetLines";
import { withIncomeOverride, withPayChange } from "../../planPeople";
import { jobOwnersOf } from "../../jobOwners";
import { ownedJobsOf, reviseJob } from "../../jobEditing";
import { commitJobWrites } from "../../jobWrites";
import type { EventRevision } from "../../hooks/useLedger";
import {
  applyLineOverride,
  resolveRowsAtMonth,
  routeMonthEdit,
  type EditRow,
  type EditScope,
  type MonthEditContext,
  type MonthEditRoute,
} from "./monthEdit";
import { buildIncomeChartData } from "./incomeByCategory";
import { buildPerLineBudgetData } from "./perLineBudget";
import { buildTaxChartData } from "./taxesByMonth";
import { ProjectionCharts } from "./projectionCharts";
import { SpendingEditor, type PendingEdit, type SpendingEditActions } from "./spendingEditor";
import { ContributionsEditor } from "./contributionsEditor";
import type { LineAuthoring, LineFormActions } from "./budgetLineAuthoring";
import styles from "./baseAdjustments.module.css";

/**
 * Module-level, not a `?? []` fallback: a fresh literal each render is a new identity, so
 * every memo keyed on the line list would recompute.
 */
const NO_BUDGET_LINES: readonly BudgetLine[] = [];

/** "month 180 · 2041 · age 50". */
function describeMonth(month: number, currentAge: number): string {
  const year = START_YEAR + Math.floor(month / 12);
  const age = currentAge + Math.floor(month / 12);
  return `month ${month} · ${year} · age ${age}`;
}

export interface BaseAdjustmentsPanelProps {
  readonly plan: Plan;
  readonly setBudget: Dispatch<SetStateAction<Plan>>;
  /**
   * Passed in, not re-projected: projecting the bare plan drops every life event, so the
   * chart disagreed with the net-worth graph beside it.
   */
  readonly series: ProjectionSeries;
  /**
   * Member names by person id: labels name the kind of income, not the earner, so two
   * benefit claimants would otherwise draw two identically-labelled legend entries.
   */
  readonly personNames: ReadonlyMap<string, string>;
  /**
   * Who holds which jobs, and where those jobs are authored. `Plan.jobs` holds only the
   * *primary* person's, so reaching into it directly left a partner's raise going nowhere.
   */
  readonly household: Household;
  readonly ledger: Ledger;
  /** Revise ledger events in one all-or-nothing write. */
  readonly onReviseEvents: (revisions: readonly EventRevision[]) => boolean;
}

export function BaseAdjustmentsPanel({
  plan,
  setBudget,
  series,
  personNames,
  household,
  ledger,
  onReviseEvents,
}: BaseAdjustmentsPanelProps) {
  const lines = plan.budgetLines ?? NO_BUDGET_LINES;
  // Rows are shown in the selected month's dollars — the same price growth the projection
  // uses to get there and back.
  const editCtx: MonthEditContext = useMemo(
    () => ({ annualInflationRate: plan.inflationPct / 100 }),
    [plan.inflationPct],
  );
  const setLines = useCallback(
    (next: (prev: readonly BudgetLine[]) => readonly BudgetLine[]): void =>
      setBudget((p) => ({ ...p, budgetLines: [...next(p.budgetLines ?? NO_BUDGET_LINES)] })),
    [setBudget],
  );

  const [selectedMonth, setSelectedMonth] = useState(0);
  const [pending, setPending] = useState<PendingEdit | null>(null);
  /** The route carries only the line id, so the row's label rides along with it. */
  const [lastRoute, setLastRoute] = useState<{ route: MonthEditRoute; label: string } | null>(null);

  const spendingChartData = useMemo(() => buildPerLineBudgetData(series), [series]);
  const incomeChartData = useMemo(() => buildIncomeChartData(series), [series]);
  const taxChartData = useMemo(() => buildTaxChartData(series), [series]);
  /**
   * Wages + government benefit, not the full taxable rollup (`totalIncomeCents`): savings
   * interest and asset drawdowns are cash flow, but not pay.
   */
  const incomeByMonth = useMemo(
    () =>
      series.months.map((m) => {
        const byCategory = m.flows?.incomeByCategoryCents;
        if (byCategory === undefined) return 0;
        return (byCategory.wages ?? 0) + (byCategory.governmentRetirementBenefit ?? 0);
      }),
    [series],
  );

  // Only expense lines get month-resolved amounts; contribution lines are a flat literal
  // into an account.
  const expenseLines = useMemo(() => expenseLinesOf(lines), [lines]);
  const contributionLines = useMemo(() => contributionLinesOf(lines), [lines]);
  const rows = useMemo(
    () => resolveRowsAtMonth(expenseLines, selectedMonth, editCtx.annualInflationRate),
    [expenseLines, selectedMonth, editCtx],
  );

  // Structural add/edit/delete, distinct from the inline amount override above. One form
  // disclosed at a time, like the Jobs and Goals panels.
  const [lineAuthoring, setLineAuthoring] = useState<LineAuthoring | null>(null);

  function addLine(draft: BudgetLineDraft): void {
    setLines((prev) => addLineFromDraft(prev, draft));
    setLineAuthoring(null);
  }
  function editLine(id: string, draft: BudgetLineDraft): void {
    setLines((prev) => updateLineFromDraft(prev, id, draft));
    setLineAuthoring(null);
  }
  /** Expense rows and the contributions list share one slot, so the toggle is arbitrated here. */
  function toggleLineForm(id: string): void {
    setLineAuthoring((a) => (a?.kind === "edit" && a.id === id ? null : { kind: "edit", id }));
  }
  function deleteLine(id: string): void {
    setLines((prev) => removeLine(prev, id));
    if (lineAuthoring?.kind === "edit" && lineAuthoring.id === id) setLineAuthoring(null);
  }

  /**
   * Month 0 is the projection's flow-free opening snapshot (`simulate.ts` accrues flows only
   * for `month > 0`), so income reads $0 there even while the jobs pay full salaries. The
   * income chart skips that month; the row does too.
   */
  const incomeMonth = Math.max(1, selectedMonth);

  /** Display only: the total across every job, so no row has to pick *the* income. */
  const incomeAtMonth = incomeByMonth[incomeMonth] ?? 0;

  // Every earner's jobs, not just the primary person's; the picker names whose is whose.
  const owners = useMemo(() => jobOwnersOf(household, ledger), [household, ledger]);
  const jobOptions = useMemo(
    () => ownedJobsOf(owners).map(({ job, label }) => ({ id: job.id, label })),
    [owners],
  );

  /**
   * `revise` is handed the whole existing job, so its other overrides and pay changes ride
   * through. Routing (plan vs. the partner's `RelationshipEvent`) and the all-or-nothing
   * commit belong to {@link commitJobWrites}.
   */
  function adjustJob(jobId: string, revise: (job: Job) => Job): void {
    const result = reviseJob(owners, jobId, revise);
    if (result.ok) commitJobWrites(result.writes, { setBudget, onReviseEvents });
  }

  /**
   * A staged-but-uncommitted edit is dropped: framed against the old month's numbers,
   * carrying it forward would commit a change the user never read. Stable identity, like
   * {@link applyQuickstart} — both are props of the memoized graphs.
   */
  const selectMonth = useCallback((month: number): void => {
    setSelectedMonth(month);
    setPending(null);
  }, []);

  function stageEdit(row: EditRow, label: string, priorCents: number, dollars: number): void {
    const newAmountCents = dollarsToCents(dollars);
    if (newAmountCents === priorCents) {
      setPending(null);
      return;
    }
    setPending({ row, label, priorAmountCents: priorCents, newAmountCents });
  }

  /** Only budget *lines* are edited in place here, so a staged edit is always a line override. */
  function commit(scope: EditScope): void {
    if (pending === null) return;
    const route = routeMonthEdit({ ...pending, month: selectedMonth, scope });
    setLastRoute({ route, label: pending.label });
    if (route.kind === "lineOverride") {
      setLines((prev) => [...applyLineOverride(prev, route.lineId, route.override)]);
    }
    setPending(null);
  }

  /** Where the quickstart's savings line stops. */
  const retirementMonth = Math.max(0, (plan.retirementAge - plan.currentAge) * 12);

  const applyQuickstart = useCallback((): void => {
    // Non-destructive: rebalance existing lines to 50/30/20, keeping their names. Off the
    // whole household's standing pay — one earner's jobs would size a two-earner
    // household's spending to half its income.
    const monthlyIncomeCents = owners.reduce(
      (sum, o) =>
        sum + o.jobs.reduce((s, j) => s + Math.round(j.salary.startingSalaryCents / 12), 0),
      0,
    );
    setLines((prev) => redistributeToTiers(prev, monthlyIncomeCents, retirementMonth));
    setPending(null);
  }, [plan, retirementMonth, setLines]);

  const horizonMonths = spendingChartData.rows.length;

  const editActions: SpendingEditActions = {
    onStage: stageEdit,
    onCommit: commit,
    onCancel: () => setPending(null),
  };
  const lineFormActions: LineFormActions = {
    onToggle: toggleLineForm,
    onSubmit: editLine,
    onClose: () => setLineAuthoring(null),
    onDelete: deleteLine,
  };

  // No `card` class: `main.tsx` already wraps every panel in one — a second drew a box in a
  // box.
  return (
    <section>
      <h2>Base + Adjustments</h2>

      {/* Click a point to move the editor to that month. */}
      <ProjectionCharts
        incomeData={incomeChartData}
        spendingData={spendingChartData}
        taxData={taxChartData}
        currentAge={plan.currentAge}
        personNames={personNames}
        selectedMonth={selectedMonth}
        onSelectMonth={selectMonth}
        onQuickstart={applyQuickstart}
      />

      {/* The point being edited. */}
      <div>
        <div className="row-between">
          <h3 data-testid="selected-month">Editing {describeMonth(selectedMonth, plan.currentAge)}</h3>
          {/* Keyboard/assistive path to the same selection. */}
          <NumInput
            label="Month"
            value={selectedMonth}
            onChange={(m) => selectMonth(Math.max(0, Math.min(horizonMonths, Math.round(m))))}
          />
        </div>

        <h4 className={styles.groupHeading}>Income</h4>
        <div className={styles.lineRow}>
          <span className={styles.lineLabel}>Income</span>
          <span className={styles.readonlyValue} data-testid="income-readonly">
            {formatDollars(incomeAtMonth)}/mo
          </span>
        </div>
        <p className="hint">
          Income comes from your jobs — edit your standing pay in “Jobs &amp; income”
          below. This shows the total your jobs pay at the selected month.
        </p>

        {/* One-month perturbations (a per-job {@link JobIncomeOverride}) and permanent
            changes from the selected month forward (a {@link JobPayChange}). Both taxed as
            wages through the job's series. */}
        <PayChangeEditor
          jobs={jobOptions}
          incomeMonth={incomeMonth}
          onApplyOverride={(jobId, override) => adjustJob(jobId, (j) => withIncomeOverride(j, override))}
          onApplyPayChange={(jobId, payChange) => adjustJob(jobId, (j) => withPayChange(j, payChange))}
        />

        <SpendingEditor
          rows={rows}
          lines={lines}
          selectedMonth={selectedMonth}
          pending={pending}
          lastRoute={lastRoute}
          authoring={lineAuthoring}
          edit={editActions}
          form={lineFormActions}
        />

        {/* Unlike spending, these accumulate in net worth. */}
        <ContributionsEditor
          lines={contributionLines}
          authoring={lineAuthoring}
          form={lineFormActions}
        />

        {/* Expense or contribution. */}
        {lineAuthoring?.kind === "new" ? (
          <BudgetLineForm
            initial={blankLineDraft("expense")}
            submitLabel="Add"
            onSubmit={addLine}
            onCancel={() => setLineAuthoring(null)}
          />
        ) : (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setPending(null);
              setLineAuthoring({ kind: "new" });
            }}
          >
            + Add a budget item
          </button>
        )}
      </div>
    </section>
  );
}
