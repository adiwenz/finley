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

import type { BudgetLineOverride } from "@finley/engine";

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

