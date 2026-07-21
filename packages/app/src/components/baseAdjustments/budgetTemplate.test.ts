import { describe, expect, it } from "vitest";
import { dollarsToCents } from "@finley/engine";
import { defaultBudgetTemplate, quickstartFromIncome } from "./budgetTemplate";

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
});

describe("quickstartFromIncome — the %-quickstart (§15, AC3)", () => {
  it("splits monthly income 50/30/20 across needs/wants/savings", () => {
    const income = dollarsToCents(5_000);
    const lines = quickstartFromIncome(income);
    const byCategory = Object.fromEntries(
      lines.map((l) => [l.category, l.amountSource]),
    );
    expect((byCategory.needs as { monthlyCents: number }).monthlyCents).toBe(dollarsToCents(2_500));
    expect((byCategory.wants as { monthlyCents: number }).monthlyCents).toBe(dollarsToCents(1_500));
    expect((byCategory.savings as { monthlyCents: number }).monthlyCents).toBe(dollarsToCents(1_000));
  });

  it("keeps every quickstart line a literal expense line", () => {
    const lines = quickstartFromIncome(dollarsToCents(4_000));
    expect(lines.every((l) => l.amountSource.kind === "literal")).toBe(true);
    expect(lines.every((l) => l.target.kind === "expense")).toBe(true);
  });
});
