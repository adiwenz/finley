/**
 * The causal rule this suite pins: a transaction or event in month M must never change cash
 * flows in months < M. Federal income tax is priced ANNUALLY but charged only once — the whole
 * of it, the following April ({@link import("./federalIncomeTax")}'s module doc) — so nothing
 * about a later month's event can reach backward into an earlier month's balances, withdrawals,
 * or tax payments. Real in-year tax cash (payroll withholding) is untouched by any of this.
 */
import { describe, it, expect } from "vitest";
import {
  SimAccount,
  CAPITAL_GAINS_TAX_PROFILE,
  PRE_TAX_TAX_PROFILE,
  type SimAccountTaxProfile,
} from "../plan/simAccount";
import { SimCashFlowSeries, dollarsToCents } from "../money/cashFlowSeries";
import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import { simulateHousehold, type HouseholdSimInput, type SimOwnedSeries } from "./simulate";
import type { SimPerson } from "./simulate.types";
import { explicitObligation } from "./financialObligation";

function account(
  id: string,
  taxProfile: SimAccountTaxProfile,
  dollars: number,
  liquid = false,
  annualRate = 0,
): SimAccount {
  return new SimAccount({
    id,
    ownerId: "p1",
    liquid,
    taxProfile,
    openingBalanceCents: dollarsToCents(dollars),
    initialAnnualRate: annualRate,
  });
}

function wages(monthlyDollars: number): SimOwnedSeries {
  return {
    series: new SimCashFlowSeries(0, dollarsToCents(monthlyDollars), { type: "fixed" }, {
      baselineUnit: "monthly",
      taxCategory: "wages",
    }),
    ownerId: "p1",
  };
}

/** Turns 40 in 2026 — comfortably under the 59½ early-withdrawal threshold. */
const person: SimPerson = { id: "p1", name: "You", birthYear: 1986 };

function baseInput(
  accounts: SimAccount[],
  overrides: Partial<HouseholdSimInput> = {},
): HouseholdSimInput {
  return {
    horizonMonths: 16,
    annualInflationRate: 0,
    startYear: 2026,
    persons: [person],
    accounts,
    incomeSeries: [],
    expenseSeries: [],
    ...overrides,
  };
}

/** October — month index 9 of a January-start year. */
const OCTOBER = 9;
/** April of the following year — where the whole of year 0's liability settles. */
const SETTLEMENT_MONTH = 15;

/** Flat 25% ordinary-income tax, no payroll, no penalty. */
const flat25: Jurisdiction = {
  id: "flat-25",
  computeTaxCents: (byCat) => Math.round((byCat.ordinaryIncome ?? 0) * 0.25),
  computeTaxByCategoryCents: (byCat) => {
    const t = Math.round((byCat.ordinaryIncome ?? 0) * 0.25);
    return t > 0 ? { ordinaryIncome: t } : {};
  },
};

/** Flat 25% ordinary-income tax plus a flat 10% early-withdrawal penalty under 59½. */
const flat25WithPenalty: Jurisdiction = {
  ...flat25,
  earlyWithdrawalPenaltyCents: (basis, wctx) =>
    basis.category === "ordinaryIncome" && wctx.age < 59.5
      ? Math.round(basis.grossCents * 0.1)
      : 0,
};

describe("1. An October event never changes January–September", () => {
  it("leaves every prior month's balances, withdrawals, and tax identical whether or not the later event is authored", () => {
    const withoutEvent = simulateHousehold(
      baseInput([account("cash", CAPITAL_GAINS_TAX_PROFILE, 5_000, true), account("pretax", PRE_TAX_TAX_PROFILE, 200_000)], {
        expenseSeries: [{ series: new SimCashFlowSeries(0, dollarsToCents(1_000), { type: "fixed" }, { baselineUnit: "monthly" }), ownerId: "p1" }],
      }),
      flat25,
    );
    const withEvent = simulateHousehold(
      baseInput([account("cash", CAPITAL_GAINS_TAX_PROFILE, 5_000, true), account("pretax", PRE_TAX_TAX_PROFILE, 200_000)], {
        expenseSeries: [{ series: new SimCashFlowSeries(0, dollarsToCents(1_000), { type: "fixed" }, { baselineUnit: "monthly" }), ownerId: "p1" }],
        fundingDraws: [
          explicitObligation({
            id: "spend1",
            sourceId: "spend1",
            month: OCTOBER,
            amountCents: dollarsToCents(50_000),
            orderedAccountIds: ["pretax"],
            treatment: "expense",
          }),
        ],
      }),
      flat25,
    );
    // Every month BEFORE October: identical balances, identical tax, identical cash flow —
    // authoring an October event writes nothing into an earlier month.
    for (let m = 0; m < OCTOBER; m++) {
      expect(withEvent.months[m].accountBalancesCents, `month ${m} balances`).toEqual(
        withoutEvent.months[m].accountBalancesCents,
      );
      expect(withEvent.months[m].flows!.taxCents, `month ${m} tax`).toBe(
        withoutEvent.months[m].flows!.taxCents,
      );
      expect(withEvent.months[m].netWorthNominalCents, `month ${m} net worth`).toBe(
        withoutEvent.months[m].netWorthNominalCents,
      );
    }
    // October itself is where the two runs first diverge.
    expect(withEvent.months[OCTOBER].accountBalancesCents.pretax).toBeLessThan(
      withoutEvent.months[OCTOBER].accountBalancesCents.pretax!,
    );
  });
});

describe("2. A spend affordable at the moment it executes stays executable, even though it creates a later tax bill", () => {
  it("resolves in full when the named source covers exactly the spend, with nothing extra reserved for the tax it will cause", () => {
    // The pretax account holds EXACTLY the spend amount — enough only if the draw is never
    // grossed up. Were the engine to reserve the 25% tax up front, this would block.
    const series = simulateHousehold(
      baseInput([account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true), account("pretax", PRE_TAX_TAX_PROFILE, 50_000)], {
        fundingDraws: [
          explicitObligation({
            id: "spend1",
            sourceId: "spend1",
            month: OCTOBER,
            amountCents: dollarsToCents(50_000),
            orderedAccountIds: ["pretax"],
            treatment: "expense",
          }),
        ],
      }),
      flat25,
    );
    // Not blocked: the spend executed.
    expect(series.status).toBe("ran-to-horizon");
    expect(series.obligationOutcomes["draw:spend1"]).toEqual({ status: "executed" });
    // The whole $50,000 came out — no gross-up reserved a slice for the tax it causes.
    expect(series.months[OCTOBER].accountBalancesCents.pretax).toBe(0);
  });
});

describe("3. The extra tax a spend causes lands in the correct tax year, settled the following April", () => {
  it("charges nothing extra before the settlement, and exactly the spend's tax at it", () => {
    const withoutSpend = simulateHousehold(
      baseInput([account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true), account("pretax", PRE_TAX_TAX_PROFILE, 200_000)]),
      flat25,
    );
    const withSpend = simulateHousehold(
      baseInput([account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true), account("pretax", PRE_TAX_TAX_PROFILE, 200_000)], {
        fundingDraws: [
          explicitObligation({
            id: "spend1",
            sourceId: "spend1",
            month: OCTOBER,
            amountCents: dollarsToCents(50_000),
            orderedAccountIds: ["pretax"],
            treatment: "expense",
          }),
        ],
      }),
      flat25,
    );
    // Both runs charge nothing at all during 2026 — the spend's tax consequence has not yet
    // reached a cash flow.
    for (const month of withoutSpend.months.slice(0, 15)) expect(month.flows!.taxCents).toBe(0);
    for (const month of withSpend.months.slice(0, 15)) expect(month.flows!.taxCents).toBe(0);
    // April 2027 (month 15) is where the whole of 2026 settles — and the difference between the
    // two runs there is exactly the spend's own tax: 25% of $50,000.
    const baseline = withoutSpend.months[SETTLEMENT_MONTH].flows!.taxCents;
    const withSpendTax = withSpend.months[SETTLEMENT_MONTH].flows!.taxCents;
    expect(withSpendTax - baseline).toBe(dollarsToCents(12_500));
  });
});

describe("4. An early withdrawal delivers the full requested cash; its penalty rides the settled tax bill", () => {
  it("delivers $1,000 to spending in October and settles the $100 penalty the following April, never netted from the draw", () => {
    const series = simulateHousehold(
      baseInput([account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true), account("pretax", PRE_TAX_TAX_PROFILE, 200_000)], {
        fundingDraws: [
          explicitObligation({
            id: "spend1",
            sourceId: "spend1",
            month: OCTOBER,
            amountCents: dollarsToCents(1_000),
            orderedAccountIds: ["pretax"],
            treatment: "expense",
          }),
        ],
      }),
      flat25WithPenalty,
    );
    // Exactly $1,000 left the account — not $1,111 sold to cover a gross-up of the penalty too.
    expect(series.months[OCTOBER].accountBalancesCents.pretax).toBe(dollarsToCents(199_000));
    expect(series.months[OCTOBER].flows!.taxCents).toBe(0);
    // April settles the whole year's liability: 25% income tax on the $1,000 draw, PLUS the flat
    // $100 (10%) early-withdrawal penalty — added on top, never netted from the draw itself.
    expect(series.months[SETTLEMENT_MONTH].flows!.taxCents).toBe(
      dollarsToCents(250) + dollarsToCents(100),
    );
  });
});

describe("5. An unfundable April settlement fails in April, never retroactively at the spend", () => {
  it("lets the October spend succeed, then reports insolvency only once April's tax bill cannot be met", () => {
    // Every asset in the household is drained by the October spend itself — nothing is left, and
    // nothing further is earned, to fund the tax that spend will cause next April. Large enough
    // ($250,000, taxed at 25% = $62,500) to exceed even the synthetic shortfall card's credit
    // limit, so the unfunded balance is genuine insolvency, not ordinary borrowing. A zero-balance
    // liquid account is required for the shortfall cascade to engage at all.
    const series = simulateHousehold(
      baseInput([account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true), account("pretax", PRE_TAX_TAX_PROFILE, 250_000)], {
        fundingDraws: [
          explicitObligation({
            id: "spend1",
            sourceId: "spend1",
            month: OCTOBER,
            amountCents: dollarsToCents(250_000),
            orderedAccountIds: ["pretax"],
            treatment: "expense",
          }),
        ],
      }),
      flat25,
    );
    // October itself: solvent. The spend was affordable and executed in full.
    expect(series.months[OCTOBER].isInsolvent).toBe(false);
    expect(series.months[OCTOBER].accountBalancesCents.pretax).toBe(0);
    // Every month between the spend and the settlement: still solvent — nothing has come due yet.
    for (let m = OCTOBER; m < SETTLEMENT_MONTH; m++) {
      expect(series.months[m].isInsolvent, `month ${m}`).toBe(false);
    }
    // April: the $62,500 tax bill has nothing left to fund it from — insolvency lands HERE, not
    // back at the October spend that caused the liability.
    expect(series.months[SETTLEMENT_MONTH].isInsolvent).toBe(true);
  });
});

describe("6. Payroll withholding is untouched — it is charged monthly on current-period wages regardless", () => {
  it("charges the same payroll tax every month whether or not a later taxable event is authored", () => {
    const withPayroll: Jurisdiction = {
      ...flat25,
      computePayrollTaxCents: (byCategory) => Math.round((byCategory.wages ?? 0) * 0.0765),
      computePayrollTaxByCategoryCents: (byCategory) => {
        const t = Math.round((byCategory.wages ?? 0) * 0.0765);
        return t > 0 ? { wages: t } : {};
      },
    };
    const run = (withEvent: boolean) =>
      simulateHousehold(
        baseInput(
          [account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true), account("pretax", PRE_TAX_TAX_PROFILE, 200_000)],
          {
            incomeSeries: [wages(5_000)],
            fundingDraws: withEvent
              ? [
                  explicitObligation({
                    id: "spend1",
                    sourceId: "spend1",
                    month: OCTOBER,
                    amountCents: dollarsToCents(50_000),
                    orderedAccountIds: ["pretax"],
                    treatment: "expense",
                  }),
                ]
              : [],
          },
        ),
        withPayroll,
      );
    const idle = run(false).months.map((m) => m.flows!.payrollTaxCents);
    const withSpend = run(true).months.map((m) => m.flows!.payrollTaxCents);
    // 7.65% of $5,000 wages, charged every month, unaffected by federal income tax's own timing
    // — real in-year tax cash that never changed.
    expect(idle.slice(0, 12)).toEqual(Array(12).fill(Math.round(dollarsToCents(5_000) * 0.0765)));
    expect(withSpend).toEqual(idle);
  });
});

describe("7. A refund settles in April as real cash, without touching any prior month's flows", () => {
  it("leaves every month before April identical to a no-tax run, then hands back the refund in one lump", () => {
    // A flat 10% tax with a $5,000 refundable credit — a household earning $10,000/yr of taxable
    // ordinary income owes $1,000 and receives $4,000 back.
    const refunding: Jurisdiction = {
      id: "flat-10-with-credit",
      computeTaxCents: (byCat) => Math.round((byCat.ordinaryIncome ?? 0) * 0.1) - dollarsToCents(5_000),
      computeTaxByCategoryCents: (byCat) => {
        const t = Math.round((byCat.ordinaryIncome ?? 0) * 0.1) - dollarsToCents(5_000);
        return t !== 0 ? { ordinaryIncome: t } : {};
      },
    };
    const noTax: Jurisdiction = {
      id: "no-tax",
      computeTaxCents: () => 0,
      computeTaxByCategoryCents: () => ({}),
    };
    const accounts = () => [account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true), account("pretax", PRE_TAX_TAX_PROFILE, 200_000)];
    const input = baseInput(accounts(), {
      fundingDraws: [
        explicitObligation({
          id: "spend1",
          sourceId: "spend1",
          month: 0,
          amountCents: dollarsToCents(10_000),
          orderedAccountIds: ["pretax"],
          treatment: "expense",
        }),
      ],
    });
    const refunded = simulateHousehold(input, refunding);
    const untaxed = simulateHousehold(input, noTax);
    // Nothing is charged during the year regardless of the jurisdiction — every month before the
    // settlement is bit-identical between the refunding and the no-tax runs.
    for (let m = 0; m < SETTLEMENT_MONTH; m++) {
      expect(refunded.months[m].accountBalancesCents, `month ${m}`).toEqual(
        untaxed.months[m].accountBalancesCents,
      );
      expect(refunded.months[m].flows!.taxCents, `month ${m}`).toBe(0);
    }
    // April 2027: the refund arrives as real cash — a NEGATIVE tax charge, raising take-home —
    // and it is exactly the $4,000 net credit ($1,000 owed less the $5,000 credit).
    const settled = refunded.months[SETTLEMENT_MONTH];
    expect(settled.flows!.taxCents).toBe(-dollarsToCents(4_000));
    expect(settled.netWorthNominalCents!).toBeGreaterThan(
      untaxed.months[SETTLEMENT_MONTH].netWorthNominalCents!,
    );
    expect(
      settled.netWorthNominalCents! - untaxed.months[SETTLEMENT_MONTH].netWorthNominalCents!,
    ).toBe(dollarsToCents(4_000));
  });
});
