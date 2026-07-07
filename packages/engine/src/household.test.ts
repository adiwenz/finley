import { describe, it, expect } from "vitest";
import { simulateHousehold, type Person } from "./projection";
import { Account } from "./account";
import { CashFlowSeries, dollarsToCents } from "./cashFlowSeries";
import { nullJurisdiction } from "./jurisdiction";

function makePerson(id = "p1", name = "Alice"): Person {
  return { id, name };
}

function makeInvestmentAccount(openingCents: number, annualRate: number): Account {
  return new Account({
    id: "investment",
    ownerId: "p1",
    liquid: true,
    taxTreatment: "taxable",
    openingBalanceCents: openingCents,
    initialAnnualRate: annualRate,
  });
}

function monthlyIncome(monthlyCents: number): CashFlowSeries {
  return new CashFlowSeries(0, monthlyCents, { type: "fixed" }, { baselineUnit: "monthly" });
}

function monthlyExpense(monthlyCents: number): CashFlowSeries {
  return new CashFlowSeries(0, monthlyCents, { type: "fixed" }, { baselineUnit: "monthly" });
}

describe("simulateHousehold", () => {
  it("month 0 is the opening balance, unchanged", () => {
    const acc = makeInvestmentAccount(dollarsToCents(10000), 0.07);
    const series = simulateHousehold(
      {
        horizonMonths: 12,
        annualInflationRate: 0.03,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [],
        expenseSeries: [],
      },
      nullJurisdiction,
    );
    expect(series.months[0].netWorthNominalCents).toBe(dollarsToCents(10000));
    expect(series.months[0].accountBalancesCents["investment"]).toBe(dollarsToCents(10000));
  });

  it("produces horizonMonths+1 data points", () => {
    const acc = makeInvestmentAccount(0, 0.07);
    const series = simulateHousehold(
      { horizonMonths: 24, annualInflationRate: 0.03, persons: [], accounts: [acc], incomeSeries: [], expenseSeries: [] },
      nullJurisdiction,
    );
    expect(series.months.length).toBe(25);
  });

  it("net cash flow (income - expense) accumulates in the liquid account each month", () => {
    // $3000/mo income, $2000/mo expense → $1000/mo net flow, 0% return
    const acc = makeInvestmentAccount(0, 0);
    const series = simulateHousehold(
      {
        horizonMonths: 12,
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [{ series: monthlyIncome(dollarsToCents(3000)), ownerId: "p1" }],
        expenseSeries: [{ series: monthlyExpense(dollarsToCents(2000)), ownerId: "p1" }],
      },
      nullJurisdiction,
    );
    // After 12 months of $1000/mo net flow at 0% return: $12,000
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(12000));
  });

  it("asset account compounds at preciseMonthlyRate, no cash flow", () => {
    const acc = makeInvestmentAccount(dollarsToCents(10000), 0.07);
    const series = simulateHousehold(
      {
        horizonMonths: 120,
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [],
        expenseSeries: [],
      },
      nullJurisdiction,
    );
    // $10k @ 7% for 10 years ≈ $19,671.51; integer-cents rounding within a dime
    expect(Math.abs(series.months[120].netWorthNominalCents - dollarsToCents(19671.51))).toBeLessThanOrEqual(10);
  });

  it("negative net worth (expenses > income) renders below zero", () => {
    const acc = makeInvestmentAccount(0, 0);
    const series = simulateHousehold(
      {
        horizonMonths: 6,
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [{ series: monthlyIncome(dollarsToCents(1000)), ownerId: "p1" }],
        expenseSeries: [{ series: monthlyExpense(dollarsToCents(2000)), ownerId: "p1" }],
      },
      nullJurisdiction,
    );
    expect(series.months[6].netWorthNominalCents).toBeLessThan(0);
  });

  it("real net worth < nominal when inflation > 0", () => {
    const acc = makeInvestmentAccount(dollarsToCents(10000), 0);
    const series = simulateHousehold(
      {
        horizonMonths: 24,
        annualInflationRate: 0.03,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [],
        expenseSeries: [],
      },
      nullJurisdiction,
    );
    expect(series.months[24].netWorthRealCents).toBeLessThan(series.months[24].netWorthNominalCents);
  });

  it("all monetary values are integer cents", () => {
    const acc = makeInvestmentAccount(dollarsToCents(10000), 0.07);
    const series = simulateHousehold(
      {
        horizonMonths: 12,
        annualInflationRate: 0.03,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [{ series: monthlyIncome(dollarsToCents(5000)), ownerId: "p1" }],
        expenseSeries: [{ series: monthlyExpense(dollarsToCents(3500)), ownerId: "p1" }],
      },
      nullJurisdiction,
    );
    for (const m of series.months) {
      expect(Number.isInteger(m.netWorthNominalCents)).toBe(true);
      expect(Number.isInteger(m.netWorthRealCents)).toBe(true);
    }
  });

  it("account with rate change: applies new rate from that month forward", () => {
    // Start $10k, 7% for 12 months, then switch to 0%
    const acc = makeInvestmentAccount(dollarsToCents(10000), 0.07);
    acc.addRateChange(12, 0);

    const series = simulateHousehold(
      {
        horizonMonths: 24,
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [],
        expenseSeries: [],
      },
      nullJurisdiction,
    );

    // After 12 months at 7%, balance should be > $10k
    const balAt12 = series.months[12].netWorthNominalCents;
    expect(balAt12).toBeGreaterThan(dollarsToCents(10000));

    // After 12 more months at 0%, balance unchanged
    expect(series.months[24].netWorthNominalCents).toBe(balAt12);
  });

  it("one-time transfer is applied before compounding in its month", () => {
    // $0 opening, 0% return, $5000 influx at month 3
    const acc = makeInvestmentAccount(0, 0);
    acc.addTransfer({ month: 3, amountCents: dollarsToCents(5000) });

    const series = simulateHousehold(
      {
        horizonMonths: 4,
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [],
        expenseSeries: [],
      },
      nullJurisdiction,
    );

    expect(series.months[2].netWorthNominalCents).toBe(0);
    expect(series.months[3].netWorthNominalCents).toBe(dollarsToCents(5000));
    expect(series.months[4].netWorthNominalCents).toBe(dollarsToCents(5000));
  });
});
