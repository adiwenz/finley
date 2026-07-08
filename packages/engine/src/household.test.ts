import { describe, it, expect } from "vitest";
import { simulateHousehold, type Person } from "./projection";
import { Account } from "./account";
import { Liability, SYNTHETIC_CARD_ID } from "./liability";
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

describe("simulateHousehold — liabilities & shortfall cascade (§5.1, §3)", () => {
  it("month 0: net worth = assets − liabilities at opening balances", () => {
    const acc = makeInvestmentAccount(dollarsToCents(10_000), 0);
    const loan = new Liability({
      id: "auto",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(5_000),
      apr: 0,
      termMonths: 60,
    });
    const series = simulateHousehold(
      {
        horizonMonths: 1,
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [],
        expenseSeries: [],
        liabilities: [loan],
      },
      nullJurisdiction,
    );
    expect(series.months[0].netWorthNominalCents).toBe(dollarsToCents(5_000));
    expect(series.months[0].liabilityBalancesCents["auto"]).toBe(dollarsToCents(5_000));
  });

  it("amortizing loan balance decreases each month and reaches ~$0 by end of term", () => {
    const acc = makeInvestmentAccount(dollarsToCents(50_000), 0);
    const loan = new Liability({
      id: "car",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(10_000),
      apr: 0.06,
      termMonths: 12,
    });
    const series = simulateHousehold(
      {
        horizonMonths: 12,
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [],
        expenseSeries: [],
        liabilities: [loan],
      },
      nullJurisdiction,
    );
    const bal12 = series.months[12].liabilityBalancesCents["car"];
    expect(bal12).toBeLessThan(dollarsToCents(100)); // nearly paid off (amortization rounding only)
    expect(bal12).toBeGreaterThanOrEqual(0);
  });

  it("amortizing loan is driven off a precomputed schedule → EXACTLY 0 at term, and stays 0", () => {
    const acc = makeInvestmentAccount(dollarsToCents(50_000), 0);
    const loan = new Liability({
      id: "car",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(10_000),
      apr: 0.06,
      termMonths: 12,
    });
    const series = simulateHousehold(
      {
        horizonMonths: 18, // run past the 12-month term
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [],
        expenseSeries: [],
        liabilities: [loan],
      },
      nullJurisdiction,
    );
    // Owed every month up to the term, then exactly retired — no rounding tail.
    expect(series.months[11].liabilityBalancesCents["car"]).toBeGreaterThan(0);
    expect(series.months[12].liabilityBalancesCents["car"]).toBe(0);
    expect(series.months[18].liabilityBalancesCents["car"]).toBe(0);
  });

  it("shortfall routes to synthetic card when no cards provided; liquid stays ≥ 0", () => {
    const acc = makeInvestmentAccount(0, 0);
    const series = simulateHousehold(
      {
        horizonMonths: 3,
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [{ series: monthlyIncome(dollarsToCents(2_000)), ownerId: "p1" }],
        expenseSeries: [{ series: monthlyExpense(dollarsToCents(2_500)), ownerId: "p1" }],
        liabilities: [],
      },
      nullJurisdiction,
    );
    expect(series.months[3].accountBalancesCents["investment"]).toBeGreaterThanOrEqual(0);
    expect(series.months[3].liabilityBalancesCents[SYNTHETIC_CARD_ID]).toBeGreaterThan(0);
    expect(series.months[3].isInsolvent).toBe(false); // synthetic card is unlimited
  });

  it("isInsolvent=true when credit limit cannot cover the full deficit", () => {
    const acc = makeInvestmentAccount(0, 0);
    const card = new Liability({
      id: "card",
      ownerId: "p1",
      kind: "creditCard",
      openingBalanceCents: 0,
      apr: 0.22,
      creditLimitCents: dollarsToCents(100),
    });
    const series = simulateHousehold(
      {
        horizonMonths: 1,
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [{ series: monthlyIncome(dollarsToCents(1_000)), ownerId: "p1" }],
        expenseSeries: [{ series: monthlyExpense(dollarsToCents(2_000)), ownerId: "p1" }],
        liabilities: [card],
      },
      nullJurisdiction,
    );
    expect(series.months[1].isInsolvent).toBe(true);
  });

  it("proportional transfer: −0.2 fraction removes 20% of balance", () => {
    const acc = makeInvestmentAccount(dollarsToCents(10_000), 0);
    acc.addTransfer({ month: 1, proportionalFraction: -0.2 });
    const series = simulateHousehold(
      {
        horizonMonths: 2,
        annualInflationRate: 0,
        persons: [],
        accounts: [acc],
        incomeSeries: [],
        expenseSeries: [],
        liabilities: [],
      },
      nullJurisdiction,
    );
    expect(series.months[1].accountBalancesCents["investment"]).toBe(dollarsToCents(8_000));
    expect(series.months[2].accountBalancesCents["investment"]).toBe(dollarsToCents(8_000));
  });

  it("amountCents + proportionalFraction combine: both applied in same transfer", () => {
    const acc = makeInvestmentAccount(dollarsToCents(10_000), 0);
    // Add $1,000 + remove 10% = +1000 + (-1000) = net $0 change
    acc.addTransfer({ month: 1, amountCents: dollarsToCents(1_000), proportionalFraction: -0.1 });
    const series = simulateHousehold(
      {
        horizonMonths: 1,
        annualInflationRate: 0,
        persons: [],
        accounts: [acc],
        incomeSeries: [],
        expenseSeries: [],
        liabilities: [],
      },
      nullJurisdiction,
    );
    expect(series.months[1].accountBalancesCents["investment"]).toBe(dollarsToCents(10_000));
  });

  it("liability lump-sum transfer reduces the owed balance in its month (before interest)", () => {
    // Two identical $10k / 5% / 60mo loans; one gets a −$3,000 payoff at month 12.
    // A big non-liquid asset keeps every scheduled payment financeable, so the
    // only difference between the runs is the transfer.
    const makeLoan = (id: string) =>
      new Liability({
        id,
        ownerId: "p1",
        kind: "auto",
        openingBalanceCents: dollarsToCents(10_000),
        apr: 0.05,
        termMonths: 60,
      });
    const base = {
      horizonMonths: 60,
      annualInflationRate: 0,
      persons: [makePerson()],
      incomeSeries: [],
      expenseSeries: [],
    } as const;

    const withoutLoan = makeLoan("auto");
    const without = simulateHousehold(
      { ...base, accounts: [makeInvestmentAccount(dollarsToCents(1_000_000), 0)], liabilities: [withoutLoan] },
      nullJurisdiction,
    );

    const withLoan = makeLoan("auto");
    withLoan.addTransfer({ month: 12, amountCents: -dollarsToCents(3_000) });
    const withTransfer = simulateHousehold(
      { ...base, accounts: [makeInvestmentAccount(dollarsToCents(1_000_000), 0)], liabilities: [withLoan] },
      nullJurisdiction,
    );

    // At month 12 the with-transfer balance is ~$3,000 lower (plus one month's
    // interest on the $3,000, since the transfer lands before interest accrues).
    const delta =
      without.months[12].liabilityBalancesCents["auto"] -
      withTransfer.months[12].liabilityBalancesCents["auto"];
    expect(delta).toBeGreaterThanOrEqual(dollarsToCents(3_000));
    expect(delta).toBeLessThanOrEqual(dollarsToCents(3_020));
  });

  it("liability lump-sum transfer retires the loan early (shorten-term), payment unchanged", () => {
    const firstZeroMonth = (series: ReturnType<typeof simulateHousehold>, id: string) =>
      series.months.findIndex((m) => m.liabilityBalancesCents[id] === 0);

    const makeLoan = () =>
      new Liability({
        id: "auto",
        ownerId: "p1",
        kind: "auto",
        openingBalanceCents: dollarsToCents(10_000),
        apr: 0.05,
        termMonths: 60,
      });
    const base = {
      horizonMonths: 60,
      annualInflationRate: 0,
      persons: [makePerson()],
      accounts: [makeInvestmentAccount(dollarsToCents(1_000_000), 0)],
      incomeSeries: [],
      expenseSeries: [],
    } as const;

    const without = simulateHousehold({ ...base, liabilities: [makeLoan()] }, nullJurisdiction);

    const withLoan = makeLoan();
    withLoan.addTransfer({ month: 12, amountCents: -dollarsToCents(3_000) });
    const withTransfer = simulateHousehold({ ...base, liabilities: [withLoan] }, nullJurisdiction);

    const paidOffWithout = firstZeroMonth(without, "auto");
    const paidOffWith = firstZeroMonth(withTransfer, "auto");

    expect(paidOffWithout).toBe(60); // untouched loan retires exactly at term
    expect(paidOffWith).toBeGreaterThan(0);
    expect(paidOffWith).toBeLessThan(paidOffWithout); // extra principal → earlier payoff
    // Never over-pays: the balance is retired to exactly 0 and stays there.
    expect(withTransfer.months[60].liabilityBalancesCents["auto"]).toBe(0);
  });

  it("paired transfer (Account outflow + Liability payoff) conserves net worth — no free debt reduction", () => {
    // A DebtPayoffEvent is modeled as two transfers: cash leaves a liquid account
    // AND the owed balance drops by the same amount. At 0% APR, both the paired
    // lump sum AND the ordinary scheduled payments are net-worth-neutral (cash
    // becomes debt reduction, dollar for dollar), so net worth is EXACTLY constant
    // — the $4k payoff at month 6 does not create value out of thin air.
    const acc = makeInvestmentAccount(dollarsToCents(50_000), 0);
    acc.addTransfer({ month: 6, amountCents: -dollarsToCents(4_000) });
    const loan = new Liability({
      id: "auto",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(10_000),
      apr: 0, // 0% APR isolates the transfer from interest effects
      termMonths: 120,
    });
    loan.addTransfer({ month: 6, amountCents: -dollarsToCents(4_000) });

    const series = simulateHousehold(
      {
        horizonMonths: 6,
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [],
        expenseSeries: [],
        liabilities: [loan],
      },
      nullJurisdiction,
    );

    // $50k assets − $10k owed = $40k, held constant every month including the payoff.
    for (const m of series.months) {
      expect(m.netWorthNominalCents).toBe(dollarsToCents(40_000));
    }
  });

  it("credit card in cascade reduces deficit; remaining overflows to insolvent", () => {
    // $500 monthly shortfall; card limit $300 → $200 unfinanceable
    const acc = makeInvestmentAccount(0, 0);
    const card = new Liability({
      id: "visa",
      ownerId: "p1",
      kind: "creditCard",
      openingBalanceCents: 0,
      apr: 0.20,
      creditLimitCents: dollarsToCents(300),
    });
    const series = simulateHousehold(
      {
        horizonMonths: 1,
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [{ series: monthlyIncome(dollarsToCents(1_000)), ownerId: "p1" }],
        expenseSeries: [{ series: monthlyExpense(dollarsToCents(1_500)), ownerId: "p1" }],
        liabilities: [card],
      },
      nullJurisdiction,
    );
    // Card fills to limit; still $200 deficit → insolvent
    expect(series.months[1].liabilityBalancesCents["visa"]).toBeGreaterThan(0);
    expect(series.months[1].isInsolvent).toBe(true);
  });
});
