import { describe, expect, it } from "vitest";
import { dollarsToCents, type BudgetLine } from "@finley/engine";
import { PLAN_DEFAULTS } from "../../planDefaults";
import {
  DEFAULT_TEMPLATE_TOTAL_CENTS,
  defaultBudgetTemplate,
  redistributeToTiers,
  tierRebalanceWrites,
  toBudgetLines,
} from "./budgetTemplate";

/** Sum the literal monthly cents of a tier's lines. */
const tierTotal = (lines: readonly BudgetLine[], category: string): number =>
  lines
    .filter((l) => l.category === category)
    .reduce((s, l) => s + (l.amountSource.kind === "literal" ? l.amountSource.monthlyCents : 0), 0);

describe("defaultBudgetTemplate — the prepopulated Base", () => {
  it("prepopulates a non-empty set of standing expense lines with stable ids", () => {
    const lines = defaultBudgetTemplate();
    expect(lines.length).toBeGreaterThan(0);
    // Every line is a cash-outflow expense with an id for the chart/overrides to key on,
    // spanning the needs → wants tiers.
    expect(lines.every((l) => l.target.kind === "expense")).toBe(true);
    expect(lines.every((l) => typeof l.id === "string" && l.id.length > 0)).toBe(true);
    expect(new Set(lines.map((l) => l.id)).size).toBe(lines.length); // ids unique
    expect(lines.some((l) => l.category === "needs")).toBe(true);
    expect(lines.some((l) => l.category === "wants")).toBe(true);
  });

  it("sums the template lines to the pinned default spend, driving the default plan's budget", () => {
    const total = defaultBudgetTemplate().reduce(
      (sum, l) => sum + (l.amountSource as { monthlyCents: number }).monthlyCents,
      0,
    );
    // Retuning the template lines without retuning this constant moves the app's default
    // retirement age silently.
    expect(total).toBe(DEFAULT_TEMPLATE_TOTAL_CENTS);
    // The default plan opens on exactly these lines, so its budget total is the same figure.
    // Expense targets only — a contribution line is saving, not spend (see `presets.test.ts`).
    const planTotal = PLAN_DEFAULTS.budgetLines.reduce(
      (sum, l) =>
        sum +
        (l.target.kind === "expense" && l.amountSource.kind === "literal"
          ? l.amountSource.monthlyCents
          : 0),
      0,
    );
    expect(planTotal).toBe(DEFAULT_TEMPLATE_TOTAL_CENTS);
  });
});

describe("redistributeToTiers — the non-destructive 50/30/20 quickstart", () => {
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
    // The default template has no savings-tier line, so the 20% is seeded as a funded
    // contribution into an account, not a vanishing expense.
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

describe("tierRebalanceWrites — the same rebalance, as facade writes", () => {
  const income = dollarsToCents(5_000);

  it("names one rescale per moved line and one seed per empty tier", () => {
    const before = toBudgetLines(defaultBudgetTemplate());
    const { rescale, seeds } = tierRebalanceWrites(before, income, 240);

    // The template's lines all move (needs and wants are both rescaled); savings has none
    // to scale, so it is the one seed.
    expect(rescale.map((r) => r.id).sort()).toEqual(before.map((l) => l.id).sort());
    expect(seeds).toHaveLength(1);
    expect(seeds[0].category).toBe("savings");
    expect(seeds[0].span).toEqual({ endMonth: 240 });
  });

  it("applying the writes reproduces redistributeToTiers exactly", () => {
    // The panel applies these one at a time through `Projection`; the result has to be the
    // budget the rule describes, or the quickstart means something different in the app than
    // it does in its own test.
    const before = toBudgetLines(defaultBudgetTemplate());
    const { rescale, seeds } = tierRebalanceWrites(before, income, 240);

    const byId = new Map(rescale.map((r) => [r.id, r.monthlyCents]));
    const applied: BudgetLine[] = [
      ...before.map((l) =>
        byId.has(l.id)
          ? { ...l, amountSource: { kind: "literal" as const, monthlyCents: byId.get(l.id)! } }
          : l,
      ),
      ...(seeds as BudgetLine[]),
    ];

    expect(applied).toEqual(redistributeToTiers(before, income, 240));
  });

  it("writes nothing for a budget already on target", () => {
    // Idempotent: re-running the quickstart on its own output has nothing left to move, so
    // it does not churn the plan through a transaction that changes no number.
    const settled = redistributeToTiers(toBudgetLines(defaultBudgetTemplate()), income, 240);
    const { rescale, seeds } = tierRebalanceWrites(settled, income, 240);
    expect(rescale).toEqual([]);
    expect(seeds).toEqual([]);
  });
});
