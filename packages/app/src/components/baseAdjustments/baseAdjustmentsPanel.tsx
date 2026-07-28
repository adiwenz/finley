/**
 * The **Base + Adjustments** budget editor. Direct manipulation, not a form: click the graph
 * to pick a month, every row shows what it resolves to *at that month*; type a number and
 * answer "just this month, or from here forward?". {@link routeMonthEdit} routes to the
 * right primitive — line override, ledger transaction, or job income override. There is no
 * `Adjustment` entity underneath. Months are labelled with calendar year and household age,
 * so a far-future edit reads as "age 50".
 *
 * The graph is the engine's itemized spending report: authored lines, the spending they
 * don't author (health, timeline expenses), and each debt's payment, so the stack totals the
 * month's whole obligation. Spending is never rationed away behind the user's back; an
 * unfinanceable plan says so outright. It reads the app's projected **scenario** (`series`,
 * passed in) — plan plus live timeline — never a re-projection of the bare plan.
 *
 * The budget lives on `Plan.budgetLines`, so editing here drives net worth, the retirement
 * solver, everything. A non-empty `budgetLines` replaces the scalar `expenseCents` series
 * outright (`projectionBase.ts`) — hence no separate scalar monthly-expenses control.
 *
 * The children own no state; what stays here spans them: the selected month, the staged
 * edit, which line form is disclosed (one at a time across both lists), and plan mutations.
 *
 * Earned income is NOT edited here — standing pay lives on the person's jobs, authored in
 * the Jobs panel. The exception is a one-off single-month change (bonus, missed paycheck),
 * which writes a per-job {@link import("@finley/engine").JobIncomeOverride} taxed as wages.
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
 * every memo keyed on the line list would recompute for a plan authoring no lines at all.
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
   * Passed in, not re-projected: projecting the bare plan drops every life event, so a
   * household paying a student loan saw a chart disagreeing with the net-worth graph beside
   * it.
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
  /** The last routed edit, with the row label it was made on (the route only has the id). */
  const [lastRoute, setLastRoute] = useState<{ route: MonthEditRoute; label: string } | null>(null);

  // Four cuts of the one projected scenario, derived separately so a reader (and React)
  // sees which view depends on what: spending (the engine's itemized report), income
  // bands, tax paid, and the income the plan pays each month.
  const spendingChartData = useMemo(() => buildPerLineBudgetData(series), [series]);
  const incomeChartData = useMemo(() => buildIncomeChartData(series), [series]);
  const taxChartData = useMemo(() => buildTaxChartData(series), [series]);
  /**
   * The EARNED + BENEFIT income the projection pays each month, indexed by month — the
   * pay-editing readonly's figure. Wages + government benefit, NOT the full taxable rollup
   * (`totalIncomeCents`): savings interest and asset drawdowns are real cash flow the
   * income chart shows, but they are not the pay this editor is about.
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

  // What the budget resolves to at the selected point. Only EXPENSE lines get
  // month-resolved amounts (the inline stage/commit override flow); contribution lines are
  // a flat literal into an account, listed in their own subsection below.
  const expenseLines = useMemo(() => expenseLinesOf(lines), [lines]);
  const contributionLines = useMemo(() => contributionLinesOf(lines), [lines]);
  const rows = useMemo(
    () => resolveRowsAtMonth(expenseLines, selectedMonth, editCtx.annualInflationRate),
    [expenseLines, selectedMonth, editCtx],
  );

  // Structural add/edit/delete of budget lines — distinct from the inline amount override
  // above. One disclosed form at a time, like the Jobs and Goals panels.
  const [lineAuthoring, setLineAuthoring] = useState<LineAuthoring | null>(null);

  function addLine(draft: BudgetLineDraft): void {
    setLines((prev) => addLineFromDraft(prev, draft));
    setLineAuthoring(null);
  }
  function editLine(id: string, draft: BudgetLineDraft): void {
    setLines((prev) => updateLineFromDraft(prev, id, draft));
    setLineAuthoring(null);
  }
  /**
   * Disclose (or close) a line's edit form. Expense rows and the contributions list open
   * into the same slot, so the one-at-a-time toggle is arbitrated here, not in either list.
   */
  function toggleLineForm(id: string): void {
    setLineAuthoring((a) => (a?.kind === "edit" && a.id === id ? null : { kind: "edit", id }));
  }
  function deleteLine(id: string): void {
    setLines((prev) => removeLine(prev, id));
    if (lineAuthoring?.kind === "edit" && lineAuthoring.id === id) setLineAuthoring(null);
  }

  /**
   * The month whose income the row and the one-off control act on. Month 0 is the
   * projection's flow-free opening snapshot (`simulate.ts` accrues flows only for
   * `month > 0`, so "now" is not redefined as an earning month), so income reads $0 there
   * even while the jobs pay full salaries. The income chart skips that month
   * ({@link buildIncomeChartData}); the row does too, acting on month 1 instead.
   */
  const incomeMonth = Math.max(1, selectedMonth);

  /**
   * Income the projection pays that month, summed across every job, plus any government
   * benefit once earnings stop. The row only *displays* the compiled total (standing income
   * is authored in the Jobs panel), so multiple jobs — any of them open-ended — are
   * reflected without the row picking "the" income, and the figure shows income stopping at
   * retirement and the benefit picking up at the claiming age.
   */
  const incomeAtMonth = incomeByMonth[incomeMonth] ?? 0;

  // Pay change against the selected month: one-month perturbations + permanent changes.
  // The form and its transient state live in {@link PayChangeEditor}; the panel keeps only
  // the mutation, so the child never touches `Plan`, the ledger, or their setters.
  //
  // EVERY earner's jobs, not just the primary person's: a partner's bonus, missed paycheck,
  // raise or cut is the same adjustment on the same `Job` model, and the picker names whose
  // job each one is.
  const owners = useMemo(() => jobOwnersOf(household, ledger), [household, ledger]);
  const jobOptions = useMemo(
    () => ownedJobsOf(owners).map(({ job, label }) => ({ id: job.id, label })),
    [owners],
  );

  /**
   * Rewrite the selected job wherever it lives. `revise` is handed the whole existing job,
   * so its other overrides, pay changes and unrelated fields ride through. Routing (plan
   * vs. the partner's `RelationshipEvent`) and the all-or-nothing commit belong to
   * {@link commitJobWrites}.
   */
  function adjustJob(jobId: string, revise: (job: Job) => Job): void {
    const result = reviseJob(owners, jobId, revise);
    if (result.ok) commitJobWrites(result.writes, { setBudget, onReviseEvents });
  }

  /**
   * Move the editor to a different point. A staged-but-uncommitted edit is dropped: it was
   * framed against the old month's numbers ("Housing $1,600 → $2,400 at month 14"), so
   * carrying it forward would commit a change the user never read.
   *
   * Stable, like {@link applyQuickstart}: both are props of the memoized graphs, which a
   * fresh identity each render would re-render for nothing.
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

  /**
   * Answer the how-long question — the one gesture that commits a spending change. Only
   * budget *lines* are edited in place here (earned income goes through the Jobs panel or
   * the one-off control above), so a staged edit is always a line override.
   */
  function commit(scope: EditScope): void {
    if (pending === null) return;
    const route = routeMonthEdit({ ...pending, month: selectedMonth, scope });
    setLastRoute({ route, label: pending.label });
    if (route.kind === "lineOverride") {
      setLines((prev) => [...applyLineOverride(prev, route.lineId, route.override)]);
    }
    setPending(null);
  }

  /** Month the household retires — where the savings line stops (see the quickstart). */
  const retirementMonth = Math.max(0, (plan.retirementAge - plan.currentAge) * 12);

  const applyQuickstart = useCallback((): void => {
    // Non-destructive: rebalance existing lines to 50/30/20, keeping their names. Off the
    // WHOLE household's standing pay — reading one earner's jobs would size a two-earner
    // household's spending to half its income. Identical on a single-earner plan.
    const monthlyIncomeCents = owners.reduce(
      (sum, o) =>
        sum + o.jobs.reduce((s, j) => s + Math.round(j.salary.startingSalaryCents / 12), 0),
      0,
    );
    setLines((prev) => redistributeToTiers(prev, monthlyIncomeCents, retirementMonth));
    setPending(null);
  }, [plan, retirementMonth, setLines]);

  const horizonMonths = spendingChartData.rows.length;

  /** The edit gesture, and what a line list may do to the authored budget. */
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

  // No `card` class: `main.tsx` wraps every panel in one. Carrying one here too drew a box
  // in a box.
  return (
    <section>
      <h2>Base + Adjustments</h2>

      {/* Graph: click a point to move the editor there — the edit gesture. */}
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

      {/* The point on the budget being edited. */}
      <div>
        <div className="row-between">
          <h3 data-testid="selected-month">Editing {describeMonth(selectedMonth, plan.currentAge)}</h3>
          {/* Keyboard/assistive path to the same selection the chart click makes. */}
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

        {/* Pay change against the selected month: one-month perturbations (bonus, corrected
            month, $0 for a missed paycheck — a per-job {@link JobIncomeOverride}) and
            PERMANENT changes from this month forward (a {@link JobPayChange}). All taxed as
            wages through the job's series. The form owns its transient state. */}
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

        {/* Savings & contributions: money paid into an account each month. Unlike
            spending, these accumulate in net worth — funded by the sim. */}
        <ContributionsEditor
          lines={contributionLines}
          authoring={lineAuthoring}
          form={lineFormActions}
        />

        {/* Add a new budget item (expense or contribution). */}
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
