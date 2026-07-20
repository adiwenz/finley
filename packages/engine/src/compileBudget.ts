/**
 * Pure compilation from the standing line-item {@link BudgetLine} model into the
 * simulator's inputs (§12, §15, §18, §19 of JOBS_HOUSEHOLD_REDESIGN, issue #67,
 * slice 4). Expense lines compile to forward expense {@link SimOwnedSeries}
 * (spans → the series' start/end months, dated overrides → the series' own
 * override edits), so a line-item budget drives the *existing* waterfall /
 * simulator unchanged.
 *
 * This is the one module in the budget model that depends on the simulator
 * (`SimOwnedSeries`) and the jurisdiction seam; isolating it here keeps
 * {@link import("./budgetLine")}'s pure *types* free of any `projection/*` import,
 * mirroring the {@link import("./compilePerson")} seam. Everything here is pure:
 * the calendar "now" (`nowYear`) and CPI arrive from the caller, and the legislated
 * fill-to-limit cap arrives through the jurisdiction interface — never imported.
 *
 * Lands **additively**, alongside the scalar `Plan.expenseCents` path — both
 * compile into the same `initialExpenseSeries` — so nothing existing is removed
 * here (that is #72's job).
 */

import type { Cents } from "./money";
import { SimCashFlowSeries } from "./cashFlowSeries";
import type { SimOwnedSeries } from "./projection/simulate";
import type { Jurisdiction, DeferralLimitContext } from "./jurisdiction";
import type { BudgetLine } from "./budgetLine";

/**
 * The fill-to-limit cap seam for a jurisdiction (§12, §19): the function a
 * `fill-to-limit` line reads its legislated annual cap from — the jurisdiction's
 * {@link Jurisdiction.retirementDeferralLimitCents} plug (which #33 supplies for
 * capped accounts, age-50 catch-up included). Returns `undefined` when the
 * jurisdiction defines no cap (v1 null jurisdiction), so a `fill-to-limit` line
 * resolves to 0 rather than inventing a cap. Injected, never imported — this is
 * how the engine stays pure while consuming the rules-side caps.
 */
export function fillToLimitSeamFor(
  jurisdiction: Jurisdiction,
): ((ctx: DeferralLimitContext) => Cents) | undefined {
  return jurisdiction.retirementDeferralLimitCents?.bind(jurisdiction);
}

/**
 * Compile one expense {@link BudgetLine} into a forward expense
 * {@link SimCashFlowSeries}. A literal source is the monthly baseline; the line's
 * span becomes the series' start month and (exclusive) end; each dated override
 * becomes a matching series edit (§19). Only literal expense sources are
 * compilable — a `fill-to-limit` / `goal-paced` *expense* is meaningless (those
 * are contribution behaviours), so it is refused at compile time.
 */
function compileExpenseLine(line: BudgetLine, ownerId: string): SimOwnedSeries {
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

  const series = new SimCashFlowSeries(
    startMonth,
    monthlyCents,
    { type: "fixed" },
    { baselineUnit: "monthly", ...(endMonth !== undefined ? { endMonth } : {}) },
  );
  for (const o of line.overrides ?? []) {
    series.addOverride(o.month, o.monthlyCents, o.scope);
  }
  return { series, ownerId };
}

/**
 * Compile a budget's expense lines into forward expense {@link SimOwnedSeries}
 * (§12, §15) — one series per expense line, owned by `ownerId`. Contribution
 * lines (targets other than `expense`) are skipped here: they route to the
 * contribution channels, not the expense series. Order is preserved so the
 * caller can keep it aligned with the prioritized budget.
 */
export function compileExpenseBudgetLines(
  lines: readonly BudgetLine[],
  ownerId: string,
): SimOwnedSeries[] {
  const series: SimOwnedSeries[] = [];
  for (const line of lines) {
    if (line.target.kind === "expense") series.push(compileExpenseLine(line, ownerId));
  }
  return series;
}
