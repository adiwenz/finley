/**
 * Pure compilation from the standing line-item {@link BudgetLine} model into simulator
 * inputs. Expense lines compile to forward expense {@link SimOwnedSeries} (spans → the
 * series' start/end months, dated overrides → its override edits), so a line-item budget
 * drives the *existing* waterfall/simulator unchanged.
 *
 * The one budget-model module depending on the simulator (`SimOwnedSeries`) and the
 * jurisdiction seam; isolating it keeps {@link import("./budgetLine")}'s pure types free
 * of any `projection/*` import, mirroring the {@link import("./compilePerson")} seam.
 * Pure: `nowYear` and CPI arrive from the caller, the legislated fill-to-limit cap
 * through the jurisdiction interface — never imported.
 *
 * Additive alongside the scalar `Plan.expenseCents` path; both compile into the same
 * `initialExpenseSeries`.
 */

import type { Cents } from "./money";
import { SimCashFlowSeries } from "./cashFlowSeries";
import type { SimOwnedSeries } from "./projection/simulate";
import type { Jurisdiction, DeferralLimitContext } from "./jurisdiction";
import type { BudgetLine } from "./budgetLine";

/**
 * Where a `fill-to-limit` line reads its legislated annual cap: the jurisdiction's
 * {@link Jurisdiction.retirementDeferralLimitCents} plug (capped accounts, age-50
 * catch-up included). `undefined` when the jurisdiction defines no cap (v1 null
 * jurisdiction), so the line resolves to 0 rather than inventing one. Injected, never
 * imported — how the engine stays pure while consuming rules-side caps.
 */
export function fillToLimitSeamFor(
  jurisdiction: Jurisdiction,
): ((ctx: DeferralLimitContext) => Cents) | undefined {
  return jurisdiction.retirementDeferralLimitCents?.bind(jurisdiction);
}

/**
 * Compile one expense {@link BudgetLine} into a forward expense
 * {@link SimCashFlowSeries}: literal source → monthly baseline, span → start month and
 * exclusive end, each dated override → a series edit. Only literal expense sources
 * compile — a `fill-to-limit` / `goal-paced` *expense* is meaningless (both are
 * contribution behaviours), so it is refused at compile time.
 */
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

  // A budget line is authored in TODAY's dollars and rises with prices, like the scalar
  // `expenseCents` series it replaces. Compiling it `fixed` would model spending that
  // never rises — over decades that understates lifetime cost enough to move the
  // retirement age by years.
  const series = new SimCashFlowSeries(
    startMonth,
    monthlyCents,
    { type: "inflationLinked", annualRate: annualInflationRate },
    { baselineUnit: "monthly", ...(endMonth !== undefined ? { endMonth } : {}) },
  );
  for (const o of line.overrides ?? []) {
    // Reset the growth clock to the override's own month: X is that month's dollars.
    // Inheriting the prior segment's anchor would read X as today's dollars and inflate
    // it forward — a $2,500 edit fifteen years out would charge $3,895 on landing.
    series.addOverride(o.month, o.monthlyCents, o.scope, { resetAnchor: true });
  }
  // Carry the source line's label and id so the simulator reports each line's monthly
  // amount without re-resolving (see ProjectionMonthFlows.lineMonthlyCents). Priority is
  // deliberately NOT carried: nothing downstream ranks lines, since a tight month is
  // absorbed by savings and credit rather than by starving low-priority ones.
  // `budgetLinePriority` stays the ordering source of truth for the authoring view
  // (`allocations.ts`); re-add it here when something actually ranks.
  return {
    series,
    ownerId,
    label: line.label,
    lineId: line.id,
    // The only spending stream a user edits directly, and the only one carrying an
    // authored priority tier — both read off here by the unified spending report.
    spendingSource: {
      kind: "budgetLine",
      id: line.id,
      category: line.category,
      editable: true,
    },
  };
}

/**
 * One forward expense {@link SimOwnedSeries} per expense line, owned by `ownerId`.
 * Contribution lines (targets other than `expense`) are skipped — they route to the
 * contribution channels. Order is preserved so the caller can keep it aligned with the
 * prioritized budget.
 *
 * `annualInflationRate` (e.g. `0.03`) is the rate every line rises at, since a budget is
 * authored in today's dollars. Supplied by the caller — the engine never reads a rate it
 * wasn't handed.
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
