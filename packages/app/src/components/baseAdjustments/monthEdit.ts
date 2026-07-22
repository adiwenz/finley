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
  resolveBudgetLineMonthlyCents,
  type BudgetLine,
  type BudgetLineOverride,
} from "@finley/engine";

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
 * kind of thing they are creating.
 */
export function routeMonthEdit(edit: MonthEdit): MonthEditRoute {
  if (edit.row.kind === "line") {
    // Both spend scopes are the same primitive; the scope rides straight through to
    // the engine's dated-override semantics (§19).
    return {
      kind: "lineOverride",
      lineId: edit.row.lineId,
      override: {
        month: edit.month,
        monthlyCents: edit.newAmountCents,
        scope: edit.scope,
      },
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
  return { kind: "incomeOverride", month: edit.month, monthlyCents: edit.newAmountCents };
}

/** One row of the month editor: what this line resolves to at the selected month. */
export interface ResolvedRow {
  readonly lineId: string;
  readonly label: string;
  readonly category: BudgetLine["category"];
  /** The line's amount at the selected month, with any dated override applied (§19). */
  readonly monthlyCents: number;
  /** True when a dated override — not the base amount — is what is showing here. */
  readonly overridden: boolean;
}

/**
 * Resolve every standing line to what it actually is **at `month`** (§19) — the base
 * amount with any dated override layered on. This is what makes the editor a view of
 * a *point on the budget* rather than a view of the base: scrub to month 40 and the
 * rows show month 40's numbers, including changes made earlier in the session.
 *
 * `overridden` is derived by comparing against the month-0 resolution, so the UI can
 * mark a row the user has already adjusted (and offer to clear it).
 */
export function resolveRowsAtMonth(
  lines: readonly BudgetLine[],
  month: number,
  startYear: number,
): readonly ResolvedRow[] {
  return lines.map((line) => {
    const ctx = { month, year: startYear + Math.floor(month / 12) };
    const monthlyCents = resolveBudgetLineMonthlyCents(line, ctx);
    const overridden = (line.overrides ?? []).some(
      (o) =>
        (o.scope === "thisMonthOnly" && o.month === month) ||
        (o.scope === "fromHereForward" && o.month <= month),
    );
    return {
      lineId: line.id,
      label: line.label,
      category: line.category,
      monthlyCents,
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
