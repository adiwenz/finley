/**
 * Direct-manipulation budget editing (§18–§20, "UI: Base + Adjustments" of
 * JOBS_HOUSEHOLD_REDESIGN, issue #71).
 *
 * The user picks a **point on the budget** — a month on the chart — sees what every
 * row actually resolves to *at that month*, types a new number, and then answers one
 * question: **just this month**, or **from here forward**? There is no separate
 * "adjustment" form and (as §20 insists) still no `Adjustment` entity. The gesture is
 * `(row, month, new amount, scope)`; this module is the total function from that
 * gesture to the primitive the write actually lands on.
 *
 * The §20 routing table falls out of the two axes rather than being a menu the user
 * has to navigate:
 *
 * |            | just this month                  | from here forward             |
 * |------------|----------------------------------|-------------------------------|
 * | spend line | `thisMonthOnly` line override    | `fromHereForward` line override |
 * | income     | **ledger transaction** (the delta) | job/stream income override    |
 *
 * The income column is the interesting one. A one-month income change *is* a discrete
 * cash event — a bonus, a missed paycheck — so it routes to the ledger as a **delta**
 * against what that month already resolved to (§18), not as an override that would
 * imply a standing change. A permanent income change is a raise, and rides the
 * job/stream (§6/§17) — income is never modelled as a budget line.
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
 * The environment an edit resolves against — the price growth the editor shows rows in.
 * Routing itself needs no conversion (an override stores the typed figure as that
 * month's dollars), so this is only what {@link resolveRowsAtMonth} reads.
 */
export interface MonthEditContext {
  /** Annual price growth, e.g. `0.03` — the plan's CPI. */
  readonly annualInflationRate: number;
}

/**
 * The user's answer to "how long does this change last?" — the only question the
 * gesture asks. These are the engine's own {@link BudgetLineOverride} scopes (§19), so
 * a spend edit routes to an override with no translation.
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

/**
 * The canonical primitive an edit lands on (§20). Exactly one of these is applied —
 * never a fourth "adjustment" record.
 */
export type MonthEditRoute =
  | {
      readonly kind: "lineOverride";
      readonly lineId: string;
      readonly override: BudgetLineOverride;
    }
  | {
      readonly kind: "ledgerTransaction";
      readonly month: number;
      /** Signed delta against the month's prior income — positive is cash in (§18). */
      readonly amountCents: number;
    }
  | {
      readonly kind: "incomeOverride";
      readonly month: number;
      readonly monthlyCents: number;
    };

/**
 * Route a direct edit to its primitive (§20). Total over the two axes — every
 * (row, scope) pair has exactly one home, so the UI never has to ask the user which
 * kind of thing they are creating. Needs no inflation context: the typed figure is
 * stored as that month's dollars and the engine grows it from there.
 */
export function routeMonthEdit(edit: MonthEdit): MonthEditRoute {
  if (edit.row.kind === "line") {
    // Both spend scopes store the typed figure verbatim: an override means "from this
    // month the amount is X", in that month's dollars. `compileBudget` resets the
    // growth clock to the override's month, so X is charged there and grows from
    // there — no conversion, and nothing to keep in sync with the engine's compounding.
    return {
      kind: "lineOverride",
      lineId: edit.row.lineId,
      override: { month: edit.month, monthlyCents: edit.newAmountCents, scope: edit.scope },
    };
  }

  if (edit.scope === "thisMonthOnly") {
    // A single month of extra (or missing) income is a discrete cash event, so it is
    // a ledger transaction for the *difference* — leaving the standing income alone.
    return {
      kind: "ledgerTransaction",
      month: edit.month,
      amountCents: edit.newAmountCents - edit.priorAmountCents,
    };
  }

  // A permanent income change is a raise: it rides the job/stream, not a budget line.
  // Stored the same way as a spend override — that month's dollars, growing from there.
  return { kind: "incomeOverride", month: edit.month, monthlyCents: edit.newAmountCents };
}

/**
 * Grow an amount authored at `fromMonth` to `toMonth`. Display-only: income overrides
 * live in panel state and never reach the projection (they land on jobs in #72), so
 * this is an approximation for the editor's own row rather than something the engine
 * has to agree with to the cent.
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
   * The line's amount at the selected month in THAT month's dollars — the same figure
   * the projection charges and the graph draws, inflation included.
   */
  readonly monthlyCents: number;
  /** True when a dated override — not the base amount — is what is showing here. */
  readonly overridden: boolean;
}

/**
 * Resolve every standing line to what it actually is **at `month`**: the base amount,
 * any dated override layered on (§19), and the price growth that has accrued by then.
 * This is what makes the editor a view of a *point on the budget* — scrub to year 30 and
 * the rows show year-30 dollars, matching the graph directly above them.
 *
 * It reads the amounts off the very series the simulator runs
 * ({@link compileExpenseBudgetLines}) rather than recomputing growth here, so the editor
 * and the projection cannot drift apart.
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
 * Apply a routed line override to the standing lines — the one mutation the panel
 * performs on its own state. A `thisMonthOnly` override *replaces* any existing
 * override at the same month so repeated edits to the same point don't stack up.
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
