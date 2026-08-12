/**
 * The **Base** budget template — the user's standing recurring budget, prepopulated rather than
 * blank so a new user edits a budget instead of authoring one: {@link defaultBudgetTemplate} is
 * a starter set of lines across the needs → wants tiers.
 *
 * Authored ID-FREE: a line's durable id is the engine's to mint, and the chart, overrides and
 * the `line:<id>` obligation ids (`obligationBudgetLineId` in the engine) key on whatever it
 * issued.
 */

import { dollarsToCents, type BudgetLineInput } from "@finley/engine";

function expenseLine(
  label: string,
  category: BudgetLineInput["category"],
  monthlyCents: number,
): BudgetLineInput {
  return {
    label,
    target: { kind: "expense" },
    amountSource: { kind: "literal", monthlyCents },
    category,
  };
}

/**
 * A starter budget with round placeholder amounts. Tiers only group the budget as a user reads
 * it; they ration nothing — a tight month is absorbed by savings then credit, never by dropping
 * a line (see `perLineBudget.ts`).
 */
export function defaultBudgetTemplate(): BudgetLineInput[] {
  return [
    expenseLine("Housing", "needs", dollarsToCents(1_600)),
    expenseLine("Groceries", "needs", dollarsToCents(700)),
    expenseLine("Transportation", "needs", dollarsToCents(450)),
    // Health seeds the budget rather than the plan: this is the figure that used to be
    // `Plan.healthMonthlyCents`, carried over unchanged so a fresh plan spends what it always
    // did. Realistic pre-65 self-funded cover, still under the ~$1,200 benchmark, so pulling
    // the retirement age below 65 fires the early-retiree nudge exactly as before.
    expenseLine("Healthcare", "healthcare", dollarsToCents(700)),
    expenseLine("Dining & fun", "wants", dollarsToCents(550)),
    expenseLine("Subscriptions", "wants", dollarsToCents(200)),
  ];
}

/**
 * The default household's total monthly spend, health included — it is a budget line like any
 * other now, so it counts here where it used to sit outside as a plan field. Retuning the
 * template's lines without retuning this moves the app's headline retirement age silently, so a
 * test pins the two together.
 */
export const DEFAULT_TEMPLATE_TOTAL_CENTS = dollarsToCents(4_200);
