import { describe, it, expect } from "vitest";
import { simulateHousehold } from "./simulate";
import {
  AmortizingLoan,
  RevolvingCard,
  SYNTHETIC_CARD_ID,
  SYNTHETIC_CARD_CREDIT_LIMIT_CENTS,
} from "../liability/liability";
import { dollarsToCents } from "../money/cashFlowSeries";
import type { Cents } from "../money/money";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { initSimState, type SimState } from "./runState";
import {
  advanceLiabilities,
  computeLiabilityPayments,
  forecastLiabilityPayments,
} from "./liabilitySteps";
import {
  makePerson,
  makeInvestmentAccount,
  monthlyIncome,
  monthlyExpense,
} from "./simulate.testSupport";

describe("simulateHousehold — liabilities & shortfall cascade", () => {
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
        // 13 processed months (0..12) so month 12 — the term-end payoff month, first payment
        // at month 1 → 12 payments through month 12 — is a real array slot.
        horizonMonths: 13,
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
    // Owed every month up to the term, then exactly retired — no rounding tail. The final
    // slot is months[17] now (18 processed months, 0..17); it stays 0 well past the term.
    expect(series.months[11].liabilityBalancesCents["car"]).toBeGreaterThan(0);
    expect(series.months[12].liabilityBalancesCents["car"]).toBe(0);
    expect(series.months[17].liabilityBalancesCents["car"]).toBe(0);
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
    expect(bal(39)).toBe(0); // final slot (40 processed months, 0..39) — still retired
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
    // Final of 3 processed months (0..2): three months of shortfall have accrued on the card.
    expect(series.months[2].accountBalancesCents["investment"]).toBeGreaterThanOrEqual(0);
    expect(series.months[2].liabilityBalancesCents[SYNTHETIC_CARD_ID]).toBeGreaterThan(0);
    // A modest shortfall stays under the synthetic card's finite limit, so the plan is
    // still financeable.
    expect(series.months[2].liabilityBalancesCents[SYNTHETIC_CARD_ID]).toBeLessThan(
      SYNTHETIC_CARD_CREDIT_LIMIT_CENTS,
    );
    expect(series.months[2].isInsolvent).toBe(false);
  });

  it("isInsolvent=true once a sustained shortfall exhausts the synthetic card's limit", () => {
    // No user card → synthetic card with a finite default limit. A $30k/mo deficit with no
    // liquid assets overruns it within months, tripping the terminal HARD-INFEASIBILITY
    // flag instead of borrowing without bound.
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
    // New borrowing is capped at the limit; the balance stays bounded near it — interest
    // accrues on top, but never runs away to millions the way an unlimited card would.
    for (const m of series.months) {
      expect(m.liabilityBalancesCents[SYNTHETIC_CARD_ID] ?? 0).toBeLessThan(
        SYNTHETIC_CARD_CREDIT_LIMIT_CENTS * 1.1,
      );
    }
    // Once the deficit outruns all available credit, the plan is flagged insolvent. Final of
    // 6 processed months (0..5) — the deficit has long since exhausted the card by here.
    expect(series.months[5].isInsolvent).toBe(true);
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
        // A card only absorbs shortfalls the month AFTER its startMonth (0), so month 1 is
        // the first where its $100 limit is actually tested against the deficit; run 2
        // processed months (0..1) so that month exists.
        horizonMonths: 2,
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

  it("net worth is null from the first insolvent month ONWARD; the last funded month keeps its value", () => {
    // A modest starting balance funds a couple of months, then a sustained deficit runs the
    // plan insolvent — so there are solvent months, a first insolvent month, and months
    // beyond it. Net worth is real up to but NOT INCLUDING the first insolvent month: that
    // month already dropped the spending it could not fund, so totalling its balance sheet
    // flatters it (see {@link snapshotMonth}). The last honest figure is the last fully
    // funded month.
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
      if (m.month < firstInsolvent) {
        // Real value through the last FULLY FUNDED month.
        expect(m.netWorthNominalCents).not.toBeNull();
        expect(m.netWorthRealCents).not.toBeNull();
      } else {
        // Nulled from the failure on — the lines end at the last funded month.
        expect(m.netWorthNominalCents).toBeNull();
        expect(m.netWorthRealCents).toBeNull();
      }
    }
    // isInsolvent itself is unaffected — still flagged per month, including nulled ones, and
    // the size of the hole is stated separately rather than left to a balance sheet.
    expect(series.months[firstInsolvent].isInsolvent).toBe(true);
    expect(series.months[firstInsolvent].uncoveredCents).toBeGreaterThan(0);
    expect(series.months[firstInsolvent - 1].uncoveredCents).toBe(0);
  });

  it("proportional transfer: −0.2 fraction removes 20% of balance", () => {
    const acc = makeInvestmentAccount(dollarsToCents(10_000), 0);
    acc.addTransfer({ month: 1, proportionalFraction: -0.2 });
    const series = simulateHousehold(
      {
        // 3 processed months (0..2) so month 2 exists to confirm the month-1 transfer isn't
        // re-applied afterward.
        horizonMonths: 3,
        annualInflationRate: 0,
        persons: [],
        accounts: [acc],
        incomeSeries: [],
        expenseSeries: [],
        liabilities: [],
      },
      nullJurisdiction,
    );
    // Transfer lands at its authored month 1; the balance then holds at $8k.
    expect(series.months[1].accountBalancesCents["investment"]).toBe(dollarsToCents(8_000));
    expect(series.months[2].accountBalancesCents["investment"]).toBe(dollarsToCents(8_000));
  });

  it("amountCents + proportionalFraction combine: both applied in same transfer", () => {
    const acc = makeInvestmentAccount(dollarsToCents(10_000), 0);
    // Add $1,000 + remove 10% = +1000 + (-1000) = net $0 change
    acc.addTransfer({ month: 1, amountCents: dollarsToCents(1_000), proportionalFraction: -0.1 });
    const series = simulateHousehold(
      {
        // 2 processed months (0..1) so the transfer's authored month 1 is a real slot.
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
    expect(series.months[1].accountBalancesCents["investment"]).toBe(dollarsToCents(10_000));
  });

  it("liability lump-sum transfer reduces the owed balance in its month (before interest)", () => {
    // Two identical $10k / 5% / 60mo loans; one gets a −$3,000 payoff at month 12. A big
    // asset keeps every scheduled payment financeable, so the transfer is the only
    // difference between the runs.
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

    // ~$3,000 lower at month 12, plus one month's interest on it — the transfer lands
    // before interest accrues.
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
      // 61 processed months (0..60) so month 60 — the 60-term loan's payoff month, first
      // payment at month 1 → retired at month 60 — is a real slot.
      horizonMonths: 61,
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
    // A DebtPayoffEvent is two transfers: cash leaves a liquid account AND the owed balance
    // drops by the same amount. At 0% APR both the paired lump sum and the ordinary
    // scheduled payments are net-worth-neutral (cash becomes debt reduction, dollar for
    // dollar), so net worth is EXACTLY constant — the $4k payoff creates no value.
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
        // A card only absorbs shortfalls the month AFTER its startMonth (0), so it first fills
        // at month 1; run 2 processed months (0..1) so that month exists.
        horizonMonths: 2,
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

      // Nothing is ever partial/missed/delinquent, and every record carries a positive
      // applied amount (a real payment occurred).
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

/**
 * The year-ahead debt schedule the tax estimate is sized against. A debt's payments belong to the
 * months it actually makes them: holding January's figure flat charged a matured loan for months
 * it no longer existed and an unoriginated one for none of the months it did.
 */
describe("forecastLiabilityPayments — the months a debt is actually paid in", () => {
  const stateWith = (liabilities: (AmortizingLoan | RevolvingCard)[]): SimState =>
    initSimState({
      horizonMonths: 24,
      annualInflationRate: 0,
      persons: [makePerson()],
      accounts: [makeInvestmentAccount(dollarsToCents(500_000), 0)],
      incomeSeries: [],
      expenseSeries: [],
      liabilities,
    });

  /** A $45,000 interest-free loan paid off in six $7,500 instalments. */
  const sixMonthLoan = (startMonth: number): AmortizingLoan =>
    new AmortizingLoan({
      id: "loan",
      ownerId: "p1",
      kind: "studentLoan",
      openingBalanceCents: dollarsToCents(45_000),
      startMonth,
      apr: 0,
      termMonths: 6,
    });

  /** What each forecast month charges for `id`, absent → 0. */
  const chargesFor = (byMonth: readonly ReadonlyMap<string, Cents>[], id: string): Cents[] =>
    byMonth.map((m) => m.get(id) ?? 0);

  it("stops charging a loan the month after its final payment", () => {
    const forecast = forecastLiabilityPayments(stateWith([sixMonthLoan(0)]), 0, 12);
    // Originates in month 0, so the first payment falls in month 1 and the last in month 6 —
    // and months 7 through 11 are free of it, rather than carrying January's payment to December.
    expect(chargesFor(forecast, "loan")).toEqual([
      0, ...Array(6).fill(dollarsToCents(7_500)), 0, 0, 0, 0, 0,
    ]);
  });

  it("charges a loan that originates mid-year from the month it starts paying, not before", () => {
    const forecast = forecastLiabilityPayments(stateWith([sixMonthLoan(5)]), 0, 12);
    expect(chargesFor(forecast, "loan")).toEqual([
      0, 0, 0, 0, 0, 0, ...Array(6).fill(dollarsToCents(7_500)),
    ]);
  });

  it("charges a loan spanning the whole year in all twelve months", () => {
    const loan = new AmortizingLoan({
      id: "mortgage",
      ownerId: "p1",
      kind: "mortgage",
      openingBalanceCents: dollarsToCents(300_000),
      apr: 0.06,
      termMonths: 360,
    });
    const charges = chargesFor(forecastLiabilityPayments(stateWith([loan]), 0, 12), "mortgage");
    expect(charges[0]).toBe(0); // origination month: the balance appears, nothing is paid
    for (let m = 1; m < 12; m++) expect(charges[m]).toBe(charges[1]);
    expect(charges[1]).toBeGreaterThan(dollarsToCents(1_500));
  });

  it("matches, month for month, what a fully-funded run actually charges", () => {
    // Not a lookalike of the run's own `computeLiabilityPayments` — the same function against the
    // same advance rule, which is what stops the estimate and the months it estimates from
    // disagreeing about what a debt costs.
    const forecast = forecastLiabilityPayments(stateWith([sixMonthLoan(0)]), 0, 12);
    const walked = stateWith([sixMonthLoan(0)]);
    for (let m = 0; m < 12; m++) {
      const actual = computeLiabilityPayments(walked, m);
      expect(forecast[m]).toEqual(actual);
      advanceLiabilities(walked, m, actual);
    }
  });

  it("follows a scheduled lump-sum payoff, dropping the payments it retires", () => {
    const loan = sixMonthLoan(0);
    // The whole balance settled in month 3, before that month's interest — the payments for
    // months 4 through 6 are simply not made, and the forecast must not fund them.
    loan.addTransfer({ month: 3, amountCents: -dollarsToCents(45_000) });
    expect(chargesFor(forecastLiabilityPayments(stateWith([loan]), 0, 12), "loan")).toEqual([
      0, dollarsToCents(7_500), dollarsToCents(7_500), dollarsToCents(7_500), 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });
});
