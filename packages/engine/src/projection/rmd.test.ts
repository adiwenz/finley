import { describe, it, expect } from "vitest";
import { Account, type TaxTreatment } from "../account";
import { dollarsToCents } from "../cashFlowSeries";
import { nullJurisdiction, type Jurisdiction } from "../jurisdiction";
import { simulateHousehold, type HouseholdSimInput, type Person } from "./simulate";

/** A non-compounding account so balances move only by RMD withdrawal/deposit. */
function account(id: string, taxTreatment: TaxTreatment, dollars: number, liquid = false): Account {
  return new Account({
    id,
    ownerId: "p1",
    liquid,
    taxTreatment,
    openingBalanceCents: dollarsToCents(dollars),
    initialAnnualRate: 0,
  });
}

/** Surplus idles in the liquid cash account, so an RMD's net take-home lands there. */
function baseInput(
  person: Person,
  accounts: Account[],
  overrides: Partial<HouseholdSimInput> = {},
): HouseholdSimInput {
  return {
    horizonMonths: 12,
    annualInflationRate: 0,
    startYear: 2026,
    persons: [person],
    accounts,
    incomeSeries: [],
    expenseSeries: [],
    ...overrides,
  };
}

/** Stub: 10% of the pre-tax balance once the holder reaches 73; no tax. */
const rmdStub: Jurisdiction = {
  id: "rmd-stub",
  computeTaxCents: () => 0,
  requiredMinimumDistributionCents: (balance, ctx) =>
    ctx.age >= 73 ? Math.round(balance / 10) : 0,
};

const born73In2026: Person = { id: "p1", name: "You", birthYear: 1953 };

describe("Required Minimum Distributions (§5.4)", () => {
  it("forces the required amount out of pre-tax and into the taxable surplus, conserving net worth", () => {
    const series = simulateHousehold(
      baseInput(born73In2026, [
        account("pretax", "preTax", 100_000),
        account("cash", "taxable", 0, true),
      ]),
      rmdStub,
    );
    // At month 1 (2026, age 73): 10% of $100k = $10k moves pre-tax → cash.
    expect(series.months[1].accountBalancesCents["pretax"]).toBe(dollarsToCents(90_000));
    expect(series.months[1].accountBalancesCents["cash"]).toBe(dollarsToCents(10_000));
    // Tax-free stub → net worth unchanged, only relocated.
    expect(series.months[1].netWorthNominalCents).toBe(dollarsToCents(100_000));
  });

  it("fires exactly once per calendar year, not every month", () => {
    const series = simulateHousehold(
      baseInput(born73In2026, [
        account("pretax", "preTax", 100_000),
        account("cash", "taxable", 0, true),
      ]),
      rmdStub,
    );
    // No further draw between the year's single trigger (month 1) and the next (month 12).
    expect(series.months[11].accountBalancesCents["pretax"]).toBe(dollarsToCents(90_000));
    expect(series.months[11].accountBalancesCents["cash"]).toBe(dollarsToCents(10_000));
    // Month 12 (2027, age 74): a second RMD of 10% of the remaining $90k = $9k.
    expect(series.months[12].accountBalancesCents["pretax"]).toBe(dollarsToCents(81_000));
    expect(series.months[12].accountBalancesCents["cash"]).toBe(dollarsToCents(19_000));
  });

  it("draws from pre-tax accounts only — Roth/HSA/taxable are exempt", () => {
    const series = simulateHousehold(
      baseInput(born73In2026, [
        account("pretax", "preTax", 100_000),
        account("roth", "roth", 50_000),
        account("cash", "taxable", 0, true),
      ]),
      rmdStub,
    );
    expect(series.months[1].accountBalancesCents["pretax"]).toBe(dollarsToCents(90_000));
    expect(series.months[1].accountBalancesCents["roth"]).toBe(dollarsToCents(50_000));
    expect(series.months[1].accountBalancesCents["cash"]).toBe(dollarsToCents(10_000));
  });

  it("does not fire before the holder reaches the start age", () => {
    const tooYoung: Person = { id: "p1", name: "You", birthYear: 1970 }; // 56 in 2026
    const series = simulateHousehold(
      baseInput(tooYoung, [
        account("pretax", "preTax", 100_000),
        account("cash", "taxable", 0, true),
      ]),
      rmdStub,
    );
    expect(series.months[12].accountBalancesCents["pretax"]).toBe(dollarsToCents(100_000));
    expect(series.months[12].accountBalancesCents["cash"]).toBe(0);
  });

  it("null jurisdiction: no RMD seam → pre-tax balances are left untouched", () => {
    const series = simulateHousehold(
      baseInput(born73In2026, [
        account("pretax", "preTax", 100_000),
        account("cash", "taxable", 0, true),
      ]),
      nullJurisdiction,
    );
    expect(series.months[12].accountBalancesCents["pretax"]).toBe(dollarsToCents(100_000));
    expect(series.months[12].accountBalancesCents["cash"]).toBe(0);
  });
});
