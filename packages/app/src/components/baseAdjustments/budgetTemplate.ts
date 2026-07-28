/**
 * The **Base** budget template. The Base is the user's standing recurring budget —
 * entered once, then edited. Rather than a blank list, two ways to prepopulate:
 *
 *   - {@link defaultBudgetTemplate} — a starter set of lines across the needs → wants
 *     tiers, so a new user edits a budget rather than authoring one.
 *   - {@link redistributeToTiers} — 50/30/20 applied *non-destructively* to the existing
 *     budget: rebalance each tier's lines without discarding the user's named lines,
 *     seeding a real savings contribution if needed.
 *
 * Returns {@link BudgetLineInput}s, id-carrying so the chart, overrides and
 * `allocations()` can key on them. The simulator funds both expense and
 * account-contribution lines, so a seeded savings line is a real contribution into the
 * brokerage, not a vanishing expense. Pure and side-effect-free.
 */

import {
  CONTRIBUTION_TARGETS,
  dollarsToCents,
  type BudgetCategory,
  type BudgetLine,
  type BudgetLineInput,
} from "@finley/engine";

/**
 * Promote authoring inputs to standing {@link BudgetLine}s. Every template line already
 * carries an id; the label is a last-resort fallback so the cast is total, not hopeful.
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
 * A prepopulated starter budget: housing, groceries, transport as needs; dining and
 * subscriptions as wants. Amounts are round placeholders the user edits. Tiers only group
 * the budget as a user reads it (essentials apart from discretionary) — they ration
 * nothing: a tight month is absorbed by savings then credit, never by dropping a line
 * (see `perLineBudget.ts`).
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
 * The template's total monthly spend. Deliberately equals the scalar
 * `PLAN_DEFAULTS.expenseCents` it replaced: itemizing should change how spending is
 * *authored*, not how much a default household spends — otherwise wiring up the editor
 * would quietly move the app's headline retirement age. Pinned by a test against drift.
 */
export const DEFAULT_TEMPLATE_TOTAL_CENTS = dollarsToCents(3_500);

/** The account a seeded savings line contributes into — the first post-tax target (brokerage). */
const DEFAULT_CONTRIBUTION_ACCOUNT = CONTRIBUTION_TARGETS[0];

/** The 50/30/20 fractions the quickstart targets, by tier. */
const TIER_FRACTION: Record<BudgetCategory, number> = { needs: 0.5, wants: 0.3, savings: 0.2 };
const TIERS: readonly BudgetCategory[] = ["needs", "wants", "savings"];

/** A literal contribution line into an account (the funded shape a savings line takes). */
function seedSavingsLine(monthlyCents: number, retirementMonth?: number): BudgetLine {
  const account = DEFAULT_CONTRIBUTION_ACCOUNT;
  const line: BudgetLine = {
    id: "seed-savings",
    label: "Savings",
    target: { kind: "account", accountId: account.accountId, taxTreatment: account.taxTreatment },
    amountSource: { kind: "literal", monthlyCents },
    category: "savings",
  };
  // Saving comes out of a paycheck: stop at retirement, when the household draws savings
  // down rather than adding to them. Needs/wants run on.
  return retirementMonth === undefined ? line : { ...line, span: { endMonth: retirementMonth } };
}

/** A seeded expense line for an empty needs/wants tier. */
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

/** A copy of a literal line with a new monthly amount (non-literal lines pass through). */
function withMonthlyCents(line: BudgetLine, monthlyCents: number): BudgetLine {
  return line.amountSource.kind === "literal"
    ? { ...line, amountSource: { kind: "literal", monthlyCents } }
    : line;
}

/**
 * The %-quickstart, **non-destructively**: rebalance the *existing* budget to 50% needs /
 * 30% wants / 20% savings of monthly income WITHOUT discarding the user's named lines.
 * Each tier's literal lines are scaled so the tier total lands on target, preserving every
 * line's share within the tier (even split when the tier currently sums to 0). A tier with
 * **no** lines gets one seed: needs/wants an expense line, savings a real contribution
 * into the brokerage so the 20% accumulates rather than vanishing. Non-`literal` lines
 * (goal-paced / fill-to-limit) are untouched — they compute their own amount.
 *
 * `retirementMonth` ends a seeded savings line's span; omit it and the line runs
 * open-ended. Original order is preserved, with seeds appended.
 */
export function redistributeToTiers(
  lines: readonly BudgetLine[],
  monthlyIncomeCents: number,
  retirementMonth?: number,
): BudgetLine[] {
  const target = (tier: BudgetCategory) => Math.round(monthlyIncomeCents * TIER_FRACTION[tier]);

  // Per-tier literal totals and counts, to scale each line to its share of the target.
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

  // Seed any tier with no lines at all — an empty tier can't be scaled into existence.
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
