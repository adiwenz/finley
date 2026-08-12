/**
 * The three graphs at the top of Base + Adjustments, sharing an x-axis, a selection marker
 * and the click-to-select gesture. Stateless: the selected month is the panel's, since the
 * editor below points at the same month.
 *
 * `memo`ized because the panel re-renders on every keystroke in a spending row while these
 * Recharts subtrees (660+ points on a default plan, one area per band) are the most expensive
 * thing it draws — so keep the data memoized upstream and both callbacks stable.
 */

import { memo } from "react";
import { IncomeChart } from "./incomeChart";
import { PerLineBudgetChart } from "./perLineBudgetChart";
import { TaxChart } from "./taxChart";
import type { IncomeChartData } from "./incomeChartData";
import type { PerLineBudgetData } from "./perLineBudget";
import type { TaxChartData } from "./taxesByMonth";
import styles from "./baseAdjustments.module.css";

export interface ProjectionChartsProps {
  readonly incomeData: IncomeChartData;
  readonly spendingData: PerLineBudgetData;
  readonly taxData: TaxChartData;
  /** The household's age at month 0 — turns the income graph's broke marker into an age. */
  readonly currentAge: number;
  /**
   * Household member names by person id — lets the income graph say *whose* government
   * benefit a band is. The label names the kind of income, so two claimants would otherwise
   * draw identical legend entries.
   */
  readonly personNames: ReadonlyMap<string, string>;
  readonly selectedMonth: number;
  readonly onSelectMonth: (month: number) => void;
}

export const ProjectionCharts = memo(function ProjectionCharts({
  incomeData,
  spendingData,
  taxData,
  currentAge,
  personNames,
  selectedMonth,
  onSelectMonth,
}: ProjectionChartsProps) {
  return (
    <div>
      <h3>Cash flow &amp; spending over time</h3>
      <p className="hint">Click either graph to edit at any point in time.</p>

      <h4 className={styles.groupHeading}>Monthly cash flows vs. spending</h4>
      <IncomeChart
        data={incomeData}
        currentAge={currentAge}
        selectedMonth={selectedMonth}
        personNames={personNames}
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
