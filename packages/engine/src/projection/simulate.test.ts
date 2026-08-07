import { describe, it, expect } from "vitest";
import { simulateHousehold } from "./simulate";
import { dollarsToCents } from "../money/cashFlowSeries";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import {
  makePerson,
  makeInvestmentAccount,
  monthlyIncome,
  monthlyExpense,
} from "./simulate.testSupport";

describe("simulateHousehold", () => {
  it("opening is the pre-flow snapshot; months[0] is a processed month that compounds", () => {
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
    // `opening` is "now" — the balance before any flow runs, no compounding applied.
    expect(series.opening.netWorthNominalCents).toBe(dollarsToCents(10000));
    expect(series.opening.accountBalancesCents["investment"]).toBe(dollarsToCents(10000));
    // months[0] is the FIRST processed month: one month of 7% compounding has run, so it is
    // strictly above the opening balance — no longer a flow-free snapshot.
    expect(series.months[0].month).toBe(0);
    expect(series.months[0].accountBalancesCents["investment"]).toBeGreaterThan(dollarsToCents(10000));
  });

  it("deflates real net worth by ELAPSED months, so months[11] is a full year out", () => {
    // A flat, non-compounding balance: nominal never moves, so `netWorthRealCents` isolates
    // the deflator. `months[m]` is the END of month m — m+1 months from now — so months[11]
    // is a full year of inflation away, not eleven twelfths of one. Indexing the deflator on
    // `month` instead understates it by exactly one month, silently, at every point.
    const acc = makeInvestmentAccount(dollarsToCents(10000), 0);
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
    const nominal = dollarsToCents(10000);
    // "Now" has nothing behind it: real equals nominal.
    expect(series.opening.netWorthRealCents).toBe(nominal);
    expect(series.months[11].netWorthRealCents).toBe(Math.round(nominal / 1.03));
    expect(series.months[0].netWorthRealCents).toBe(Math.round(nominal / Math.pow(1.03, 1 / 12)));
  });

  it("produces one processed month per horizon month, plus a separate opening", () => {
    const acc = makeInvestmentAccount(0, 0.07);
    const series = simulateHousehold(
      { horizonMonths: 24, annualInflationRate: 0.03, persons: [], accounts: [acc], incomeSeries: [], expenseSeries: [] },
      nullJurisdiction,
    );
    // Every slot is a processed month now; the pre-flow snapshot rides `opening` instead of
    // occupying months[0], so the count drops from horizonMonths+1 to horizonMonths.
    expect(series.months.length).toBe(24);
    expect(series.months[23].month).toBe(23);
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
    // After 12 months of $1000/mo net flow at 0% return: $12,000. The 12th flow-month is the
    // end of year 0 — months[11] — now that month 0 is processed rather than opening.
    expect(series.months[11].netWorthNominalCents).toBe(dollarsToCents(12000));
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
    // $10k @ 7% for 10 years ≈ $19,671.51; integer-cents rounding within a dime. 120
    // compoundings land at months[119] (the 120th processed month).
    expect(Math.abs(series.months[119].netWorthNominalCents! - dollarsToCents(19671.51))).toBeLessThanOrEqual(10);
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
    expect(series.months[5].netWorthNominalCents).toBeLessThan(0);
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
    expect(series.months[23].netWorthRealCents!).toBeLessThan(series.months[23].netWorthNominalCents!);
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

    // After 12 months at 7% (months[0..11], the whole of year 0), balance should be > $10k.
    const balAt12 = series.months[11].netWorthNominalCents;
    expect(balAt12).toBeGreaterThan(dollarsToCents(10000));

    // After 12 more months at 0%, balance unchanged
    expect(series.months[23].netWorthNominalCents).toBe(balAt12);
  });

  it("one-time transfer is applied before compounding in its month", () => {
    // $0 opening, 0% return, $5000 influx at month 3
    const acc = makeInvestmentAccount(0, 0);
    acc.addTransfer({ month: 3, amountCents: dollarsToCents(5000) });

    const series = simulateHousehold(
      {
        horizonMonths: 5,
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [],
        expenseSeries: [],
      },
      nullJurisdiction,
    );

    // The transfer is keyed to absolute month 3, so it still lands in months[3] — an
    // event's month is unchanged; only the opening-vs-processed split moved.
    expect(series.months[2].netWorthNominalCents).toBe(0);
    expect(series.months[3].netWorthNominalCents).toBe(dollarsToCents(5000));
    expect(series.months[4].netWorthNominalCents).toBe(dollarsToCents(5000));
  });

  describe("survivalOnly early-exit", () => {
    it("a plan that never fails runs the full horizon, identical to a full sim", () => {
      // Income exceeds expense every month, so no month is insolvent: survivalOnly has
      // nothing to short-circuit and must run every month the full sim runs.
      const acc = makeInvestmentAccount(dollarsToCents(10_000), 0);
      const input = {
        horizonMonths: 24,
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [{ series: monthlyIncome(dollarsToCents(4_000)), ownerId: "p1" }],
        expenseSeries: [{ series: monthlyExpense(dollarsToCents(2_000)), ownerId: "p1" }],
      };
      const full = simulateHousehold(input, nullJurisdiction);
      const lean = simulateHousehold(input, nullJurisdiction, { survivalOnly: true });
      expect(lean.status).toBe("ran-to-horizon");
      expect(lean.months.length).toBe(full.months.length);
      expect(lean.months.every((m) => !m.isInsolvent)).toBe(true);
    });

    it("stops at the first insolvent month, where the full sim runs the whole horizon", () => {
      // A $30k/mo deficit with no assets exhausts the synthetic card and trips insolvency
      // early. The full sim carries on nulling net worth to the horizon; survivalOnly has its
      // answer at the first insolvent month and stops there.
      const acc = makeInvestmentAccount(0, 0);
      const input = {
        horizonMonths: 6,
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [],
        expenseSeries: [{ series: monthlyExpense(dollarsToCents(30_000)), ownerId: "p1" }],
      };
      const full = simulateHousehold(input, nullJurisdiction);
      const lean = simulateHousehold(input, nullJurisdiction, { survivalOnly: true });
      const firstInsolvent = full.months.findIndex((m) => m.isInsolvent);
      expect(firstInsolvent).toBeGreaterThanOrEqual(0);
      expect(full.months.length).toBe(6);
      expect(lean.months.length).toBe(firstInsolvent + 1);
      expect(lean.months[lean.months.length - 1].isInsolvent).toBe(true);
    });
  });
});
