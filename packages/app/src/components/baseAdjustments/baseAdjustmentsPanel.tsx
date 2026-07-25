/**
 * The **Base + Adjustments** budget editor (§18–§20, "UI: Base + Adjustments" of
 * JOBS_HOUSEHOLD_REDESIGN, issue #71). Direct manipulation, not a form:
 *
 *   - **Base** — the standing line-item budget, prepopulated from a default template
 *     (or the %-quickstart) and edited in place (AC3).
 *   - **Pick a point** — click anywhere on the graph to select a month. Every row
 *     below then shows what it *actually resolves to at that month* (§19), including
 *     changes made earlier in the session.
 *   - **Edit, then choose how long** — type a new number and answer one question:
 *     just this month, or from here forward? {@link routeMonthEdit} sends the result
 *     to the right primitive — line override, ledger transaction, or job/stream
 *     income override (AC4). There is no `Adjustment` entity underneath.
 *   - **Graph** — what each month actually costs, straight off the engine's itemized
 *     spending report: the budget lines as authored, the spending they don't author
 *     (health, timeline expenses), and each debt's payment, so the stack totals the
 *     month's whole obligation. Spending is never rationed away behind the user's
 *     back; if the plan stops being financeable the graph says so outright (AC2).
 *
 * The selected month is labelled with its calendar year *and* the household's age at
 * that point, so a far-future edit reads as the milestone it is ("age 50") rather than
 * as an opaque month index — the long-horizon affordance of AC5, without a 40-year
 * month-by-month scrubber.
 *
 * The budget lives on the app's `Plan.budgetLines`, so editing here drives the whole
 * app — net worth, the retirement solver, everything. A non-empty `budgetLines`
 * replaces the scalar `expenseCents` series outright (`projectionBase.ts`), which is
 * why the old scalar monthly-expenses control is gone: one budget, one place to edit
 * it.
 *
 * The graphs read the app's projected **scenario** (`series`, passed in) — the plan plus
 * the live timeline — never a re-projection of the bare plan, and nothing about them is
 * reassembled here from the household model. Editing is about the budget; *drawing* is
 * about the whole financial life, so a loan taken on the timeline is part of what income
 * must cover here exactly as it is on the net-worth graph.
 *
 * The panel is the composition point, not the whole surface: the graphs
 * ({@link ProjectionCharts}), the spending rows ({@link SpendingEditor}), and the
 * contributions list ({@link ContributionsEditor}) are children that own no state. What
 * stays here is what genuinely spans them — the selected month (the chart click and the
 * editor below are the same cursor), the staged edit awaiting its how-long answer, which
 * line form is disclosed (one at a time across both lists), and every mutation of the
 * plan.
 *
 * Earned income is NOT edited here. Standing pay lives on the person's jobs, authored in
 * the Jobs panel (§6, issue #72); this panel only *displays* the compiled income total at
 * the selected month (read-only). The one exception is a **one-off, single-month** change
 * — a bonus, a missed paycheck, a corrected month — which writes a per-job
 * {@link import("@finley/engine").JobIncomeOverride} taxed as wages, so it belongs with the
 * month-selection UI here rather than in the standing Jobs panel.
 */

import type { Dispatch, SetStateAction } from "react";
import { useMemo, useState } from "react";
import {
  dollarsToCents,
  type BudgetLine,
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
import { addIncomeOverride, addJobPayChange, primaryJobs, totalMonthlyIncomeCents } from "../../planPeople";
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
 * The empty budget. A module-level constant rather than a `?? []` fallback: a fresh
 * literal each render is a new identity, so every memo and child keyed on the line list
 * would recompute (and re-render) for a plan that authors no lines at all.
 */
const NO_BUDGET_LINES: readonly BudgetLine[] = [];

/** "month 180 · 2041 · age 50" — the point on the budget, in the terms a user thinks in. */
function describeMonth(month: number, currentAge: number): string {
  const year = START_YEAR + Math.floor(month / 12);
  const age = currentAge + Math.floor(month / 12);
  return `month ${month} · ${year} · age ${age}`;
}

export interface BaseAdjustmentsPanelProps {
  readonly plan: Plan;
  readonly setBudget: Dispatch<SetStateAction<Plan>>;
  /**
   * The projected **scenario** — the plan AND the timeline replayed on top of it — as
   * the rest of the app draws it. Passed in rather than re-projected here on purpose:
   * projecting the bare plan silently dropped every life event, so a household paying a
   * student loan saw a spending need that omitted the payment and a chart that
   * disagreed with the net-worth graph beside it. One simulation, one scenario.
   */
  readonly series: ProjectionSeries;
}

export function BaseAdjustmentsPanel({ plan, setBudget, series }: BaseAdjustmentsPanelProps) {
  // The budget is the plan's, not the panel's — editing here moves the whole app.
  const lines = plan.budgetLines ?? NO_BUDGET_LINES;
  // Every row is shown in the selected month's dollars, so the editor needs the same
  // price growth the projection uses to get there and back.
  const editCtx: MonthEditContext = useMemo(
    () => ({ annualInflationRate: plan.inflationPct / 100 }),
    [plan.inflationPct],
  );
  const setLines = (next: (prev: readonly BudgetLine[]) => readonly BudgetLine[]): void =>
    setBudget((p) => ({ ...p, budgetLines: [...next(p.budgetLines ?? [])] }));

  const [selectedMonth, setSelectedMonth] = useState(0);
  const [pending, setPending] = useState<PendingEdit | null>(null);
  /** The last routed edit, with the row label it was made on (the route only has the id). */
  const [lastRoute, setLastRoute] = useState<{ route: MonthEditRoute; label: string } | null>(null);

  // Four cuts of the one projected scenario, each derived on its own so a reader (and
  // React) can see which view depends on what: what the household spends (the engine's
  // itemized spending report), the income bands, the tax paid, and the income the plan
  // actually pays each month.
  const spendingChartData = useMemo(() => buildPerLineBudgetData(series), [series]);
  const incomeChartData = useMemo(() => buildIncomeChartData(series), [series]);
  const taxChartData = useMemo(() => buildTaxChartData(series), [series]);
  /** Gross income the projection pays in each month, indexed by month. */
  const incomeByMonth = useMemo(
    () => series.months.map((m) => m.flows?.totalIncomeCents ?? 0),
    [series],
  );

  // ── What the budget resolves to at the selected point ──
  // Only EXPENSE lines get month-resolved amounts (the inline stage/commit override
  // flow). Contribution lines are a separate concern (a flat literal into an account),
  // listed in their own subsection below.
  const expenseLines = useMemo(() => expenseLinesOf(lines), [lines]);
  const contributionLines = useMemo(() => contributionLinesOf(lines), [lines]);
  const rows = useMemo(
    () => resolveRowsAtMonth(expenseLines, selectedMonth, editCtx.annualInflationRate),
    [expenseLines, selectedMonth, editCtx],
  );

  // Add / edit / delete of budget lines (structural — distinct from the inline amount
  // override above). One disclosed form at a time, like the Jobs and Goals panels.
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
   * Disclose (or close) the edit form for a line. One form at a time across the whole
   * editor — the expense rows and the contributions list open into the same slot — so
   * the toggle is arbitrated here rather than inside either list.
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
   * `month > 0`, so "now" is not redefined as an earning month — GH #34), so income
   * reads $0 there even while the jobs pay full salaries. Reading month 0 verbatim showed
   * the row at $0; the income chart already skips that month ({@link buildIncomeChartData}),
   * so the row does too by acting on month 1 when the opening month is selected.
   */
  const incomeMonth = Math.max(1, selectedMonth);

  /**
   * Income the projection actually pays that month, summed across every job (§6), plus
   * any government benefit once earnings stop. Standing income is authored in the Jobs
   * panel — this row only *displays* the compiled total, so multiple jobs (any of them
   * open-ended) are reflected here without the row having to pick "the" income. The
   * figure also shows income stopping at retirement and the benefit picking up at the
   * claiming age, rather than a salary compounding forever.
   */
  const incomeAtMonth = incomeByMonth[incomeMonth] ?? 0;

  // ── Pay change against the selected month: one-month perturbations + permanent pay changes (§6/§10.3/§20) ──
  // The form and its transient state live in {@link PayChangeEditor}; the panel keeps
  // only plan mutation, so the child never touches `Plan` or `setBudget`.
  const jobs = primaryJobs(plan);

  /**
   * Move the editor to a different point. Any staged-but-uncommitted edit is dropped:
   * it was framed against the old month's numbers ("Housing $1,600 → $2,400 at month
   * 14"), so carrying it to a new month would commit a change the user never read.
   */
  function selectMonth(month: number): void {
    setSelectedMonth(month);
    setPending(null);
  }

  function stageEdit(row: EditRow, label: string, priorCents: number, dollars: number): void {
    const newAmountCents = dollarsToCents(dollars);
    if (newAmountCents === priorCents) {
      setPending(null);
      return;
    }
    setPending({ row, label, priorAmountCents: priorCents, newAmountCents });
  }

  /**
   * Answer the how-long question — the one gesture that commits a spending change (§20).
   * Only budget *lines* are edited in place here now; earned income is authored in the
   * Jobs panel (standing) or via the one-off control above (single month), so a staged
   * edit is always a line override.
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

  function applyQuickstart(): void {
    // Non-destructive: rebalance the existing lines to 50/30/20, keeping their names.
    setLines((prev) => redistributeToTiers(prev, totalMonthlyIncomeCents(plan), retirementMonth));
    setPending(null);
  }

  const horizonMonths = spendingChartData.rows.length;

  /** The §20 edit gesture, and what a line list may do to the authored budget. */
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

  // No `card` class here: `main.tsx` supplies the card wrapper for every panel, as it
  // does for Goals, Retirement, and Debug. Carrying one internally too drew a box in a box.
  return (
    <section>
      <h2>Base + Adjustments</h2>

      {/* ── Graph: click a point to move the editor there (AC2 + the edit gesture) ── */}
      <ProjectionCharts
        incomeData={incomeChartData}
        spendingData={spendingChartData}
        taxData={taxChartData}
        currentAge={plan.currentAge}
        selectedMonth={selectedMonth}
        onSelectMonth={selectMonth}
        onQuickstart={applyQuickstart}
      />

      {/* ── The point on the budget being edited ── */}
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

        {/* Pay change against the selected month: one-month perturbations (a bonus, a
            corrected month, or $0 for a missed paycheck — a per-job {@link JobIncomeOverride})
            and PERMANENT changes from this month forward (a {@link JobPayChange}). All taxed
            as wages through the job's series (§6/§10.3/§20). The form owns its own transient
            state; the panel keeps only plan mutation. */}
        <PayChangeEditor
          jobs={jobs}
          incomeMonth={incomeMonth}
          onApplyOverride={(jobId, override) => setBudget((p) => addIncomeOverride(p, jobId, override))}
          onApplyPayChange={(jobId, payChange) => setBudget((p) => addJobPayChange(p, jobId, payChange))}
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

        {/* ── Savings & contributions: money paid into an account each month (§12).
            Unlike spending, these accumulate in net worth — funded by the sim. ── */}
        <ContributionsEditor
          lines={contributionLines}
          authoring={lineAuthoring}
          form={lineFormActions}
        />

        {/* ── Add a new budget item (expense or contribution) ── */}
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
