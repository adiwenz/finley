/**
 * Pure compilation from the standing line-item {@link BudgetLine} model into simulator inputs:
 * expense lines become forward expense {@link SimOwnedSeries} (spans → the series' start/end
 * months, dated overrides → its override edits), driving the *existing* waterfall unchanged.
 *
 * The one budget-model module depending on the simulator (`SimOwnedSeries`) and the
 * jurisdiction seam; isolating it keeps {@link import("./budgetLine")}'s pure types free of
 * any `projection/*` import. Inflation arrives from the caller, the legislated fill-to-limit
 * cap through the jurisdiction interface — never imported.
 *
 * The sole source of the household's general-expense series in `initialExpenseSeries`.
 */

import type { Cents } from "./money";
import { SimCashFlowSeries } from "./cashFlowSeries";
import type { SimOwnedSeries } from "./projection/simulate";
import type { Jurisdiction, DeferralLimitContext } from "./jurisdiction";
import { budgetLinePriority, type BudgetLine } from "./budgetLine";

/**
 * Where a `fill-to-limit` line reads its legislated annual cap: the jurisdiction's {@link
 * Jurisdiction.retirementDeferralLimitCents} plug (age-banded catch-up included). `undefined`
 * when the jurisdiction defines no cap, so the line resolves to 0 rather than inventing one.
 */
export function fillToLimitSeamFor(
  jurisdiction: Jurisdiction,
): ((ctx: DeferralLimitContext) => Cents) | undefined {
  return jurisdiction.retirementDeferralLimitCents?.bind(jurisdiction);
}

function compileExpenseLine(
  line: BudgetLine,
  ownerId: string,
  annualInflationRate: number,
): SimOwnedSeries {
  if (line.amountSource.kind !== "literal") {
    throw new Error(
      `Expense budget line "${line.id}" uses a ${line.amountSource.kind} amount source; ` +
        `expenses must be literal (fill-to-limit / goal-paced are contribution behaviours).`,
    );
  }
  const startMonth = line.span?.startMonth ?? 0;
  // Span end is exclusive; the series' endMonth is inclusive, hence −1. Absent → open.
  const endMonth = line.span?.endMonth !== undefined ? line.span.endMonth - 1 : undefined;
  const monthlyCents: Cents = line.amountSource.monthlyCents;

  // A budget line is authored in TODAY's dollars and rises with prices. Compiling it `fixed`
  // would model spending that never rises, understating lifetime cost enough over decades to
  // move the retirement age by years.
  const series = new SimCashFlowSeries(
    startMonth,
    monthlyCents,
    { type: "inflationLinked", annualRate: annualInflationRate },
    { baselineUnit: "monthly", ...(endMonth !== undefined ? { endMonth } : {}) },
  );
  for (const o of line.overrides ?? []) {
    // Reset the growth clock to the override's own month: X is that month's dollars.
    // Inheriting the prior segment's anchor would read X as today's dollars and inflate it
    // forward — a $2,500 edit fifteen years out would charge $3,895 on landing.
    series.addOverride(o.month, o.monthlyCents, o.scope, { resetAnchor: true });
  }
  // Carry the source line's label, id and priority so the simulator reports and *ranks* each
  // line without re-resolving (see ProjectionMonthFlows.lineMonthlyCents). Priority now rides
  // through: the obligation waterfall ranks lines by it, so a line's authored/category order —
  // `budgetLinePriority`, the same ordering source of truth the authoring view reads — must
  // survive compilation rather than being recomputed downstream from the category alone, which
  // would silently drop any explicit per-line override.
  return {
    series,
    ownerId,
    label: line.label,
    lineId: line.id,
    // The only spending stream a user edits directly; the unified spending report reads it.
    spendingSource: {
      kind: "budgetLine",
      id: line.id,
      category: line.category,
      editable: true,
      priority: budgetLinePriority(line),
    },
  };
}

/**
 * One forward expense {@link SimOwnedSeries} per expense line, owned by `ownerId`.
 * Contribution lines (targets other than `expense`) are skipped — they route to the
 * contribution channels. Order is preserved, aligned with the prioritized budget.
 */
export function compileExpenseBudgetLines(
  lines: readonly BudgetLine[],
  ownerId: string,
  annualInflationRate: number,
): SimOwnedSeries[] {
  const series: SimOwnedSeries[] = [];
  for (const line of lines) {
    if (line.target.kind === "expense") {
      series.push(compileExpenseLine(line, ownerId, annualInflationRate));
    }
  }
  return series;
}
