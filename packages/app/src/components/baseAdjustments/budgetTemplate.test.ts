import { describe, expect, it } from "vitest";
import { dollarsToCents, type BudgetLine } from "@finley/engine";
import { PLAN_DEFAULTS } from "../../planDefaults";
import {
  DEFAULT_TEMPLATE_TOTAL_CENTS,
  defaultBudgetTemplate,
  redistributeToTiers,
  toBudgetLines,
} from "./budgetTemplate";

/** Sum the literal monthly cents of a tier's lines. */
const tierTotal = (lines: readonly BudgetLine[], category: string): number =>
  lines
    .filter((l) => l.category === category)
    .reduce((s, l) => s + (l.amountSource.kind === "literal" ? l.amountSource.monthlyCents : 0), 0);

describe("defaultBudgetTemplate — the prepopulated Base (AC3)", () => {
  it("prepopulates a non-empty set of standing expense lines with stable ids", () => {
    const lines = defaultBudgetTemplate();
    expect(lines.length).toBeGreaterThan(0);
    // Every template line is a cash-outflow expense line with an id (so the chart /
    // overrides can key on it), spanning the needs → wants tiers.
    expect(lines.every((l) => l.target.kind === "expense")).toBe(true);
    expect(lines.every((l) => typeof l.id === "string" && l.id.length > 0)).toBe(true);
    expect(new Set(lines.map((l) => l.id)).size).toBe(lines.length); // ids unique
    expect(lines.some((l) => l.category === "needs")).toBe(true);
    expect(lines.some((l) => l.category === "wants")).toBe(true);
  });

  it("spends exactly what the scalar default did, so itemizing changes authoring not amount", () => {
    const total = defaultBudgetTemplate().reduce(
      (sum, l) => sum + (l.amountSource as { monthlyCents: number }).monthlyCents,
      0,
    );
    expect(total).toBe(DEFAULT_TEMPLATE_TOTAL_CENTS);
    // The scalar field the line-item budget replaced. If someone retunes the template
    // without retuning this, the app's default retirement age moves silently.
    expect(total).toBe(PLAN_DEFAULTS.expenseCents);
  });
});

describe("redistributeToTiers — the non-destructive 50/30/20 quickstart (§15, AC3)", () => {
  const income = dollarsToCents(5_000);

  it("preserves the user's named lines — it rebalances, it does not replace", () => {
    const before = toBudgetLines(defaultBudgetTemplate());
    const after = redistributeToTiers(before, income);
    // Every original line survives by id (Housing, Groceries, Dining, …).
    for (const l of before) expect(after.some((a) => a.id === l.id)).toBe(true);
  });

  it("rebalances each tier's existing lines to hit 50/30/20 of income", () => {
    const after = redistributeToTiers(toBudgetLines(defaultBudgetTemplate()), income);
    expect(tierTotal(after, "needs")).toBe(dollarsToCents(2_500));
    expect(tierTotal(after, "wants")).toBe(dollarsToCents(1_500));
  });

  it("preserves each line's share within its tier when scaling", () => {
    // Two needs lines 3:1 → after scaling to $2,500 they stay 3:1 ($1,875 / $625).
    const lines: BudgetLine[] = [
      { id: "a", label: "A", target: { kind: "expense" }, amountSource: { kind: "literal", monthlyCents: dollarsToCents(1_500) }, category: "needs" },
      { id: "b", label: "B", target: { kind: "expense" }, amountSource: { kind: "literal", monthlyCents: dollarsToCents(500) }, category: "needs" },
    ];
    const after = redistributeToTiers(lines, income);
    const amt = (id: string) => {
      const s = after.find((l) => l.id === id)!.amountSource;
      return s.kind === "literal" ? s.monthlyCents : 0;
    };
    expect(amt("a")).toBe(dollarsToCents(1_875));
    expect(amt("b")).toBe(dollarsToCents(625));
  });

  it("seeds a real savings CONTRIBUTION line for an empty savings tier", () => {
    // The default template has no savings-tier line, so the 20% is seeded — and as a
    // funded contribution into an account (not a vanishing expense).
    const after = redistributeToTiers(toBudgetLines(defaultBudgetTemplate()), income, 240);
    const savings = after.filter((l) => l.category === "savings");
    expect(savings.length).toBe(1);
    expect(savings[0].target.kind).toBe("account");
    expect((savings[0].amountSource as { monthlyCents: number }).monthlyCents).toBe(dollarsToCents(1_000));
    // Saving stops at the retirement month (a retiree draws down, not up).
    expect(savings[0].span).toEqual({ endMonth: 240 });
  });

  it("leaves a seeded savings line open-ended when there is no retirement month", () => {
    const after = redistributeToTiers(toBudgetLines(defaultBudgetTemplate()), income);
    expect(after.find((l) => l.category === "savings")?.span).toBeUndefined();
  });
});
