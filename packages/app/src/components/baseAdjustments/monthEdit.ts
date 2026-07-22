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
 * The environment an edit resolves against. Budget amounts are authored in the dollars
 * of a line's anchor month and grow with prices from there, so converting between "what
 * the user sees at month M" and "what gets stored" needs the rate.
 */
export interface MonthEditContext {
  /** Annual price growth, e.g. `0.03` — the plan's CPI. */
  readonly annualInflationRate: number;
}

const PROBE_BASE_CENTS = 1_000_000;

/**
 * Price growth between month 0 and `month`, measured by asking the engine rather than
 * recomputing it. The series compounds in annual steps and rounds as it goes, so a
 * continuous `Math.pow` disagrees with it by real money mid-year — enough that a figure
 * typed into the editor would land as a different figure in the projection. Compiling a
 * throwaway probe line makes the editor's arithmetic *definitionally* the engine's.
 *
 * Anchored at month 0, which is where every line authored through this panel starts
 * its growth clock. A line with a `span.startMonth` would anchor there instead, and
 * would need its own probe — nothing can author one today, so rather than carry a
 * configurable anchor that nothing sets and nothing honours, this is fixed at 0 and
 * will need revisiting when lines can start mid-timeline.
 */
export function growthFactorAt(month: number, ctx: MonthEditContext): number {
  const [probe] = compileExpenseBudgetLines(
    [
      {
        id: "probe",
        label: "probe",
        target: { kind: "expense" },
        category: "needs",
        amountSource: { kind: "literal", monthlyCents: PROBE_BASE_CENTS },
      },
    ],
    EDITOR_OWNER,
    ctx.annualInflationRate,
  );
  const rendered = probe?.series.getMonthlyCents(month) ?? PROBE_BASE_CENTS;
  return rendered > 0 ? rendered / PROBE_BASE_CENTS : 1;
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
 * kind of thing they are creating.
 */
export function routeMonthEdit(edit: MonthEdit, ctx: MonthEditContext): MonthEditRoute {
  if (edit.row.kind === "line") {
    // Both spend scopes are the same primitive, but they store dollars differently:
    // a `thisMonthOnly` override is charged verbatim at its month, while a
    // `fromHereForward` override sets a new anchor-dollar baseline that then grows with
    // prices. The user typed a figure they read off THIS month, so the forward case is
    // deflated back to anchor dollars — otherwise typing $2,400 at year 30 would quietly
    // charge the inflated value of $2,400 and the number would jump the moment it lands.
    const monthlyCents =
      edit.scope === "fromHereForward"
        ? Math.round(edit.newAmountCents / growthFactorAt(edit.month, ctx))
        : edit.newAmountCents;
    return {
      kind: "lineOverride",
      lineId: edit.row.lineId,
      override: { month: edit.month, monthlyCents, scope: edit.scope },
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
  // Income is inflation-linked too, so the typed figure is deflated to anchor dollars
  // for the same reason a forward spend edit is — it was read off THIS month.
  return {
    kind: "incomeOverride",
    month: edit.month,
    monthlyCents: Math.round(edit.newAmountCents / growthFactorAt(edit.month, ctx)),
  };
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
