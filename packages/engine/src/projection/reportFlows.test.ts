import { describe, expect, it } from "vitest";
import { buildFlows } from "./reportFlows";
import type { IncomeSourceMonth } from "./waterfall";

const src = (
  ownerId: string,
  grossCents: number,
  taxCategory: IncomeSourceMonth["taxCategory"],
): IncomeSourceMonth => ({ ownerId, grossCents, taxCategory });

describe("buildFlows", () => {
  it("buckets gross income by tax category and sums the total", () => {
    const flows = buildFlows(
      [src("p1", 5_000_00, "wages"), src("p1", 1_000_00, "ordinaryIncome"), src("p2", 2_000_00, "wages")],
      0,
      0,
    );
    expect(flows.incomeByCategoryCents).toEqual({ wages: 7_000_00, ordinaryIncome: 1_000_00 });
    expect(flows.totalIncomeCents).toBe(8_000_00);
  });

  it("surfaces the government-retirement-benefit slice as its own convenience field", () => {
    const flows = buildFlows(
      [src("p1", 2_500_00, "governmentRetirementBenefit"), src("p1", 4_000_00, "wages")],
      0,
      0,
    );
    expect(flows.governmentRetirementBenefitCents).toBe(2_500_00);
  });

  it("reports 0 government retirement benefit when no source carries that category", () => {
    const flows = buildFlows([src("p1", 4_000_00, "wages")], 0, 0);
    expect(flows.governmentRetirementBenefitCents).toBe(0);
  });

  it("passes expenses and liability payments straight through", () => {
    const flows = buildFlows([], 3_200_00, 1_800_00);
    expect(flows.expensesCents).toBe(3_200_00);
    expect(flows.liabilityPaymentsCents).toBe(1_800_00);
  });

  it("yields empty buckets and zero totals for a month with no income", () => {
    const flows = buildFlows([], 0, 0);
    expect(flows.incomeByCategoryCents).toEqual({});
    expect(flows.totalIncomeCents).toBe(0);
    expect(flows.governmentRetirementBenefitCents).toBe(0);
  });
});
