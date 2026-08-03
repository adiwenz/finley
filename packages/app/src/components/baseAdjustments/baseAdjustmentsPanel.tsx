/**
 * The **Base + Adjustments** budget editor. Every row resolves *at the selected month*; typing
 * a number asks "just this month, or from here forward?", and {@link routeMonthEdit}
 * decomposes the answer into existing primitives — there is no `Adjustment` entity underneath.
 *
 * `Plan.budgetLines` is the sole expense authoring surface (`projectionBase.ts`) — hence no
 * separate monthly-expenses control.
 *
 * The children own no state: the selected month, the staged edit and the open line form (one
 * at a time across both lists) live here.
 *
 * Standing pay lives on the person's jobs, authored in the Jobs panel; only a one-off
 * single-month change is written here, as a per-job
 * {@link import("@finley/engine").JobIncomeOverride}.
 */

import { useCallback, useMemo, useState } from "react";
import {
  dollarsToCents,
  orderedIncomeOverrides,
  type FinancialObligation,
  type Household,
  type Ledger,
  type Plan,
  type Projection,
  type ProjectionSeries,
  type ResolvedFunding,
} from "@finley/engine";
import { START_YEAR } from "../../config";
import { formatDollars } from "../../format";
import { NumInput } from "../numInput/numInput";
import { tierRebalanceWrites } from "./budgetTemplate";
import { BudgetLineForm } from "./budgetLineForm";
import { PayChangeEditor } from "./payChangeEditor";
import {
  budgetLineInputFromDraft,
  budgetLinePatchFromDraft,
  blankLineDraft,
  contributionLinesOf,
  type BudgetLineDraft,
} from "./budgetLines";
import { jobOwnersOf } from "../../jobOwners";
import { ownedJobsOf } from "../../jobEditing";
import type { Transact } from "../../hooks/useProjection";
import {
  routeMonthEdit,
  type EditRow,
  type EditScope,
  type MonthEditRoute,
} from "./monthEdit";
import { buildIncomeChartData } from "./incomeChartData";
import { buildPerLineBudgetData } from "./perLineBudget";
import { buildTaxChartData } from "./taxesByMonth";
import { ProjectionCharts } from "./projectionCharts";
import { FundingAttribution } from "./fundingAttribution";
import { SpendingEditor, type PendingEdit, type SpendingEditActions } from "./spendingEditor";
import { ContributionsEditor } from "./contributionsEditor";
import type { LineAuthoring, LineFormActions } from "./budgetLineAuthoring";
import styles from "./baseAdjustments.module.css";

/** Stable empty defaults, hoisted so a flow-free month never mints a fresh array each render. */
const EMPTY_OBLIGATIONS: readonly FinancialObligation[] = [];
const EMPTY_FUNDING: readonly ResolvedFunding[] = [];

/** "month 180 · 2041 · age 50". */
function describeMonth(month: number, currentAge: number): string {
  const year = START_YEAR + Math.floor(month / 12);
  const age = currentAge + Math.floor(month / 12);
  return `month ${month} · ${year} · age ${age}`;
}

export interface BaseAdjustmentsPanelProps {
  readonly plan: Plan;
  /**
   * One transaction per edit. Every write this panel makes — a line added, renamed, deleted or
   * overridden at a month, a job's raise on either plane — goes through the facade, so the id
   * mint and the ledger's validation stay on the far side of it.
   */
  readonly transact: Transact;
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
  /**
   * The three reads this panel makes: what each expense line resolves to at the selected month,
   * the household's standing pay the quickstart sizes its tiers against, and the plan's account
   * ids/labels so the "Funded by" section can name an account rather than print its id. Writes
   * go through {@link transact}.
   */
  readonly projection: Pick<
    Projection,
    "expenseRowsAt" | "householdMonthlyIncomeCents" | "accountDescriptors"
  >;
}

export function BaseAdjustmentsPanel({
  plan,
  transact,
  series,
  personNames,
  household,
  ledger,
  projection,
}: BaseAdjustmentsPanelProps) {
  const lines = plan.budgetLines;
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

  // Contribution lines are a flat literal into an account, so they have no month-resolved
  // amount to preview — only expense rows do, and those come off the facade.
  const contributionLines = useMemo(() => contributionLinesOf(lines), [lines]);
  // Resolved by the facade off the very series the simulator charges, so the month a user
  // scrubs to and the month the projection runs cannot show different numbers.
  const rows = useMemo(
    () => projection.expenseRowsAt(selectedMonth),
    [projection, selectedMonth],
  );
  // The selected month's flows, found once — the obligation list and its funding attribution both
  // read off it, so the editor, the graph and the "Funded by" view cannot disagree.
  const selectedFlows = useMemo(
    () => series.months.find((m) => m.month === selectedMonth)?.flows,
    [series, selectedMonth],
  );
  // The full obligation list, already priority-ordered by the engine — the health, event and debt
  // costs the month incurs beside the user's own lines.
  const obligations = selectedFlows?.obligations ?? EMPTY_OBLIGATIONS;
  // Per-obligation funding attribution: which sources covered each line, in cascade order. Includes
  // explicit draws (a home down payment) that never appear in `obligations`, so it reads its own seam.
  const resolvedFunding = selectedFlows?.resolvedFunding ?? EMPTY_FUNDING;
  // Account id → authored label, so an account-funded source in "Funded by" reads as its name
  // rather than its internal id — the same descriptors the net-worth breakdown chart labels by.
  const accountLabels = useMemo(
    () => new Map(projection.accountDescriptors().map((a) => [a.id, a.label])),
    [projection],
  );

  // Structural add/edit/delete, distinct from the inline amount override above. One form
  // disclosed at a time, like the Jobs and Goals panels.
  const [lineAuthoring, setLineAuthoring] = useState<LineAuthoring | null>(null);

  function addLine(draft: BudgetLineDraft): void {
    transact((p) => p.addBudgetLine(budgetLineInputFromDraft(draft)));
    setLineAuthoring(null);
  }
  function editLine(id: string, draft: BudgetLineDraft): void {
    transact((p) => p.updateBudgetLine(id, budgetLinePatchFromDraft(draft)));
    setLineAuthoring(null);
  }
  /** Expense rows and the contributions list share one slot, so the toggle is arbitrated here. */
  function toggleLineForm(id: string): void {
    setLineAuthoring((a) => (a?.kind === "edit" && a.id === id ? null : { kind: "edit", id }));
  }
  function deleteLine(id: string): void {
    transact((p) => p.removeBudgetLine(id));
    if (lineAuthoring?.kind === "edit" && lineAuthoring.id === id) setLineAuthoring(null);
  }

  /** Display only: the total across every job, so no row has to pick *the* income. Month 0 is
   * a processed month now, so its own flows read here — no opening-snapshot clamp. */
  const incomeAtMonth = incomeByMonth[selectedMonth] ?? 0;

  // Every earner's jobs, not just the primary person's; the picker names whose is whose.
  const owners = useMemo(() => jobOwnersOf(household, ledger), [household, ledger]);
  const jobOptions = useMemo(
    () => ownedJobsOf(owners).map(({ job, label }) => ({ id: job.id, label })),
    [owners],
  );
  /**
   * Everything already authored at the selected month, read back off the jobs. The editor used
   * to remember the last thing it applied instead, which showed one change where two were
   * stored and outlived changes removed elsewhere.
   *
   * Every adjustment separately, keyed by its own id: a month may hold any number of one-off
   * adjustments on one job, and each is a fact the user authored and can remove on its own.
   * Nothing here merges or collapses them — the order is the engine's `orderedIncomeOverrides`
   * order, which is also the order they apply in.
   */
  const appliedAtMonth = useMemo(
    () =>
      ownedJobsOf(owners).flatMap(({ job, label }) => [
        ...(job.payChanges ?? [])
          .filter((c) => c.month === selectedMonth)
          .map((c) => ({
            id: c.id,
            jobId: job.id,
            jobLabel: label,
            scope: "ongoing" as const,
            description:
              c.kind === "setTo"
                ? `pay set to ${formatDollars(c.cents)}`
                : `pay changed by ${formatDollars(c.cents)}`,
          })),
        ...orderedIncomeOverrides(job.incomeOverrides ?? [])
          .filter((o) => o.month === selectedMonth)
          .map((o) => ({
            id: o.id,
            jobId: job.id,
            jobLabel: label,
            scope: "thisMonth" as const,
            description:
              o.kind === "addBonus"
                ? `bonus of ${formatDollars(o.cents)}`
                : `pay set to ${formatDollars(o.cents)}`,
          })),
      ]),
    [owners, selectedMonth],
  );


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
      transact((p) => p.addBudgetLineOverride(route.lineId, route.override));
    }
    setPending(null);
  }

  /** Where the quickstart's savings line stops. */
  const retirementMonth = Math.max(0, (plan.retirementAge - plan.currentAge) * 12);

  const applyQuickstart = useCallback((): void => {
    // Non-destructive: rebalance existing lines to 50/30/20, keeping their names. Off the
    // whole household's standing pay — one earner's jobs would size a two-earner
    // household's spending to half its income.
    const monthlyIncomeCents = projection.householdMonthlyIncomeCents();
    // One transaction: the whole rebalance lands together or not at all.
    const { rescale, seeds } = tierRebalanceWrites(lines, monthlyIncomeCents, retirementMonth);
    transact((p) => {
      for (const { id, monthlyCents } of rescale) {
        p.updateBudgetLine(id, { amountSource: { kind: "literal", monthlyCents } });
      }
      for (const seed of seeds) p.addBudgetLine(seed);
    });
    setPending(null);
  }, [lines, projection, retirementMonth, transact]);

  // `length - 1`: every row is a processed month now (the opening snapshot left the array), so
  // the last selectable month is the last INDEX, not the count. Clamping to the count would
  // point the editor one month past the horizon, at no row at all.
  const lastMonth = Math.max(0, spendingChartData.rows.length - 1);

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
            onChange={(m) => selectMonth(Math.max(0, Math.min(lastMonth, Math.round(m))))}
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
          incomeMonth={selectedMonth}
          appliedAtMonth={appliedAtMonth}
          // Addressed by job id alone: the facade finds it on whichever plane its owner is
          // authored on, and carries the job's other adjustments through.
          onApplyOverride={(jobId, override) => transact((p) => p.addJobIncomeOverride(jobId, override))}
          onApplyPayChange={(jobId, payChange) => transact((p) => p.addJobPayChange(jobId, payChange))}
        />

        <SpendingEditor
          obligations={obligations}
          rows={rows}
          lines={lines}
          selectedMonth={selectedMonth}
          pending={pending}
          lastRoute={lastRoute}
          authoring={lineAuthoring}
          edit={editActions}
          form={lineFormActions}
        />

        {/* What actually covered each obligation this month — savings, liquidation or credit —
            surfaced so a month quietly running on credit is visible here, not only later in the
            net-worth line. Includes explicit draws (a home down payment) not in the list above. */}
        <FundingAttribution
          resolvedFunding={resolvedFunding}
          obligations={obligations}
          accountLabels={accountLabels}
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
