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

import { dollarsToCents, type BudgetLine, type BudgetLineInput } from "@finley/engine";

/**
 * Promote authoring inputs to standing {@link BudgetLine}s. Every template line
 * already carries an id (the chart, overrides, and `allocations()` all key on it);
 * the label is a last-resort fallback so the cast is total rather than hopeful.
 */
export function toBudgetLines(inputs: readonly BudgetLineInput[]): BudgetLine[] {
  return inputs.map((input) => ({ ...input, id: input.id ?? input.label }) as BudgetLine);
}

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
 * the tiers group the budget the way a user reads it (essentials apart from
 * discretionary). They do not ration anything: a tight month is absorbed by savings and
 * then credit, never by dropping a line — see `perLineBudget.ts`.
 */
export function defaultBudgetTemplate(): BudgetLineInput[] {
  return [
    expenseLine("housing", "Housing", "needs", dollarsToCents(1_600)),
    expenseLine("groceries", "Groceries", "needs", dollarsToCents(700)),
    expenseLine("transport", "Transportation", "needs", dollarsToCents(450)),
    expenseLine("dining", "Dining & fun", "wants", dollarsToCents(550)),
    expenseLine("subscriptions", "Subscriptions", "wants", dollarsToCents(200)),
  ];
}

/**
 * The template's total monthly spend. It deliberately equals the scalar
 * `PLAN_DEFAULTS.expenseCents` the line-item budget replaced: itemizing the default
 * budget should change how spending is *authored*, not how much a default household
 * spends — otherwise wiring the editor up would quietly move the app's headline
 * retirement age. Pinned by a test so the two cannot drift apart.
 */
export const DEFAULT_TEMPLATE_TOTAL_CENTS = dollarsToCents(3_500);

/**
 * The %-quickstart (§15, AC3): the 50/30/20 rule applied to monthly income — 50%
 * needs, 30% wants, 20% savings — as three literal lines. A one-click alternative to
 * the itemized {@link defaultBudgetTemplate} for a user who thinks in percentages.
 * Rounded to whole cents; the last slice is not force-balanced (each is an independent
 * budget target, not a partition of a fixed pot).
 *
 * `retirementMonth` ends the **savings** line's span (§19). Saving is something a
 * household does out of a paycheck: once it retires it is drawing its savings *down*,
 * so a standing "put 20% away" line that ran forever would have a retiree contributing
 * to savings out of the savings it is simultaneously spending. Needs and wants keep
 * running — a retiree still eats. Omit the argument and the savings line never stops
 * (the right behaviour when there is no retirement date to key on).
 *
 * The savings slice is modelled as an `expense` line because that is the only shape
 * the simulator funds today; it becomes a real contribution line (`target: account`)
 * in the #72 rewire, at which point the span here is what tells that line when to stop.
 */
export function quickstartFromIncome(
  monthlyIncomeCents: number,
  retirementMonth?: number,
): BudgetLineInput[] {
  const pct = (fraction: number) => Math.round(monthlyIncomeCents * fraction);
  const savings = expenseLine("savings", "Savings (20%)", "savings", pct(0.2));
  return [
    expenseLine("needs", "Needs (50%)", "needs", pct(0.5)),
    expenseLine("wants", "Wants (30%)", "wants", pct(0.3)),
    retirementMonth === undefined ? savings : { ...savings, span: { endMonth: retirementMonth } },
  ];
}
