import { describe, it, expect } from "vitest";
import { simulateHousehold, type SimPerson } from "./simulate";
import { SimAccount, CAPITAL_GAINS_TAX_PROFILE, PRE_TAX_TAX_PROFILE } from "../simAccount";
import {
  AmortizingLoan,
  RevolvingCard,
  SYNTHETIC_CARD_ID,
  SYNTHETIC_CARD_CREDIT_LIMIT_CENTS,
} from "../liability";
import { SimCashFlowSeries, dollarsToCents, preciseMonthlyRate } from "../cashFlowSeries";
import { nullJurisdiction } from "../jurisdiction";

function makePerson(id = "p1", name = "Alice"): SimPerson {
  return { id, name };
}

function makeInvestmentAccount(openingCents: number, annualRate: number): SimAccount {
  return new SimAccount({
    id: "investment",
    ownerId: "p1",
    liquid: true,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    openingBalanceCents: openingCents,
    initialAnnualRate: annualRate,
  });
}

function monthlyIncome(monthlyCents: number): SimCashFlowSeries {
  return new SimCashFlowSeries(0, monthlyCents, { type: "fixed" }, { baselineUnit: "monthly" });
}

function monthlyExpense(monthlyCents: number): SimCashFlowSeries {
  return new SimCashFlowSeries(0, monthlyCents, { type: "fixed" }, { baselineUnit: "monthly" });
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
    expect(Math.abs(series.months[120].netWorthNominalCents! - dollarsToCents(19671.51))).toBeLessThanOrEqual(10);
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
    expect(series.months[24].netWorthRealCents!).toBeLessThan(series.months[24].netWorthNominalCents!);
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
    const loan = new AmortizingLoan({
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
    const loan = new AmortizingLoan({
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
    const loan = new AmortizingLoan({
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

  it("a loan that originates mid-timeline is absent before its startMonth", () => {
    const acc = makeInvestmentAccount(dollarsToCents(50_000), 0);
    const loan = new AmortizingLoan({
      id: "car",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(12_000),
      startMonth: 24,
      apr: 0,
      termMonths: 12,
    });
    const series = simulateHousehold(
      {
        horizonMonths: 40,
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [],
        expenseSeries: [],
        liabilities: [loan],
      },
      nullJurisdiction,
    );
    const bal = (m: number) => series.months[m].liabilityBalancesCents["car"];
    // 0 before origination, opening balance AT origination, no payment that month.
    expect(bal(0)).toBe(0);
    expect(bal(23)).toBe(0);
    expect(bal(24)).toBe(dollarsToCents(12_000));
    // Amortizes only after origination (first payment at startMonth + 1).
    expect(bal(25)).toBe(dollarsToCents(11_000));
    expect(bal(36)).toBe(0); // retired exactly one term (12 months) later
    expect(bal(40)).toBe(0);
    // Net worth reflects the loan only from origination onward.
    expect(series.months[23].netWorthNominalCents).toBe(dollarsToCents(50_000));
    expect(series.months[24].netWorthNominalCents).toBe(dollarsToCents(38_000));
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
    // A modest shortfall stays well under the synthetic card's finite limit, so the
    // plan is still financeable (not yet insolvent).
    expect(series.months[3].liabilityBalancesCents[SYNTHETIC_CARD_ID]).toBeLessThan(
      SYNTHETIC_CARD_CREDIT_LIMIT_CENTS,
    );
    expect(series.months[3].isInsolvent).toBe(false);
  });

  it("isInsolvent=true once a sustained shortfall exhausts the synthetic card's limit (#36)", () => {
    // No user card entered → synthetic card with a finite default limit. A large
    // monthly deficit ($30k/mo) with no liquid assets overruns the limit within a
    // few months, tripping the §5.1 terminal HARD-INFEASIBILITY flag instead of
    // borrowing without bound.
    const acc = makeInvestmentAccount(0, 0);
    const series = simulateHousehold(
      {
        horizonMonths: 6,
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [],
        expenseSeries: [{ series: monthlyExpense(dollarsToCents(30_000)), ownerId: "p1" }],
        liabilities: [],
      },
      nullJurisdiction,
    );
    // New borrowing is capped at the limit; the balance stays bounded near it
    // (interest can accrue on top, but it never runs away to millions the way an
    // unlimited card would).
    for (const m of series.months) {
      expect(m.liabilityBalancesCents[SYNTHETIC_CARD_ID] ?? 0).toBeLessThan(
        SYNTHETIC_CARD_CREDIT_LIMIT_CENTS * 1.1,
      );
    }
    // Once the deficit outruns all available credit, the plan is flagged insolvent.
    expect(series.months[6].isInsolvent).toBe(true);
    const firstInsolvent = series.months.find((m) => m.isInsolvent);
    expect(firstInsolvent).toBeDefined();
  });

  it("isInsolvent=true when credit limit cannot cover the full deficit", () => {
    const acc = makeInvestmentAccount(0, 0);
    const card = new RevolvingCard({
      id: "card",
      ownerId: "p1",
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

  it("net worth is null for every month AFTER the first insolvent one; the first keeps its value", () => {
    // A modest starting balance funds a couple of months, then a large sustained
    // deficit runs the plan insolvent — so there are solvent months, a first
    // insolvent month, and months beyond it. Net worth is a real number up to and
    // INCLUDING the first insolvent month (the honest "money runs out" point), then
    // null thereafter (the model has no fidelity once unfunded spending is dropped).
    const acc = makeInvestmentAccount(dollarsToCents(50_000), 0);
    const series = simulateHousehold(
      {
        horizonMonths: 12,
        annualInflationRate: 0.03,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [],
        expenseSeries: [{ series: monthlyExpense(dollarsToCents(30_000)), ownerId: "p1" }],
        liabilities: [],
      },
      nullJurisdiction,
    );
    const firstInsolvent = series.months.findIndex((m) => m.isInsolvent);
    expect(firstInsolvent).toBeGreaterThan(0); // there IS a solvent stretch first

    for (const m of series.months) {
      if (m.month <= firstInsolvent) {
        // Real value through the terminal (first insolvent) month.
        expect(m.netWorthNominalCents).not.toBeNull();
        expect(m.netWorthRealCents).not.toBeNull();
      } else {
        // Nulled from there on — the lines end at insolvency.
        expect(m.netWorthNominalCents).toBeNull();
        expect(m.netWorthRealCents).toBeNull();
      }
    }
    // isInsolvent itself is unaffected — still flagged per month, including nulled ones.
    expect(series.months[firstInsolvent].isInsolvent).toBe(true);
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
      new AmortizingLoan({
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
      new AmortizingLoan({
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
    const loan = new AmortizingLoan({
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
    const card = new RevolvingCard({
      id: "visa",
      ownerId: "p1",
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

  describe("liabilityPaymentRecords (v1-seam)", () => {
    it("every serviced payment is full/current through payoff, incl. the payoff month", () => {
      const acc = makeInvestmentAccount(dollarsToCents(100_000), 0);
      const loan = new AmortizingLoan({
        id: "car",
        ownerId: "p1",
        kind: "auto",
        openingBalanceCents: dollarsToCents(10_000),
        apr: 0.06,
        termMonths: 12,
      });
      const card = new RevolvingCard({
        id: "visa",
        ownerId: "p1",
        openingBalanceCents: dollarsToCents(1_000),
        apr: 0.2,
        creditLimitCents: dollarsToCents(5_000),
      });
      const series = simulateHousehold(
        {
          horizonMonths: 18, // run past the loan term to cover its payoff month
          annualInflationRate: 0,
          persons: [makePerson()],
          accounts: [acc],
          incomeSeries: [{ series: monthlyIncome(dollarsToCents(5_000)), ownerId: "p1" }],
          expenseSeries: [],
          liabilities: [loan, card],
        },
        nullJurisdiction,
      );

      // The payoff month pays less than the level payment but is still `full`.
      const loanPayoffMonth = series.months.findIndex(
        (m, i) => i > 0 && m.liabilityBalancesCents["car"] === 0,
      );
      expect(loanPayoffMonth).toBeGreaterThan(0);
      expect(series.months[loanPayoffMonth].liabilityPaymentRecords["car"]).toEqual({
        paymentStatus: "full",
        amountAppliedCents: expect.any(Number),
        loanStatus: "current",
      });

      // Across the whole run, nothing is ever partial/missed/delinquent, and every
      // record carries a positive applied amount (a real payment occurred).
      for (const month of series.months) {
        for (const rec of Object.values(month.liabilityPaymentRecords)) {
          expect(rec.paymentStatus).toBe("full");
          expect(rec.loanStatus).toBe("current");
          expect(rec.amountAppliedCents).toBeGreaterThan(0);
        }
      }
    });

    it("month 0 has no payment records; a due payment produces one", () => {
      const acc = makeInvestmentAccount(dollarsToCents(100_000), 0);
      const loan = new AmortizingLoan({
        id: "car",
        ownerId: "p1",
        kind: "auto",
        openingBalanceCents: dollarsToCents(10_000),
        apr: 0.06,
        termMonths: 12,
      });
      const series = simulateHousehold(
        {
          horizonMonths: 3,
          annualInflationRate: 0,
          persons: [makePerson()],
          accounts: [acc],
          incomeSeries: [{ series: monthlyIncome(dollarsToCents(5_000)), ownerId: "p1" }],
          expenseSeries: [],
          liabilities: [loan],
        },
        nullJurisdiction,
      );

      expect(series.months[0].liabilityPaymentRecords).toEqual({});
      // Month 1 charges the first scheduled payment → a full record with a
      // positive applied amount.
      const rec = series.months[1].liabilityPaymentRecords["car"];
      expect(rec.paymentStatus).toBe("full");
      expect(rec.amountAppliedCents).toBeGreaterThan(0);
    });

    it("a paid-off liability drops out of the records once nothing is due", () => {
      const acc = makeInvestmentAccount(dollarsToCents(100_000), 0);
      const loan = new AmortizingLoan({
        id: "car",
        ownerId: "p1",
        kind: "auto",
        openingBalanceCents: dollarsToCents(10_000),
        apr: 0,
        termMonths: 12,
      });
      const series = simulateHousehold(
        {
          horizonMonths: 18,
          annualInflationRate: 0,
          persons: [makePerson()],
          accounts: [acc],
          incomeSeries: [{ series: monthlyIncome(dollarsToCents(5_000)), ownerId: "p1" }],
          expenseSeries: [],
          liabilities: [loan],
        },
        nullJurisdiction,
      );
      // After the 12-month term the balance is 0 and no payment is due → no record.
      expect(series.months[12].liabilityBalancesCents["car"]).toBe(0);
      expect(series.months[13].liabilityPaymentRecords["car"]).toBeUndefined();
    });
  });
});

describe("simulateHousehold — §5.0 allocation waterfall (issue #7)", () => {
  const person: SimPerson = { id: "p1", name: "Alice" };

  function retirementAccount(): SimAccount {
    // A non-liquid pre-tax account — deferrals land here, but the surplus/idle
    // step never does (it targets the liquid account).
    return new SimAccount({
      id: "401k",
      ownerId: "p1",
      liquid: false,
      taxProfile: PRE_TAX_TAX_PROFILE,
      openingBalanceCents: 0,
      initialAnnualRate: 0,
    });
  }

  it("a plan-bearing job defers pre-tax into its retirement account each month", () => {
    const checking = makeInvestmentAccount(0, 0);
    const series = simulateHousehold(
      {
        horizonMonths: 3,
        annualInflationRate: 0,
        persons: [person],
        accounts: [checking, retirementAccount()],
        incomeSeries: [
          {
            series: monthlyIncome(dollarsToCents(5000)),
            ownerId: "p1",
            planDescriptor: { deferralFraction: 0.1, fundAccountId: "401k" },
          },
        ],
        expenseSeries: [],
      },
      nullJurisdiction,
    );
    // $500/mo deferred → $1500 after 3 months; take-home $4500/mo → $13,500 in checking.
    expect(series.months[3].accountBalancesCents["401k"]).toBe(dollarsToCents(1500));
    expect(series.months[3].accountBalancesCents["investment"]).toBe(dollarsToCents(13500));
  });

  it("the annual deferral cap is enforced across the calendar year (§5.4)", () => {
    // Wants to defer $5000/mo but the annual limit is $12,000 → capped mid-year,
    // and reset the next calendar year.
    const cappingJurisdiction = {
      id: "cap-test",
      computeTaxCents: () => 0,
      retirementDeferralLimitCents: () => dollarsToCents(12000),
    };
    const checking = makeInvestmentAccount(0, 0);
    const series = simulateHousehold(
      {
        horizonMonths: 24,
        annualInflationRate: 0,
        persons: [person],
        accounts: [checking, retirementAccount()],
        incomeSeries: [
          {
            series: monthlyIncome(dollarsToCents(5000)),
            ownerId: "p1",
            planDescriptor: { deferralFraction: 1.0, fundAccountId: "401k" },
          },
        ],
        expenseSeries: [],
      },
      cappingJurisdiction,
    );
    // Calendar year one is months 0–11 (ctx.year = startYear + floor(month/12));
    // deferrals in months 1–11 cap at $12,000 (vs. an uncapped 11×$5000 = $55,000).
    expect(series.months[11].accountBalancesCents["401k"]).toBe(dollarsToCents(12000));
    // Month 12 opens the next calendar year → the room resets; by month 23 a second
    // full $12,000 has been deferred → $24,000 cumulative.
    expect(series.months[23].accountBalancesCents["401k"]).toBe(dollarsToCents(24000));
  });

  it("the deferral cap is age-aware: an over-50 catch-up raises one person's limit (§5.4)", () => {
    // Base annual limit $12,000, plus a $3,000 catch-up from age 50. The seam is
    // called per person with that person's age, so only the older partner's cap lifts.
    const catchUpJurisdiction = {
      id: "catchup-test",
      computeTaxCents: () => 0,
      retirementDeferralLimitCents: (ctx: { year: number; age?: number }) =>
        dollarsToCents(12000) + (ctx.age !== undefined && ctx.age >= 50 ? dollarsToCents(3000) : 0),
    };
    // startYear defaults to 2026: born 1971 → age 55 (catch-up); born 1990 → age 36 (base).
    const older: SimPerson = { id: "p1", name: "Alice", birthYear: 1971 };
    const younger: SimPerson = { id: "p2", name: "Bob", birthYear: 1990 };
    const older401k = new SimAccount({
      id: "401k-a",
      ownerId: "p1",
      liquid: false,
      taxProfile: PRE_TAX_TAX_PROFILE,
      openingBalanceCents: 0,
      initialAnnualRate: 0,
    });
    const younger401k = new SimAccount({
      id: "401k-b",
      ownerId: "p2",
      liquid: false,
      taxProfile: PRE_TAX_TAX_PROFILE,
      openingBalanceCents: 0,
      initialAnnualRate: 0,
    });
    const checking = makeInvestmentAccount(0, 0);
    const series = simulateHousehold(
      {
        horizonMonths: 11,
        annualInflationRate: 0,
        persons: [older, younger],
        accounts: [checking, older401k, younger401k],
        incomeSeries: [
          {
            series: monthlyIncome(dollarsToCents(5000)),
            ownerId: "p1",
            planDescriptor: { deferralFraction: 1.0, fundAccountId: "401k-a" },
          },
          {
            series: monthlyIncome(dollarsToCents(5000)),
            ownerId: "p2",
            planDescriptor: { deferralFraction: 1.0, fundAccountId: "401k-b" },
          },
        ],
        expenseSeries: [],
      },
      catchUpJurisdiction,
    );
    // The over-50 partner caps at $15,000 (base + catch-up); the younger at $12,000.
    expect(series.months[11].accountBalancesCents["401k-a"]).toBe(dollarsToCents(15000));
    expect(series.months[11].accountBalancesCents["401k-b"]).toBe(dollarsToCents(12000));
  });

  it("routing income through the waterfall conserves net worth vs. the naive path", () => {
    // With no goals, no plan, and idle surplus, the waterfall must reproduce the
    // old 'net flow into the liquid account' behavior exactly (backward compat).
    const checking = makeInvestmentAccount(dollarsToCents(1000), 0);
    const series = simulateHousehold(
      {
        horizonMonths: 12,
        annualInflationRate: 0,
        persons: [person],
        accounts: [checking],
        incomeSeries: [{ series: monthlyIncome(dollarsToCents(3000)), ownerId: "p1" }],
        expenseSeries: [{ series: monthlyExpense(dollarsToCents(2000)), ownerId: "p1" }],
      },
      nullJurisdiction,
    );
    // $1000 opening + $1000/mo net for 12 months = $13,000.
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(13000));
  });

  it("surplus swept to an investment account instead of idling in liquid (lever 4)", () => {
    const checking = makeInvestmentAccount(0, 0);
    const brokerage = new SimAccount({
      id: "brokerage",
      ownerId: "p1",
      liquid: false,
      taxProfile: CAPITAL_GAINS_TAX_PROFILE,
      openingBalanceCents: 0,
      initialAnnualRate: 0,
    });
    const series = simulateHousehold(
      {
        horizonMonths: 6,
        annualInflationRate: 0,
        persons: [person],
        accounts: [checking, brokerage],
        incomeSeries: [{ series: monthlyIncome(dollarsToCents(2000)), ownerId: "p1" }],
        expenseSeries: [],
        surplusDestination: { kind: "swept", accountId: "brokerage" },
      },
      nullJurisdiction,
    );
    expect(series.months[6].accountBalancesCents["brokerage"]).toBe(dollarsToCents(12000));
    expect(series.months[6].accountBalancesCents["investment"]).toBe(0);
  });

  /** A rate-0 fund account so a goal's balance moves only by deposit/disposition. */
  function goalFund(id: string): SimAccount {
    return new SimAccount({
      id,
      ownerId: "p1",
      liquid: false,
      taxProfile: CAPITAL_GAINS_TAX_PROFILE,
      openingBalanceCents: 0,
      initialAnnualRate: 0,
    });
  }

  describe("goal disposition firing at maturity (§5.2, #28)", () => {
    // $2000/mo income, no expenses; the goal is funded $2000/mo and reaches its
    // $4000 target exactly at month 2 (its target date). Firing happens at the END
    // of the target month, so the month-2 snapshot still shows the fund AT target
    // (the goal reads as achieved) and the disposition takes effect from month 3.
    const goalScenario = (disposition: "spend" | "convertToEquity" | "retain") => ({
      horizonMonths: 4,
      annualInflationRate: 0,
      persons: [makePerson()],
      accounts: [makeInvestmentAccount(0, 0), goalFund("goal-x")],
      incomeSeries: [{ series: monthlyIncome(dollarsToCents(2000)), ownerId: "p1" }],
      expenseSeries: [],
      goals: [
        {
          id: "x",
          name: "Goal X",
          targetCents: dollarsToCents(4000),
          targetDate: 2,
          fundAccountId: "goal-x",
          priority: 0,
          disposition,
          scope: "shared" as const,
        },
      ],
    });

    it("`spend` consumes the fund at maturity — it leaves net worth and is not re-funded", () => {
      const series = simulateHousehold(goalScenario("spend"), nullJurisdiction);
      // Month 2 (target): the fund is shown AT target — the goal reads as achieved.
      expect(series.months[2].accountBalancesCents["goal-x"]).toBe(dollarsToCents(4000));
      expect(series.months[2].netWorthNominalCents).toBe(dollarsToCents(4000));
      // Month 3: the $4000 has been spent — gone from the fund and from net worth,
      // and NOT re-accumulated (this month's $2000 income idles in the liquid account).
      expect(series.months[3].accountBalancesCents["goal-x"]).toBe(0);
      expect(series.months[3].accountBalancesCents["investment"]).toBe(dollarsToCents(2000));
      expect(series.months[3].netWorthNominalCents).toBe(dollarsToCents(2000));
    });

    it("`convertToEquity` swaps the fund into an illiquid equity holding — net worth is conserved", () => {
      const series = simulateHousehold(goalScenario("convertToEquity"), nullJurisdiction);
      // Month 2 (target): the fund is shown AT target.
      expect(series.months[2].accountBalancesCents["goal-x"]).toBe(dollarsToCents(4000));
      expect(series.months[2].netWorthNominalCents).toBe(dollarsToCents(4000));
      // Month 3: the fund is emptied but the $4000 reappears as illiquid home equity —
      // net worth is unchanged by the swap (the $6000 = $4000 equity + $2000 new savings).
      expect(series.months[3].accountBalancesCents["goal-x"]).toBe(0);
      expect(series.months[3].propertyValuesCents["goal-equity-x"]).toBe(dollarsToCents(4000));
      expect(series.months[3].accountBalancesCents["investment"]).toBe(dollarsToCents(2000));
      expect(series.months[3].netWorthNominalCents).toBe(dollarsToCents(6000));
    });

    it("`retain` fires nothing — the fund stays in the account past its target date", () => {
      const series = simulateHousehold(goalScenario("retain"), nullJurisdiction);
      // The reserve is held as-is: still in the fund at month 3, still counted in net
      // worth, and no equity holding was synthesized.
      expect(series.months[3].accountBalancesCents["goal-x"]).toBe(dollarsToCents(4000));
      expect(series.months[3].propertyValuesCents["goal-equity-x"]).toBeUndefined();
      expect(series.months[3].netWorthNominalCents).toBe(dollarsToCents(6000));
    });

    it("`convertToEquity` synthesizes equity that appreciates at the FUND's own rate (AC3)", () => {
      // A pre-funded goal whose fund earns 6%/yr, no contributions. The equity that
      // replaces it at maturity must keep compounding at that same 6% — this pins the
      // rate wiring (fundAccount.getRateAt), which every other firing test, using
      // rate-0 funds, cannot catch: a regression to a hardcoded 0 rate would leave the
      // equity flat and slip past them.
      const fundRate = 0.06;
      const monthly = 1 + preciseMonthlyRate(fundRate);
      const series = simulateHousehold(
        {
          horizonMonths: 5,
          annualInflationRate: 0,
          persons: [makePerson()],
          accounts: [
            makeInvestmentAccount(0, 0),
            new SimAccount({
              id: "goal-x",
              ownerId: "p1",
              liquid: false,
              taxProfile: CAPITAL_GAINS_TAX_PROFILE,
              openingBalanceCents: dollarsToCents(4000),
              initialAnnualRate: fundRate,
            }),
          ],
          incomeSeries: [],
          expenseSeries: [],
          goals: [
            {
              id: "x",
              name: "Goal X",
              targetCents: dollarsToCents(4000),
              targetDate: 2,
              fundAccountId: "goal-x",
              priority: 0,
              disposition: "convertToEquity" as const,
              scope: "shared" as const,
            },
          ],
        },
        nullJurisdiction,
      );
      // Fires at end of month 2; the equity opens at month 3 at the matured balance,
      // then appreciates once per month at exactly the fund's 6% (via advanceProperties).
      const opened = series.months[3].propertyValuesCents["goal-equity-x"];
      expect(opened).toBeGreaterThan(0);
      expect(series.months[3].accountBalancesCents["goal-x"]).toBe(0);
      expect(series.months[4].propertyValuesCents["goal-equity-x"]).toBe(
        Math.round(opened! * monthly),
      );
      expect(series.months[5].propertyValuesCents["goal-equity-x"]).toBe(
        Math.round(series.months[4].propertyValuesCents["goal-equity-x"]! * monthly),
      );
    });
  });

  it("a shared goal is funded ahead of idle surplus, up to its target", () => {
    const checking = makeInvestmentAccount(0, 0);
    const emergency = new SimAccount({
      id: "emergency",
      ownerId: "p1",
      liquid: false,
      taxProfile: CAPITAL_GAINS_TAX_PROFILE,
      openingBalanceCents: 0,
      initialAnnualRate: 0,
    });
    const series = simulateHousehold(
      {
        horizonMonths: 6,
        annualInflationRate: 0,
        persons: [person],
        accounts: [checking, emergency],
        incomeSeries: [{ series: monthlyIncome(dollarsToCents(2000)), ownerId: "p1" }],
        expenseSeries: [],
        goals: [
          {
            id: "ef",
            name: "Emergency fund",
            targetCents: dollarsToCents(5000),
            targetDate: "asap",
            fundAccountId: "emergency",
            priority: 1,
            disposition: "drawDown",
            scope: "shared",
          },
        ],
      },
      nullJurisdiction,
    );
    // Months 1–2 fill the goal to $5000 ($2000 + $2000 + $1000), then surplus idles.
    expect(series.months[3].accountBalancesCents["emergency"]).toBe(dollarsToCents(5000));
    expect(series.months[6].accountBalancesCents["emergency"]).toBe(dollarsToCents(5000));
    // After the goal is capped, the rest idles in checking: month 3 gets $1000, 4–6 get $2000.
    expect(series.months[6].accountBalancesCents["investment"]).toBe(dollarsToCents(7000));
  });

  describe("dated goals amortize to their deadline (#26/#69 AC3, AC7)", () => {
    // Two goals well within budget: $6k by month 6 and $12k by month 12. A $3k/mo
    // income more than covers both paces ($1k + $1k), so the outcome must not depend
    // on priority order and each fund must track an amortized path, not fill-then-idle.
    const near = (priority: number) => ({
      id: "near",
      name: "Near goal",
      targetCents: dollarsToCents(6000),
      targetDate: 6,
      fundAccountId: "near-fund",
      priority,
      disposition: "spend" as const,
      scope: "shared" as const,
    });
    const far = (priority: number) => ({
      id: "far",
      name: "Far goal",
      targetCents: dollarsToCents(12000),
      targetDate: 12,
      fundAccountId: "far-fund",
      priority,
      disposition: "retain" as const,
      scope: "shared" as const,
    });
    const scenario = (nearPriority: number, farPriority: number) => ({
      horizonMonths: 12,
      annualInflationRate: 0,
      persons: [person],
      accounts: [
        makeInvestmentAccount(0, 0),
        goalFund("near-fund"),
        goalFund("far-fund"),
      ],
      incomeSeries: [{ series: monthlyIncome(dollarsToCents(3000)), ownerId: "p1" }],
      expenseSeries: [],
      goals: [near(nearPriority), far(farPriority)],
    });

    it("amortizes the far goal along a rising path instead of filling it then idling (AC7)", () => {
      const series = simulateHousehold(scenario(1, 2), nullJurisdiction);
      const far0 = series.months[1].accountBalancesCents["far-fund"];
      const far6 = series.months[6].accountBalancesCents["far-fund"];
      const far12 = series.months[12].accountBalancesCents["far-fund"];
      // Fill-then-idle would land the full $12k in month 1; a paced path starts small,
      // climbs monotonically, and only reaches the target at the month-12 deadline.
      expect(far0).toBeGreaterThan(0);
      expect(far0).toBeLessThan(dollarsToCents(2000));
      expect(far6).toBeGreaterThan(far0);
      expect(far6).toBeLessThan(dollarsToCents(12000));
      expect(far12).toBe(dollarsToCents(12000));
    });

    it("both affordable goals reach 100% regardless of priority order (AC3)", () => {
      const forward = simulateHousehold(scenario(1, 2), nullJurisdiction);
      const reversed = simulateHousehold(scenario(2, 1), nullJurisdiction);
      // The near goal fires (spend) at month 6, so read its balance AT its deadline.
      for (const s of [forward, reversed]) {
        expect(s.months[6].accountBalancesCents["near-fund"]).toBe(dollarsToCents(6000));
        expect(s.months[12].accountBalancesCents["far-fund"]).toBe(dollarsToCents(12000));
      }
    });
  });
});
