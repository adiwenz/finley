/**
 * The **Base** budget template — the user's standing recurring budget, prepopulated rather than
 * blank so a new user edits a budget instead of authoring one:
 *
 *   - {@link defaultBudgetTemplate} — a starter set of lines across the needs → wants tiers.
 *   - {@link redistributeToTiers} — 50/30/20 applied non-destructively to the existing budget.
 *
 * Everything here is authored ID-FREE: a line's durable id is the engine's to mint, and the
 * chart, overrides and the `line:<id>` obligation ids (`obligationBudgetLineId` in the engine)
 * key on whatever it issued. The simulator funds
 * account-contribution lines as well as expenses, so a seeded savings line is a real
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
 * Promote authoring inputs to standing {@link BudgetLine}s for the rebalance MATH, which works
 * over `BudgetLine` and so needs every line to have some key.
 *
 * The key is the label, and it is a LOCAL placeholder — not an id. Only the engine issues ids;
 * anything these lines seed is handed to `addBudgetLine` stripped of it (see
 * {@link tierRebalanceWrites}), which mints the real one.
 */
export function toBudgetLines(inputs: readonly BudgetLineInput[]): BudgetLine[] {
  return inputs.map((input) => ({ ...input, id: input.label }) as BudgetLine);
}

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

/** The first post-tax contribution target (brokerage). */
const DEFAULT_CONTRIBUTION_ACCOUNT = CONTRIBUTION_TARGETS[0];

/**
 * The tiers the 50/30/20 template rebalances. `healthcare` is deliberately not one: a premium
 * is not a share of take-home the household chooses, so the template leaves a health line
 * exactly as authored rather than scaling it into the needs bucket — or seeding one when the
 * budget has none, which would invent a cost the user never stated.
 */
type TemplateTier = "needs" | "wants" | "savings";

function isTemplateTier(category: BudgetCategory): category is TemplateTier {
  return category !== "healthcare";
}

const TIER_FRACTION: Record<TemplateTier, number> = { needs: 0.5, wants: 0.3, savings: 0.2 };
const TIERS: readonly TemplateTier[] = ["needs", "wants", "savings"];

// Seeds are authored ID-free, like every other line. `toBudgetLines` keys them on their label
// just far enough to run the rebalance math; `tierRebalanceWrites` strips that placeholder back
// off before the seed reaches `addBudgetLine`, which mints the id the app then keys on.
function seedSavingsLine(monthlyCents: number, retirementMonth?: number): BudgetLineInput {
  const account = DEFAULT_CONTRIBUTION_ACCOUNT;
  const line: BudgetLineInput = {
    label: "Savings",
    target: { kind: "account", accountId: account.accountId, taxTreatment: account.taxTreatment },
    amountSource: { kind: "literal", monthlyCents },
    category: "savings",
  };
  // Saving comes out of a paycheck, so it stops at retirement; needs/wants run on.
  return retirementMonth === undefined ? line : { ...line, span: { endMonth: retirementMonth } };
}

function seedExpenseLine(category: "needs" | "wants", monthlyCents: number): BudgetLineInput {
  const label = category === "needs" ? "Needs" : "Wants";
  return {
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
  const target = (tier: TemplateTier) => Math.round(monthlyIncomeCents * TIER_FRACTION[tier]);

  const literalTotal: Record<TemplateTier, number> = { needs: 0, wants: 0, savings: 0 };
  const literalCount: Record<TemplateTier, number> = { needs: 0, wants: 0, savings: 0 };
  for (const l of lines) {
    if (l.amountSource.kind !== "literal" || !isTemplateTier(l.category)) continue;
    literalTotal[l.category] += l.amountSource.monthlyCents;
    literalCount[l.category] += 1;
  }

  const scaled = lines.map((l) => {
    // A health line passes through untouched — it is not one of the tiers being rebalanced.
    if (l.amountSource.kind !== "literal" || !isTemplateTier(l.category)) return l;
    const total = literalTotal[l.category];
    const newCents =
      total > 0
        ? Math.round((l.amountSource.monthlyCents / total) * target(l.category))
        : Math.round(target(l.category) / literalCount[l.category]); // even split when all 0
    return withMonthlyCents(l, newCents);
  });

  // An empty tier can't be scaled into existence, so seed it. `toBudgetLines` gives each seed
  // its label as a key.
  const seeds: BudgetLineInput[] = [];
  for (const tier of TIERS) {
    if (lines.some((l) => l.category === tier)) continue;
    seeds.push(
      tier === "savings"
        ? seedSavingsLine(target("savings"), retirementMonth)
        : seedExpenseLine(tier, target(tier)),
    );
  }

  return [...scaled, ...toBudgetLines(seeds)];
}

/**
 * The same rebalance, decomposed into the writes that perform it: which existing lines change
 * amount, and which tiers need a line seeded.
 *
 * Derived by diffing {@link redistributeToTiers}' own output rather than recomputing the
 * split, so the 50/30/20 rule has one implementation and the writes cannot drift from it. The
 * panel needs this shape because the plan is authored through `Projection`, which takes one
 * line at a time and no whole `budgetLines` array.
 */
export interface TierRebalance {
  /** Existing literal lines whose amount moves, by id. Unchanged lines are omitted. */
  readonly rescale: readonly { readonly id: string; readonly monthlyCents: number }[];
  /** One per tier that had no lines at all — nothing to scale, so it is seeded instead. */
  readonly seeds: readonly BudgetLineInput[];
}

export function tierRebalanceWrites(
  lines: readonly BudgetLine[],
  monthlyIncomeCents: number,
  retirementMonth?: number,
): TierRebalance {
  const before = new Map(lines.map((l) => [l.id, l]));
  const rescale: { id: string; monthlyCents: number }[] = [];
  const seeds: BudgetLineInput[] = [];

  for (const line of redistributeToTiers(lines, monthlyIncomeCents, retirementMonth)) {
    const prior = before.get(line.id);
    if (prior === undefined) {
      // A line the rebalance invented. Its `id` is the label placeholder `toBudgetLines` used
      // to run the diff; drop it, so what reaches `addBudgetLine` names nothing and is minted.
      const { id: _placeholder, ...seed } = line;
      seeds.push(seed);
      continue;
    }
    // Non-literal lines pass through the rebalance untouched, so only a moved literal amount
    // is a write at all.
    if (
      line.amountSource.kind === "literal" &&
      (prior.amountSource.kind !== "literal" ||
        prior.amountSource.monthlyCents !== line.amountSource.monthlyCents)
    ) {
      rescale.push({ id: line.id, monthlyCents: line.amountSource.monthlyCents });
    }
  }

  return { rescale, seeds };
}
