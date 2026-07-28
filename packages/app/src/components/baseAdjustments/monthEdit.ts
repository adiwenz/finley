/**
 * Direct-manipulation budget editing. The gesture is `(row, month, new amount, scope)`
 * — pick a month on the chart, see what each row resolves to there, type a number,
 * answer "just this month" or "from here forward". No `Adjustment` entity; this module
 * is the total function from gesture to the primitive the write lands on:
 *
 * |            | just this month                  | from here forward             |
 * |------------|----------------------------------|-------------------------------|
 * | spend line | `thisMonthOnly` line override    | `fromHereForward` line override |
 * | income     | **ledger transaction** (the delta) | job/stream income override    |
 *
 * A one-month income change is a discrete cash event (bonus, missed paycheck), so it
 * routes to the ledger as a DELTA against what the month already resolved to, not an
 * override implying a standing change. A permanent income change is a raise and rides
 * the job/stream — income is never a budget line.
 *
 * Pure and jurisdiction-agnostic: the app resolves the "before" amounts, calls
 * {@link routeMonthEdit}, and applies exactly one primitive.
 */

import {
  compileExpenseBudgetLines,
  type BudgetLine,
  type BudgetLineOverride,
} from "@finley/engine";

/** Owner tag for the editor's throwaway compilation; expense owners are inert today. */
const EDITOR_OWNER = "editor";

/**
 * The price growth the editor shows rows in. Routing needs no conversion (an override
 * stores the typed figure as that month's dollars), so only {@link resolveRowsAtMonth}
 * reads this.
 */
export interface MonthEditContext {
  /** Annual price growth, e.g. `0.03` — the plan's CPI. */
  readonly annualInflationRate: number;
}

/**
 * "How long does this change last?" — the only question the gesture asks. These are the
 * engine's own {@link BudgetLineOverride} scopes, so a spend edit routes untranslated.
 */
export type EditScope = "thisMonthOnly" | "fromHereForward";

/** Which row of the month editor was edited: a standing spend line, or income. */
export type EditRow =
  | { readonly kind: "line"; readonly lineId: string }
  | { readonly kind: "income" };

/** One direct edit, as the UI collects it before routing. */
export interface MonthEdit {
  readonly row: EditRow;
  /** The month being edited (0 = "now") — the point clicked on the chart. */
  readonly month: number;
  /** What the row resolved to at `month` before the edit — the delta's baseline. */
  readonly priorAmountCents: number;
  /** The amount the user typed. */
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
 * Route a direct edit to its primitive. Total over the two axes — every (row, scope)
 * pair has exactly one home, so the UI never asks what kind of thing is being created.
 * No inflation context needed: the typed figure is stored as that month's dollars and
 * the engine grows it from there.
 */
export function routeMonthEdit(edit: MonthEdit): MonthEditRoute {
  if (edit.row.kind === "line") {
    // Both spend scopes store the typed figure verbatim, in that month's dollars.
    // `compileBudget` resets the growth clock to the override's month, so X is charged
    // there and grows from there — nothing to keep in sync with engine compounding.
    return {
      kind: "lineOverride",
      lineId: edit.row.lineId,
      override: { month: edit.month, monthlyCents: edit.newAmountCents, scope: edit.scope },
    };
  }

  if (edit.scope === "thisMonthOnly") {
    // A discrete cash event: a ledger transaction for the *difference*, leaving the
    // standing income alone.
    return {
      kind: "ledgerTransaction",
      month: edit.month,
      amountCents: edit.newAmountCents - edit.priorAmountCents,
    };
  }

  // A raise: rides the job/stream, not a budget line. Stored like a spend override —
  // that month's dollars, growing from there.
  return { kind: "incomeOverride", month: edit.month, monthlyCents: edit.newAmountCents };
}

/**
 * Grow an amount authored at `fromMonth` to `toMonth`. Display-only: income overrides
 * live in panel state and never reach the projection (they land on jobs later), so this
 * approximation need not agree with the engine to the cent.
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

/** One row of the month editor: what this line resolves to at the selected month. */
export interface ResolvedRow {
  readonly lineId: string;
  readonly label: string;
  readonly category: BudgetLine["category"];
  /**
   * The amount at the selected month in THAT month's dollars — the figure the
   * projection charges and the graph draws, inflation included.
   */
  readonly monthlyCents: number;
  /** True when a dated override — not the base amount — is what is showing here. */
  readonly overridden: boolean;
}

/**
 * Resolve every standing line to what it is **at `month`**: base amount, any dated
 * override layered on, and the price growth accrued by then — so scrubbing to year 30
 * shows year-30 dollars, matching the graph above.
 *
 * Reads amounts off the very series the simulator runs
 * ({@link compileExpenseBudgetLines}) instead of recomputing growth, so editor and
 * projection cannot drift apart.
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
 * Apply a routed line override to the standing lines — the one mutation the panel makes
 * to its own state. An override *replaces* any existing one of the same scope at the
 * same month, so repeated edits to a point don't stack up.
 *
 * **A `fromHereForward` override supersedes every later one on that line.**
 * `compileBudget` replays overrides in array order and `SimCashFlowSeries.addOverride`
 * drops segments at or after the month it lands on, so editing month 100 after month 300
 * holds the month-100 amount for the rest of the horizon. Intended: "from here forward"
 * means from here forward, and the more recent, earlier-in-time decision wins. The
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
