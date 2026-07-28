/**
 * Direct-manipulation budget editing. No `Adjustment` entity: this module is the pure total
 * function from a `(row, month, new amount, scope)` gesture to the one primitive the write
 * lands on.
 *
 * |            | just this month                  | from here forward             |
 * |------------|----------------------------------|-------------------------------|
 * | spend line | `thisMonthOnly` line override    | `fromHereForward` line override |
 * | income     | **ledger transaction** (the delta) | job/stream income override    |
 *
 * A one-month income change is a discrete cash event (bonus, missed paycheck), so it lands as
 * a DELTA against what the month already resolved to, not an override implying a standing
 * change. Income is never a budget line.
 */

import {
  compileExpenseBudgetLines,
  type BudgetLine,
  type BudgetLineOverride,
} from "@finley/engine";

/** Owner tag for the editor's throwaway compilation; expense owners are inert today. */
const EDITOR_OWNER = "editor";

/**
 * The price growth the editor shows rows in. Routing needs no conversion, so only
 * {@link resolveRowsAtMonth} reads this.
 */
export interface MonthEditContext {
  /** Annual price growth, e.g. `0.03` — the plan's CPI. */
  readonly annualInflationRate: number;
}

/** The engine's own {@link BudgetLineOverride} scopes, so a spend edit routes untranslated. */
export type EditScope = "thisMonthOnly" | "fromHereForward";

export type EditRow =
  | { readonly kind: "line"; readonly lineId: string }
  | { readonly kind: "income" };

export interface MonthEdit {
  readonly row: EditRow;
  /** The month being edited, 0 = "now". */
  readonly month: number;
  /** What the row resolved to at `month` before the edit — the delta's baseline. */
  readonly priorAmountCents: number;
  readonly newAmountCents: number;
  readonly scope: EditScope;
}

/** The primitive an edit lands on — exactly one, never a fourth "adjustment" record. */
export type MonthEditRoute =
  | {
      readonly kind: "lineOverride";
      readonly lineId: string;
      readonly override: BudgetLineOverride;
    }
  | {
      readonly kind: "ledgerTransaction";
      readonly month: number;
      /** Signed delta against the month's prior income — positive is cash in. */
      readonly amountCents: number;
    }
  | {
      readonly kind: "incomeOverride";
      readonly month: number;
      readonly monthlyCents: number;
    };

/**
 * Total over the two axes — every (row, scope) pair has exactly one home, so the UI never
 * asks what kind of thing is being created. No inflation context needed: the typed figure
 * is stored as that month's dollars and the engine grows it from there.
 */
export function routeMonthEdit(edit: MonthEdit): MonthEditRoute {
  if (edit.row.kind === "line") {
    // `compileBudget` resets the growth clock to the override's month, so the typed figure
    // is charged there and grows from there.
    return {
      kind: "lineOverride",
      lineId: edit.row.lineId,
      override: { month: edit.month, monthlyCents: edit.newAmountCents, scope: edit.scope },
    };
  }

  if (edit.scope === "thisMonthOnly") {
    return {
      kind: "ledgerTransaction",
      month: edit.month,
      amountCents: edit.newAmountCents - edit.priorAmountCents,
    };
  }

  return { kind: "incomeOverride", month: edit.month, monthlyCents: edit.newAmountCents };
}

/**
 * Grow an amount authored at `fromMonth` to `toMonth`. Display-only: income overrides live
 * in panel state and never reach the projection, so this approximation need not agree with
 * the engine to the cent.
 */
export function inflateFromTo(
  cents: number,
  fromMonth: number,
  toMonth: number,
  ctx: MonthEditContext,
): number {
  const years = Math.max(0, toMonth - fromMonth) / 12;
  return Math.round(cents * Math.pow(1 + ctx.annualInflationRate, years));
}

export interface ResolvedRow {
  readonly lineId: string;
  readonly label: string;
  readonly category: BudgetLine["category"];
  /** In the selected month's dollars — the figure the projection charges and the graph draws. */
  readonly monthlyCents: number;
  /** True when a dated override — not the base amount — is what is showing here. */
  readonly overridden: boolean;
}

/**
 * Resolve every standing line to what it is **at `month`**: base amount, any dated override
 * layered on, and the price growth accrued by then — so scrubbing to year 30 shows year-30
 * dollars, matching the graph above. Reads amounts off the very series the simulator runs
 * instead of recomputing growth, so editor and projection cannot drift apart.
 */
export function resolveRowsAtMonth(
  lines: readonly BudgetLine[],
  month: number,
  annualInflationRate: number,
): readonly ResolvedRow[] {
  const compiled = new Map(
    compileExpenseBudgetLines(lines, EDITOR_OWNER, annualInflationRate).map((s) => [
      s.lineId,
      s.series,
    ]),
  );
  return lines.map((line) => {
    const overridden = (line.overrides ?? []).some(
      (o) =>
        (o.scope === "thisMonthOnly" && o.month === month) ||
        (o.scope === "fromHereForward" && o.month <= month),
    );
    return {
      lineId: line.id,
      label: line.label,
      category: line.category,
      monthlyCents: compiled.get(line.id)?.getMonthlyCents(month) ?? 0,
      overridden,
    };
  });
}

/**
 * Apply a routed line override to the standing lines. An override *replaces* any existing
 * one of the same scope at the same month, so repeated edits to a point don't stack up.
 *
 * **A `fromHereForward` override supersedes every later one on that line.** `compileBudget`
 * replays overrides in array order and `SimCashFlowSeries.addOverride` drops segments at or
 * after the month it lands on, so editing month 100 after month 300 holds the month-100
 * amount for the rest of the horizon — intended, the more recent decision wins. The
 * superseded entry stays in the array but resolves nowhere, so it cannot resurrect.
 */
export function applyLineOverride(
  lines: readonly BudgetLine[],
  lineId: string,
  override: BudgetLineOverride,
): readonly BudgetLine[] {
  return lines.map((line) => {
    if (line.id !== lineId) return line;
    const kept = (line.overrides ?? []).filter(
      (o) => !(o.scope === override.scope && o.month === override.month),
    );
    return { ...line, overrides: [...kept, override] };
  });
}
