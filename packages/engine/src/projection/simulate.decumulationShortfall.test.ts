/**
 * Decumulation is sized by the WATERFALL, not beside it.
 *
 * The month's funding gap is measured by running the same allocation the month will be charged by
 * over the income the household has before anything is sold, and handing the shortfall it reports
 * to the liquidation channel. Everything here is a consequence of that one fact: a deduction the
 * waterfall takes shrinks take-home, therefore widens the gap, therefore sells an investment —
 * with no term in the decumulation code naming that deduction, and nothing to keep in step when a
 * new one is added.
 *
 * Each test is a deduction that a second, parallel model of take-home missed. It missed them
 * silently and permanently: a working household's monthly gap is small, the shortfall cascade
 * absorbed it onto a credit card, and the card compounded for decades beside an untouched
 * retirement account.
 */
import { describe, it, expect } from "vitest";
import { SimAccount, CAPITAL_GAINS_TAX_PROFILE, PRE_TAX_TAX_PROFILE } from "../plan/simAccount";
import { SimCashFlowSeries, dollarsToCents } from "../money/cashFlowSeries";
import type { Cents } from "../money/money";
import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import { simulateHousehold, type HouseholdSimInput, type SimOwnedSeries } from "./simulate";
import type { ProjectionMonth } from "./simulate.types";

const FICA_RATE = 0.0765;

/**
 * Payroll tax and nothing else. Deliberately no income tax: the shortfall it opens is then exactly
 * the payroll charge, with no instalment or gross-up moving beneath the assertions.
 */
const payrollOnly: Jurisdiction = {
  id: "payroll-only",
  computeTaxCents: () => 0,
  computeTaxByCategoryCents: () => ({}),
  computePayrollTaxCents: (byCategory) => Math.round((byCategory.wages ?? 0) * FICA_RATE),
  // Required companion to the scalar seam — the waterfall refuses an unattributable charge.
  computePayrollTaxByCategoryCents: (byCategory) => ({
    wages: Math.round((byCategory.wages ?? 0) * FICA_RATE),
  }),
};

/** No tax of any kind, so a deferral is the only thing standing between gross pay and a bill. */
const untaxed: Jurisdiction = {
  id: "untaxed",
  computeTaxCents: () => 0,
  computeTaxByCategoryCents: () => ({}),
};

function account(id: string, taxProfile = CAPITAL_GAINS_TAX_PROFILE, dollars = 0, liquid = false): SimAccount {
  return new SimAccount({
    id,
    ownerId: "p1",
    liquid,
    taxProfile,
    openingBalanceCents: dollarsToCents(dollars),
    initialAnnualRate: 0,
  });
}

/** Wages, optionally deferring into a plan. */
function wages(monthlyDollars: number, planDescriptor?: SimOwnedSeries["planDescriptor"]): SimOwnedSeries {
  return {
    series: new SimCashFlowSeries(0, dollarsToCents(monthlyDollars), { type: "fixed" }, {
      baselineUnit: "monthly",
      taxCategory: "wages",
    }),
    ownerId: "p1",
    sourceId: "job:j1",
    ...(planDescriptor !== undefined ? { planDescriptor } : {}),
  };
}

/** One flat monthly bill — an automatically-funded obligation, like every cost in these fixtures. */
function spending(monthlyDollars: number): SimOwnedSeries {
  return {
    series: new SimCashFlowSeries(0, dollarsToCents(monthlyDollars), { type: "fixed" }, {
      baselineUnit: "monthly",
    }),
    ownerId: "p1",
  };
}

function input(accounts: SimAccount[], overrides: Partial<HouseholdSimInput> = {}): HouseholdSimInput {
  return {
    horizonMonths: 12,
    annualInflationRate: 0,
    startYear: 2026,
    persons: [{ id: "p1", name: "You" }],
    accounts,
    incomeSeries: [],
    expenseSeries: [],
    ...overrides,
  };
}

/** Every liability the run carries, summed — nothing should ever be borrowed in these fixtures. */
const borrowedCents = (m: ProjectionMonth): Cents =>
  Object.values(m.liabilityBalancesCents).reduce((total, cents) => total + cents, 0);

describe("The month's shortfall comes from the waterfall that charges it", () => {
  it("sells retirement to cover a gap that is exactly payroll tax, rather than borrowing", () => {
    // $0 cash, $500k in a 401(k), and a paycheck that covers the bills GROSS and misses them by
    // $82.50 once FICA is out. The old sizing — obligations less income less income tax — read
    // this month as covered and left the $82.50 to the credit cascade; on the app's own default
    // plan that $0.83-a-month version of this gap compounded to a maxed card and a household
    // declared broke in year 23 with $2.4M in its 401(k).
    const months = simulateHousehold(
      input([account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true), account("retirement", PRE_TAX_TAX_PROFILE, 500_000)], {
        incomeSeries: [wages(5_000)],
        expenseSeries: [spending(4_700)],
      }),
      payrollOnly,
    ).months;

    const ficaCents = Math.round(dollarsToCents(5_000) * FICA_RATE);
    const gapCents = dollarsToCents(4_700) - (dollarsToCents(5_000) - ficaCents);
    expect(gapCents).toBe(dollarsToCents(82.5));

    // Month 0: exactly the gap comes out of the 401(k) — no more (no gross-up: this jurisdiction
    // taxes the draw at nothing) and no less.
    expect(months[0]!.accountBalancesCents["retirement"]).toBe(dollarsToCents(500_000) - gapCents);
    // Twelve months later, twelve gaps — the draw recurs rather than being a one-off.
    expect(months[11]!.accountBalancesCents["retirement"]).toBe(
      dollarsToCents(500_000) - 12 * gapCents,
    );
    for (const m of months) {
      expect(borrowedCents(m)).toBe(0);
      expect(m.isInsolvent).toBe(false);
    }
  });

  it("sells to cover a gap opened by a pre-tax deferral, and still makes the deferral", () => {
    // A 15% 401(k) deferral is a real bite out of take-home, not merely a tax adjustment: $5,000
    // of pay funds $4,250 of bills. The $50 short is found by the same measurement, with nothing
    // in the liquidation channel that knows what a deferral is.
    const months = simulateHousehold(
      input(
        [
          account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true),
          account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 100_000),
          account("401k", PRE_TAX_TAX_PROFILE, 0),
        ],
        {
          incomeSeries: [wages(5_000, { deferralFraction: 0.15, fundAccountId: "401k" })],
          expenseSeries: [spending(4_300)],
        },
      ),
      untaxed,
    ).months;

    const deferralCents = dollarsToCents(750);
    const gapCents = dollarsToCents(4_300) - (dollarsToCents(5_000) - deferralCents);
    expect(gapCents).toBe(dollarsToCents(50));
    expect(months[0]!.accountBalancesCents["brokerage"]).toBe(dollarsToCents(100_000) - gapCents);
    // The deferral is not what got cut to close the gap — it landed in full.
    expect(months[0]!.accountBalancesCents["401k"]).toBe(deferralCents);
    for (const m of months) expect(borrowedCents(m)).toBe(0);
  });

  it("charges the whole gap to the liquid buffer first, selling only what is left", () => {
    // The buffer is spent before anything is liquidated — the measured gap does not change what
    // the cascade already did, it only decides how much has to be raised beyond it.
    const months = simulateHousehold(
      input(
        [
          account("checking", CAPITAL_GAINS_TAX_PROFILE, 50, true),
          account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 100_000),
        ],
        { incomeSeries: [wages(5_000)], expenseSeries: [spending(4_700)] },
      ),
      payrollOnly,
    ).months;

    const gapCents = dollarsToCents(82.5);
    expect(months[0]!.accountBalancesCents["checking"]).toBe(0);
    expect(months[0]!.accountBalancesCents["brokerage"]).toBe(
      dollarsToCents(100_000) - (gapCents - dollarsToCents(50)),
    );
    expect(borrowedCents(months[0]!)).toBe(0);
  });
});

describe("Nothing reaches the borrowing cascade while there is something left to sell", () => {
  /**
   * The invariant the two passes exist to make true, swept over every month of every fixture: a
   * household only borrows once its liquidatable accounts are EMPTY. A gap the pre-withdrawal
   * sizing computed differently from the waterfall is exactly how this used to break — the credit
   * cascade absorbed the difference while investments sat untouched — so it is asserted month by
   * month rather than at the horizon, where a card balance can hide behind a later payoff.
   *
   * Contributions are deliberately absent from these fixtures: an unaffordable standing
   * contribution is NOT asset-funded (the `contributionsNotAssetFunded` simplification), so it can
   * legitimately borrow with investments in hand, and including one would test that policy instead
   * of this invariant.
   */
  const fixtures: readonly (readonly [string, HouseholdSimInput, Jurisdiction])[] = [
    [
      "payroll tax opens the gap",
      input([account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true), account("retirement", PRE_TAX_TAX_PROFILE, 2_000)], {
        incomeSeries: [wages(5_000)],
        expenseSeries: [spending(4_700)],
        horizonMonths: 36,
      }),
      payrollOnly,
    ],
    [
      "a deferral opens the gap",
      input(
        [
          account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true),
          account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 1_000),
          account("401k", PRE_TAX_TAX_PROFILE, 0),
        ],
        {
          // Spending well past take-home, so the sale outruns the deposit and both accounts
          // genuinely run dry inside the horizon — otherwise the deferral keeps refilling the
          // very pot being sold and nothing is ever borrowed to assert about.
          incomeSeries: [wages(5_000, { deferralFraction: 0.15, fundAccountId: "401k" })],
          expenseSeries: [spending(5_500)],
          horizonMonths: 36,
        },
      ),
      untaxed,
    ],
    [
      "income stops entirely",
      input([account("checking", CAPITAL_GAINS_TAX_PROFILE, 1_000, true), account("retirement", PRE_TAX_TAX_PROFILE, 30_000)], {
        expenseSeries: [spending(2_000)],
        horizonMonths: 36,
      }),
      payrollOnly,
    ],
  ];

  for (const [name, fixture, jurisdiction] of fixtures) {
    it(`holds when ${name}`, () => {
      const months = simulateHousehold(fixture, jurisdiction).months;
      let borrowedBefore = 0;
      let sawBorrowing = false;
      for (const [i, m] of months.entries()) {
        const borrowed = borrowedCents(m);
        // What can still be sold: everything but the liquid buffer, which the cascade spends
        // directly and which is 0 here in any month that borrowed anyway.
        const sellableCents = Object.entries(m.accountBalancesCents)
          .filter(([id]) => id !== "checking")
          .reduce((total, [, cents]) => total + cents, 0);
        // Less what landed in those accounts AFTER decumulation had already sized and taken its
        // draw: a pre-tax deferral is withheld from the paycheck further down the same month's
        // waterfall, so a balance holding one month's deferral is not a balance decumulation
        // declined to sell — it is money that did not exist when decumulation looked.
        const depositedAfterDrawCents = Object.values(m.flows?.deferralBySourceCents ?? {}).reduce(
          (total, cents) => total + cents,
          0,
        );
        const reachableCents = sellableCents - depositedAfterDrawCents;
        if (borrowed > borrowedBefore) {
          sawBorrowing = true;
          expect(
            reachableCents,
            `month ${i} borrowed ${borrowed - borrowedBefore} with ${reachableCents} still sellable`,
          ).toBe(0);
        }
        borrowedBefore = borrowed;
      }
      // Each fixture is authored to eventually run its accounts dry, so the assertion above is
      // reached rather than passing on a run that never borrowed at all.
      expect(sawBorrowing).toBe(true);
    });
  }
});
