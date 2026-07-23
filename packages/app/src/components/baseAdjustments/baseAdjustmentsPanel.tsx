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
 * it. Income is still the scalar lever until the #72 hinge moves it onto jobs.
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
import { quickstartFromIncome, toBudgetLines } from "./budgetTemplate";
import { applyIncomeRaise, monthlyIncomeCents } from "../../planPeople";
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
  /**
   * Post a one-off income cash event to the ledger (§18/§20): a `thisMonthOnly` income
   * edit is a discrete bonus/missed-paycheck, so it routes to a real ledger transaction
   * for the delta rather than a standing change. Supplied by the app, which owns the
   * ledger; absent in isolated renders, where the panel still reports the route.
   */
  readonly onIncomeTransaction?: (month: number, deltaCents: number) => void;
}

export function BaseAdjustmentsPanel({
  plan,
  setBudget,
  onIncomeTransaction,
}: BaseAdjustmentsPanelProps) {
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
  const rows = useMemo(
    () => resolveRowsAtMonth(lines, selectedMonth, editCtx.annualInflationRate),
    [lines, selectedMonth, editCtx],
  );

  /**
   * Income at the selected month, read straight off the projection. Because income now
   * rides the person's {@link import("@finley/engine").Job}s (§6), a `fromHereForward`
   * raise is a real edit to `plan.jobs` — so the row, the income graph, and net worth
   * all move together for it, no local override state required. The row also reflects
   * the projection stopping income at retirement and picking the government benefit up
   * at the claiming age, rather than compounding a salary forever.
   */
  const incomeAtMonth = projected.incomeByMonth[selectedMonth] ?? 0;

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

  /** Answer the how-long question — the one gesture that commits a change (§20). */
  function commit(scope: EditScope): void {
    if (pending === null) return;
    const route = routeMonthEdit({ ...pending, month: selectedMonth, scope });
    setLastRoute({ route, label: pending.label });
    if (route.kind === "lineOverride") {
      setLines((prev) => [...applyLineOverride(prev, route.lineId, route.override)]);
    } else if (route.kind === "incomeOverride") {
      // A permanent income change is a raise: it rides the person's career job (§6),
      // so it moves the income graph and net worth, not just this row.
      setBudget((p) => applyIncomeRaise(p, route.month, route.monthlyCents));
    } else {
      // A one-month income change is a discrete cash event: post it to the ledger as a
      // real one-off transaction for the delta (§18) — no more echo without a write.
      onIncomeTransaction?.(route.month, route.amountCents);
    }
    setPending(null);
  }

  /** Month the household retires — where the savings line stops (see the quickstart). */
  const retirementMonth = Math.max(0, (plan.retirementAge - plan.currentAge) * 12);

  function applyQuickstart(): void {
    setLines(() => toBudgetLines(quickstartFromIncome(monthlyIncomeCents(plan), retirementMonth)));
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
          <NumInput
            label="Income"
            value={Math.round(displayedCents({ kind: "income" }, incomeAtMonth, pending) / 100)}
            onChange={(v) => stageEdit({ kind: "income" }, "Income", incomeAtMonth, v)}
            prefix="$"
            step={100}
          />
        </div>

        <h4 className={styles.groupHeading}>Spending</h4>
        {rows.map((row) => (
          <div key={row.lineId} className={styles.lineRow}>
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
      </div>
    </section>
  );
}
