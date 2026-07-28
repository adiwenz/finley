/**
 * The **Base** budget template — the user's standing recurring budget, prepopulated rather than
 * blank so a new user edits a budget instead of authoring one:
 *
 *   - {@link defaultBudgetTemplate} — a starter set of lines across the needs → wants tiers.
 *   - {@link redistributeToTiers} — 50/30/20 applied non-destructively to the existing budget.
 *
 * Lines carry ids so the chart, overrides and `allocations()` can key on them. The simulator
 * funds account-contribution lines as well as expenses, so a seeded savings line is a real
 * contribution into the brokerage, not a vanishing expense.
 */

import {
  CONTRIBUTION_TARGETS,
  dollarsToCents,
  type BudgetCategory,
  type BudgetLine,
  type BudgetLineInput,
} from "@finley/engine";

/**
 * Promote authoring inputs to standing {@link BudgetLine}s. Template lines already carry an id;
 * the label is a last-resort fallback so the cast is total.
 */
export function toBudgetLines(inputs: readonly BudgetLineInput[]): BudgetLine[] {
  return inputs.map((input) => ({ ...input, id: input.id ?? input.label }) as BudgetLine);
}

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
 * A starter budget with round placeholder amounts. Tiers only group the budget as a user reads
 * it; they ration nothing — a tight month is absorbed by savings then credit, never by dropping
 * a line (see `perLineBudget.ts`).
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
 * The default household's total monthly spend. Retuning the template's lines without retuning
 * this moves the app's headline retirement age silently, so a test pins the two together.
 */
export const DEFAULT_TEMPLATE_TOTAL_CENTS = dollarsToCents(3_500);

/** The first post-tax contribution target (brokerage). */
const DEFAULT_CONTRIBUTION_ACCOUNT = CONTRIBUTION_TARGETS[0];

const TIER_FRACTION: Record<BudgetCategory, number> = { needs: 0.5, wants: 0.3, savings: 0.2 };
const TIERS: readonly BudgetCategory[] = ["needs", "wants", "savings"];

function seedSavingsLine(monthlyCents: number, retirementMonth?: number): BudgetLine {
  const account = DEFAULT_CONTRIBUTION_ACCOUNT;
  const line: BudgetLine = {
    id: "seed-savings",
    label: "Savings",
    target: { kind: "account", accountId: account.accountId, taxTreatment: account.taxTreatment },
    amountSource: { kind: "literal", monthlyCents },
    category: "savings",
  };
  // Saving comes out of a paycheck, so it stops at retirement; needs/wants run on.
  return retirementMonth === undefined ? line : { ...line, span: { endMonth: retirementMonth } };
}

function seedExpenseLine(category: "needs" | "wants", monthlyCents: number): BudgetLine {
  const label = category === "needs" ? "Needs" : "Wants";
  return {
    id: `seed-${category}`,
    label,
    target: { kind: "expense" },
    amountSource: { kind: "literal", monthlyCents },
    category,
  };
}

/** Non-literal lines pass through unchanged. */
function withMonthlyCents(line: BudgetLine, monthlyCents: number): BudgetLine {
  return line.amountSource.kind === "literal"
    ? { ...line, amountSource: { kind: "literal", monthlyCents } }
    : line;
}

/**
 * Rebalance the *existing* budget to 50% needs / 30% wants / 20% savings of monthly income
 * without discarding the user's named lines. Each tier's literal lines are scaled so the tier
 * total lands on target, preserving every line's share within the tier (even split when the
 * tier currently sums to 0). A tier with **no** lines gets one seed: an expense line for
 * needs/wants, a real brokerage contribution for savings so the 20% accumulates rather than
 * vanishing. Non-`literal` lines compute their own amount and are untouched.
 *
 * `retirementMonth` ends a seeded savings line's span; omit it and the line runs open-ended.
 * Original order is preserved, with seeds appended.
 */
export function redistributeToTiers(
  lines: readonly BudgetLine[],
  monthlyIncomeCents: number,
  retirementMonth?: number,
): BudgetLine[] {
  const target = (tier: BudgetCategory) => Math.round(monthlyIncomeCents * TIER_FRACTION[tier]);

  const literalTotal: Record<BudgetCategory, number> = { needs: 0, wants: 0, savings: 0 };
  const literalCount: Record<BudgetCategory, number> = { needs: 0, wants: 0, savings: 0 };
  for (const l of lines) {
    if (l.amountSource.kind !== "literal") continue;
    literalTotal[l.category] += l.amountSource.monthlyCents;
    literalCount[l.category] += 1;
  }

  const scaled = lines.map((l) => {
    if (l.amountSource.kind !== "literal") return l;
    const total = literalTotal[l.category];
    const newCents =
      total > 0
        ? Math.round((l.amountSource.monthlyCents / total) * target(l.category))
        : Math.round(target(l.category) / literalCount[l.category]); // even split when all 0
    return withMonthlyCents(l, newCents);
  });

  // An empty tier can't be scaled into existence, so seed it.
  const seeds: BudgetLine[] = [];
  for (const tier of TIERS) {
    if (lines.some((l) => l.category === tier)) continue;
    seeds.push(
      tier === "savings"
        ? seedSavingsLine(target("savings"), retirementMonth)
        : seedExpenseLine(tier, target(tier)),
    );
  }

  return [...scaled, ...seeds];
}
