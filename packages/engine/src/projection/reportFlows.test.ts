import { describe, expect, it } from "vitest";
import { buildFlows, SAVINGS_DRAWDOWN_SOURCE_ID } from "./reportFlows";
import type { IncomeSourceMonth } from "./waterfall";

const src = (
  ownerId: string,
  grossCents: number,
  taxCategory: IncomeSourceMonth["taxCategory"],
  extra?: Partial<IncomeSourceMonth>,
): IncomeSourceMonth => ({ ownerId, grossCents, taxCategory, ...extra });

describe("buildFlows", () => {
  it("buckets gross income by tax category and sums the total", () => {
    const flows = buildFlows(
      [src("p1", 5_000_00, "wages"), src("p1", 1_000_00, "ordinaryIncome"), src("p2", 2_000_00, "wages")],
      0,
      0,
      0,
      {},
    );
    expect(flows.incomeByCategoryCents).toEqual({ wages: 7_000_00, ordinaryIncome: 1_000_00 });
    expect(flows.totalIncomeCents).toBe(8_000_00);
  });

  it("surfaces the government-retirement-benefit slice as its own convenience field", () => {
    const flows = buildFlows(
      [src("p1", 2_500_00, "governmentRetirementBenefit"), src("p1", 4_000_00, "wages")],
      0,
      0,
      0,
      {},
    );
    expect(flows.governmentRetirementBenefitCents).toBe(2_500_00);
  });

  it("reports 0 government retirement benefit when no source carries that category", () => {
    const flows = buildFlows([src("p1", 4_000_00, "wages")], 0, 0, 0, {});
    expect(flows.governmentRetirementBenefitCents).toBe(0);
  });

  it("passes tax, expenses and liability payments straight through", () => {
    const flows = buildFlows([], 900_00, 3_200_00, 1_800_00, {});
    expect(flows.taxCents).toBe(900_00);
    expect(flows.expensesCents).toBe(3_200_00);
    expect(flows.liabilityPaymentsCents).toBe(1_800_00);
  });

  it("carries the per-line funded map straight through (§Q27)", () => {
    const lineFunded = { "line:rent": 2_000_00, "line:fun": 100_00 };
    const flows = buildFlows([], 0, 3_200_00, 0, lineFunded);
    expect(flows.lineMonthlyCents).toEqual(lineFunded);
  });

  it("yields empty buckets and zero totals for a month with no income", () => {
    const flows = buildFlows([], 0, 0, 0, {});
    expect(flows.incomeByCategoryCents).toEqual({});
    expect(flows.totalIncomeCents).toBe(0);
    expect(flows.governmentRetirementBenefitCents).toBe(0);
    expect(flows.taxCents).toBe(0);
    expect(flows.lineMonthlyCents).toEqual({});
    expect(flows.incomeSources).toEqual([]);
  });

  // ── Per-source reporting (issue #99) ──────────────────────────────────────────

  it("reports income by source, keeping distinct sources in one tax bucket apart", () => {
    // Two jobs both taxed as `wages` — the category rollup collapses them, the source
    // list keeps them apart so a chart can name which paycheck is which.
    const flows = buildFlows(
      [
        src("p1", 5_000_00, "wages", { sourceId: "job:a", label: "Job A" }),
        src("p1", 2_000_00, "wages", { sourceId: "job:b", label: "Job B" }),
      ],
      0,
      0,
      0,
      {},
    );
    expect(flows.incomeByCategoryCents).toEqual({ wages: 7_000_00 });
    expect(flows.incomeSources).toEqual([
      { sourceId: "job:a", label: "Job A", category: "wages", grossCents: 5_000_00 },
      { sourceId: "job:b", label: "Job B", category: "wages", grossCents: 2_000_00 },
    ]);
  });

  it("sums repeated source ids and falls back to the tax category when unlabelled", () => {
    const flows = buildFlows(
      [
        src("p1", 1_000_00, "ordinaryIncome", { sourceId: "rmd:p1", label: "RMD" }),
        src("p1", 500_00, "ordinaryIncome", { sourceId: "rmd:p1", label: "RMD" }),
        src("p2", 300_00, "capitalGains"), // no id/label → keyed & named by category
      ],
      0,
      0,
      0,
      {},
    );
    expect(flows.incomeSources).toEqual([
      { sourceId: "rmd:p1", label: "RMD", category: "ordinaryIncome", grossCents: 1_500_00 },
      { sourceId: "capitalGains", label: "capitalGains", category: "capitalGains", grossCents: 300_00 },
    ]);
  });

  it("omits a zero-gross source (accrued interest) from the bands but keeps it in the rollup", () => {
    // An interest booking carries only a taxable base (cash already in the balance) — it
    // taxes, but there is no cash to draw a band for.
    const flows = buildFlows(
      [src("p1", 0, "ordinaryIncome", { taxableCents: 40_00, sourceId: "interest:p1", label: "Interest" })],
      0,
      0,
      0,
      {},
    );
    expect(flows.incomeSources).toEqual([]);
    expect(flows.incomeByCategoryCents).toEqual({ ordinaryIncome: 0 });
  });

  it("surfaces a liquid-buffer drawdown as its own savingsDrawdown source, out of the taxable rollup", () => {
    const flows = buildFlows(
      [src("p1", 2_000_00, "governmentRetirementBenefit", { sourceId: "benefit:p1", label: "Government benefit" })],
      0,
      3_000_00,
      0,
      {},
      1_000_00, // savings covered the $1,000 gap this month
    );
    // The drawdown is NOT taxable income: absent from the category rollup and the total…
    expect(flows.incomeByCategoryCents).toEqual({ governmentRetirementBenefit: 2_000_00 });
    expect(flows.totalIncomeCents).toBe(2_000_00);
    // …but present as its own band, so "living off savings" is visible, not zero income.
    expect(flows.incomeSources).toContainEqual({
      sourceId: SAVINGS_DRAWDOWN_SOURCE_ID,
      label: "Savings drawdown",
      category: "savingsDrawdown",
      grossCents: 1_000_00,
    });
  });

  it("adds no drawdown band when savings covered nothing", () => {
    const flows = buildFlows([src("p1", 5_000_00, "wages", { sourceId: "job:a", label: "Job A" })], 0, 0, 0, {}, 0);
    expect(flows.incomeSources.some((s) => s.category === "savingsDrawdown")).toBe(false);
  });
});
