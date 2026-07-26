/**
 * The graphs at the top of Base + Adjustments: cash flows vs. spending, spending by line,
 * and tax paid — three views of one projected scenario, sharing an x-axis, a selection
 * marker, and the click-to-select gesture.
 *
 * Split out of {@link import("./baseAdjustmentsPanel").BaseAdjustmentsPanel} so the
 * panel reads as what it is (state + plan mutation) and the graphs as what they are
 * (presentation). It owns no state: the selected month is the panel's, because the
 * editor below is pointed at the same month — that shared cursor is the whole gesture.
 *
 * `memo`ized, and worth it: three Recharts subtrees over the whole horizon (660+ points
 * on a default plan, one area per band) are by far the most expensive thing this panel
 * draws, and the panel re-renders on every keystroke in a spending row. Nothing here
 * depends on that staging state, so with the projected data memoized upstream and the
 * two callbacks stable, typing now skips the graphs entirely.
 */

import { memo } from "react";
import { IncomeChart } from "./incomeChart";
import { PerLineBudgetChart } from "./perLineBudgetChart";
import { TaxChart } from "./taxChart";
import type { IncomeChartData } from "./incomeByCategory";
import type { PerLineBudgetData } from "./perLineBudget";
import type { TaxChartData } from "./taxesByMonth";
import styles from "./baseAdjustments.module.css";

export interface ProjectionChartsProps {
  readonly incomeData: IncomeChartData;
  readonly spendingData: PerLineBudgetData;
  readonly taxData: TaxChartData;
  /** The household's age at month 0 — turns the income graph's broke marker into an age. */
  readonly currentAge: number;
  readonly selectedMonth: number;
  readonly onSelectMonth: (month: number) => void;
  /** The %-quickstart (§15): rebalance the existing budget to 50/30/20 of income. */
  readonly onQuickstart: () => void;
}

export const ProjectionCharts = memo(function ProjectionCharts({
  incomeData,
  spendingData,
  taxData,
  currentAge,
  selectedMonth,
  onSelectMonth,
  onQuickstart,
}: ProjectionChartsProps) {
  return (
    <div>
      <div className="row-between">
        <h3>Cash flow &amp; spending over time</h3>
        <button className="btn" onClick={onQuickstart} type="button">
          Quickstart from income (50/30/20)
        </button>
      </div>
      <p className="hint">Click either graph to edit at any point in time.</p>

      <h4 className={styles.groupHeading}>Monthly cash flows vs. spending</h4>
      <IncomeChart
        data={incomeData}
        currentAge={currentAge}
        selectedMonth={selectedMonth}
        onSelectMonth={onSelectMonth}
      />

      <h4 className={styles.groupHeading}>Monthly spending by line</h4>
      <PerLineBudgetChart
        data={spendingData}
        selectedMonth={selectedMonth}
        onSelectMonth={onSelectMonth}
      />

      <h4 className={styles.groupHeading}>Monthly tax paid</h4>
      <TaxChart data={taxData} selectedMonth={selectedMonth} onSelectMonth={onSelectMonth} />
    </div>
  );
});
