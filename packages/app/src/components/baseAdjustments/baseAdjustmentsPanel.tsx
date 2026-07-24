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
 *   - **Graph** — the per-line monthly budget as authored, each line at what it really
 *     costs that month. Spending is never rationed away behind the user's back; if the
 *     plan stops being financeable the graph says so outright (AC2).
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
  Projection,
  dollarsToCents,
  budgetLineAllocationId,
  type BudgetLine,
  type Plan,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
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
  contributionTargets,
  expenseLinesOf,
  lineToDraft,
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
import { IncomeChart } from "./incomeChart";
import { buildPerLineBudgetData, type ChartLine } from "./perLineBudget";
import { PerLineBudgetChart } from "./perLineBudgetChart";
import { buildTaxChartData } from "./taxesByMonth";
import { TaxChart } from "./taxChart";
import styles from "./baseAdjustments.module.css";

/** "month 180 · 2041 · age 50" — the point on the budget, in the terms a user thinks in. */
function describeMonth(month: number, currentAge: number): string {
  const year = START_YEAR + Math.floor(month / 12);
  const age = currentAge + Math.floor(month / 12);
  return `month ${month} · ${year} · age ${age}`;
}

/**
 * A short, human summary of where an edit landed — surfaced so the routing is visible.
 * Named with the row's own `label`: the route carries the line's authoring `id`, which
 * is an internal key ("dining") and not what the row directly above this echo says
 * ("Dining & fun").
 */
function describeRoute(route: MonthEditRoute, label: string): string {
  switch (route.kind) {
    case "lineOverride":
      return route.override.scope === "thisMonthOnly"
        ? `→ one-month override on "${label}" at month ${route.override.month} (${formatDollars(route.override.monthlyCents)})`
        : `→ dated override on "${label}" from month ${route.override.month} forward (${formatDollars(route.override.monthlyCents)})`;
    case "ledgerTransaction":
      return `→ one-time ledger transaction at month ${route.month} (${formatDollars(route.amountCents)})`;
    case "incomeOverride":
      return `→ job/stream income override from month ${route.month} forward (${formatDollars(route.monthlyCents)})`;
  }
}

/** The row the user has typed a new number into, awaiting the how-long question. */
interface PendingEdit {
  readonly row: EditRow;
  readonly label: string;
  readonly priorAmountCents: number;
  readonly newAmountCents: number;
}

const isSameRow = (a: EditRow, b: EditRow): boolean =>
  a.kind === "income" ? b.kind === "income" : b.kind === "line" && a.lineId === b.lineId;

/**
 * What a row's input shows. A staged (typed but not yet committed) edit is the truth
 * for its own row — the committed budget only catches up once the user answers the
 * how-long question, and a field that snapped back to the stored value on every
 * keystroke would be unusable.
 */
function displayedCents(row: EditRow, resolvedCents: number, pending: PendingEdit | null): number {
  return pending !== null && isSameRow(pending.row, row) ? pending.newAmountCents : resolvedCents;
}

export interface BaseAdjustmentsPanelProps {
  readonly plan: Plan;
  readonly setBudget: Dispatch<SetStateAction<Plan>>;
}

export function BaseAdjustmentsPanel({ plan, setBudget }: BaseAdjustmentsPanelProps) {
  // The budget is the plan's, not the panel's — editing here moves the whole app.
  const lines = useMemo(() => plan.budgetLines ?? [], [plan.budgetLines]);
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

  // Project the plan (whose budgetLines these are) once: the chart reads the per-line
  // amounts off it, and the income row reads the income it actually pays each month.
  const projected = useMemo(() => {
    const result = Projection.create({ plan, startYear: START_YEAR }).run(usJurisdiction);
    const chartLines: ChartLine[] = lines.map((l) => ({
      id: budgetLineAllocationId(l.id),
      label: l.label,
    }));
    return {
      chartData: buildPerLineBudgetData(result.series, chartLines),
      incomeData: buildIncomeChartData(result.series),
      taxData: buildTaxChartData(result.series),
      /** Gross income the projection pays in each month, indexed by month. */
      incomeByMonth: result.series.months.map((m) => m.flows?.totalIncomeCents ?? 0),
    };
  }, [plan, lines]);
  const chartData = projected.chartData;

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
  const [lineAuthoring, setLineAuthoring] = useState<
    { kind: "edit"; id: string } | { kind: "new" } | null
  >(null);

  function addLine(draft: BudgetLineDraft): void {
    setLines((prev) => addLineFromDraft(prev, draft));
    setLineAuthoring(null);
  }
  function editLine(id: string, draft: BudgetLineDraft): void {
    setLines((prev) => updateLineFromDraft(prev, id, draft));
    setLineAuthoring(null);
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
  const incomeAtMonth = projected.incomeByMonth[incomeMonth] ?? 0;

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

  const horizonMonths = chartData.rows.length;

  // No `card` class here: `main.tsx` supplies the card wrapper for every panel, as it
  // does for Goals, Retirement, and Debug. Carrying one internally too drew a box in a box.
  return (
    <section>
      <h2>Base + Adjustments</h2>

      {/* ── Graph: click a point to move the editor there (AC2 + the edit gesture) ── */}
      <div>
        <div className="row-between">
          <h3>Income &amp; spending over time</h3>
          <button className="btn" onClick={applyQuickstart} type="button">
            Quickstart from income (50/30/20)
          </button>
        </div>
        <p className="hint">Click either graph to edit at any point in time.</p>

        <h4 className={styles.groupHeading}>Monthly income by source</h4>
        <IncomeChart
          data={projected.incomeData}
          selectedMonth={selectedMonth}
          onSelectMonth={selectMonth}
        />

        <h4 className={styles.groupHeading}>Monthly spending by line</h4>
        <PerLineBudgetChart
          data={chartData}
          selectedMonth={selectedMonth}
          onSelectMonth={selectMonth}
        />

        <h4 className={styles.groupHeading}>Monthly tax paid</h4>
        <TaxChart
          data={projected.taxData}
          selectedMonth={selectedMonth}
          onSelectMonth={selectMonth}
        />
      </div>

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

        <h4 className={styles.groupHeading}>Spending</h4>
        {rows.map((row) => (
          <div key={row.lineId}>
            <div className={styles.lineRow}>
              <span className={styles.lineLabel}>
                {row.label} <span className={styles.tier}>{row.category}</span>
                {row.overridden && (
                  <span className={styles.adjusted} title="Adjusted at or before this month">
                    adjusted
                  </span>
                )}
              </span>
              <NumInput
                label={row.label}
                value={Math.round(
                  displayedCents({ kind: "line", lineId: row.lineId }, row.monthlyCents, pending) /
                    100,
                )}
                onChange={(v) =>
                  stageEdit({ kind: "line", lineId: row.lineId }, row.label, row.monthlyCents, v)
                }
                prefix="$"
                step={50}
              />
              <span className={styles.rowActions}>
                <button
                  type="button"
                  aria-label={`Edit ${row.label}`}
                  onClick={() =>
                    setLineAuthoring((a) =>
                      a?.kind === "edit" && a.id === row.lineId ? null : { kind: "edit", id: row.lineId },
                    )
                  }
                >
                  Edit
                </button>
                <button type="button" aria-label={`Delete ${row.label}`} onClick={() => deleteLine(row.lineId)}>
                  Delete
                </button>
              </span>
            </div>
            {lineAuthoring?.kind === "edit" && lineAuthoring.id === row.lineId && (
              <BudgetLineForm
                initial={lineToDraft(lines.find((l) => l.id === row.lineId)!)}
                submitLabel="Save"
                onSubmit={(draft) => editLine(row.lineId, draft)}
                onCancel={() => setLineAuthoring(null)}
              />
            )}
          </div>
        ))}

        {/* ── The one question an edit asks: how long does this last? (§20) ── */}
        {pending !== null && (
          <div className={styles.scopePrompt} data-testid="scope-prompt" role="group"
            aria-label="How long should this change last?">
            <p className={styles.scopeQuestion}>
              {pending.label} {formatDollars(pending.priorAmountCents)} →{" "}
              {formatDollars(pending.newAmountCents)} at month {selectedMonth}. How long?
            </p>
            <button className="btn" onClick={() => commit("thisMonthOnly")} type="button">
              Just this month
            </button>
            <button className="btn primary" onClick={() => commit("fromHereForward")} type="button">
              From here forward
            </button>
            <button className="btn ghost" onClick={() => setPending(null)} type="button">
              Cancel
            </button>
          </div>
        )}

        {lastRoute && (
          <p className={styles.routeEcho} data-testid="adjustment-route">
            {describeRoute(lastRoute.route, lastRoute.label)}
          </p>
        )}

        {/* ── Savings & contributions: money paid into an account each month (§12).
            Unlike spending, these accumulate in net worth — funded by the sim. ── */}
        <h4 className={styles.groupHeading}>Savings &amp; contributions</h4>
        {contributionLines.length === 0 ? (
          <p className="hint">
            No recurring contributions yet. Add one to pay into a brokerage or savings
            account each month — it accumulates in your net worth.
          </p>
        ) : (
          contributionLines.map((line) => {
            const monthly = line.amountSource.kind === "literal" ? line.amountSource.monthlyCents : 0;
            const accountId = line.target.kind === "account" ? line.target.accountId : "";
            const dest = contributionTargets.find((t) => t.accountId === accountId)?.label ?? accountId;
            return (
              <div key={line.id}>
                <div className={styles.lineRow}>
                  <span className={styles.lineLabel}>
                    {line.label} <span className={styles.target}>→ {dest}</span>
                  </span>
                  <span className={styles.readonlyValue}>{formatDollars(monthly)}/mo</span>
                  <span className={styles.rowActions}>
                    <button
                      type="button"
                      aria-label={`Edit ${line.label}`}
                      onClick={() =>
                        setLineAuthoring((a) =>
                          a?.kind === "edit" && a.id === line.id ? null : { kind: "edit", id: line.id },
                        )
                      }
                    >
                      Edit
                    </button>
                    <button type="button" aria-label={`Delete ${line.label}`} onClick={() => deleteLine(line.id)}>
                      Delete
                    </button>
                  </span>
                </div>
                {lineAuthoring?.kind === "edit" && lineAuthoring.id === line.id && (
                  <BudgetLineForm
                    initial={lineToDraft(line)}
                    submitLabel="Save"
                    onSubmit={(draft) => editLine(line.id, draft)}
                    onCancel={() => setLineAuthoring(null)}
                  />
                )}
              </div>
            );
          })
        )}

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
