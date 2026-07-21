/**
 * The **Base** budget template (§12/§15, "UI: Base + Adjustments" of
 * JOBS_HOUSEHOLD_REDESIGN, issue #71). The Base is the user's standing recurring
 * budget — entered once, then edited. Rather than start from a blank list, we
 * prepopulate two ways (§15):
 *
 *   - {@link defaultBudgetTemplate} — a sensible starter set of line items across the
 *     needs → wants tiers, so a new user has a budget to edit rather than author.
 *   - {@link quickstartFromIncome} — the classic 50/30/20 %-split of take-home into
 *     needs / wants / savings, for a user who would rather start from their income.
 *
 * Both return {@link BudgetLineInput}s (id-carrying so the chart, overrides, and the
 * `allocations()` view can key on them) and only `literal` expense lines — the shape
 * the simulator funds today (contribution/`fillToLimit` lines land with the #72
 * rewire). Pure and side-effect-free; the app calls these to seed component state.
 */

import { dollarsToCents, type BudgetLineInput } from "@finley/engine";

/** A literal monthly expense line for the template — the only shape both helpers emit. */
function expenseLine(
  id: string,
  label: string,
  category: BudgetLineInput["category"],
  monthlyCents: number,
): BudgetLineInput {
  return {
    id,
    label,
    target: { kind: "expense" },
    amountSource: { kind: "literal", monthlyCents },
    category,
  };
}

/**
 * A prepopulated starter budget (AC3): housing, groceries, and transport as needs;
 * dining and subscriptions as wants. Amounts are round placeholders the user edits;
 * the tiers give the §15 waterfall a sensible funding order out of the box (needs
 * before wants), so a shortfall starves discretionary wants before essentials.
 */
export function defaultBudgetTemplate(): BudgetLineInput[] {
  return [
    expenseLine("housing", "Housing", "needs", dollarsToCents(1_600)),
    expenseLine("groceries", "Groceries", "needs", dollarsToCents(600)),
    expenseLine("transport", "Transportation", "needs", dollarsToCents(300)),
    expenseLine("dining", "Dining & fun", "wants", dollarsToCents(400)),
    expenseLine("subscriptions", "Subscriptions", "wants", dollarsToCents(100)),
  ];
}

/**
 * The %-quickstart (§15, AC3): the 50/30/20 rule applied to monthly income — 50%
 * needs, 30% wants, 20% savings — as three literal lines. A one-click alternative to
 * the itemized {@link defaultBudgetTemplate} for a user who thinks in percentages.
 * Rounded to whole cents; the last slice is not force-balanced (each is an independent
 * budget target, not a partition of a fixed pot).
 */
export function quickstartFromIncome(monthlyIncomeCents: number): BudgetLineInput[] {
  const pct = (fraction: number) => Math.round(monthlyIncomeCents * fraction);
  return [
    expenseLine("needs", "Needs (50%)", "needs", pct(0.5)),
    expenseLine("wants", "Wants (30%)", "wants", pct(0.3)),
    expenseLine("savings", "Savings (20%)", "savings", pct(0.2)),
  ];
}
