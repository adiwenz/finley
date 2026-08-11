import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATE_TOTAL_CENTS, defaultBudgetTemplate } from "./budgetTemplate";
import { PLAN_DEFAULTS } from "../../planDefaults";

describe("defaultBudgetTemplate — the prepopulated Base", () => {
  it("prepopulates a non-empty set of standing expense lines, naming no ids", () => {
    const lines = defaultBudgetTemplate();
    expect(lines.length).toBeGreaterThan(0);
    // Every line is a cash-outflow expense spanning the needs → wants tiers. The template names
    // no id at all — `addBudgetLine` mints one, and the chart and overrides key on that.
    expect(lines.every((l) => l.target.kind === "expense")).toBe(true);
    expect(lines.every((l) => !("id" in l))).toBe(true);
    // Labels are what a reader (and a test) identifies a template line by, so they must be
    // distinct even though they are not identity.
    expect(new Set(lines.map((l) => l.label)).size).toBe(lines.length);
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
