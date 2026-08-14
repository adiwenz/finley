import { describe, it, expect } from "vitest";
import {
  SimAccount,
  CAPITAL_GAINS_TAX_PROFILE,
  CASH_INTEREST_TAX_PROFILE,
  PRE_TAX_TAX_PROFILE,
  TAX_EXEMPT_TAX_PROFILE,
  type SimAccountTaxProfile,
} from "../plan/simAccount";
import { SimCashFlowSeries, dollarsToCents } from "../money/cashFlowSeries";
import { apportionByWeight, type Cents } from "../money/money";
import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import {
  simulateHousehold,
  type HouseholdSimInput,
  type ProjectionSeries,
  type SimOwnedSeries,
  type SimProperty,
} from "./simulate";
import { explicitObligation } from "./financialObligation";
import { AmortizingLoan } from "../liability/liability";
import { planOutcome } from "../retirement/retirementSolver";

const CATEGORIES = ["wages", "ordinaryIncome", "capitalGains", "taxExempt"] as const;
const RATE = 0.25;

/** Flat rate, same per-category rounding in the scalar and the breakdown, so the two reconcile. */
function flatAnnual(rate: number): Jurisdiction {
  const perCategory = (byCat: Partial<Record<string, number>>): Partial<Record<string, number>> => {
    const out: Partial<Record<string, number>> = {};
    for (const category of CATEGORIES) {
      const v = byCat[category] ?? 0;
      if (v > 0) out[category] = Math.round(v * rate);
    }
    return out;
  };
  return {
    id: "flat-annual",
    computeTaxByCategoryCents: perCategory,
    computeTaxCents: (byCat) =>
      Object.values(perCategory(byCat)).reduce((s: number, v) => s + (v ?? 0), 0),
    // Pro-rata return of capital, so a brokerage sale realizes only its gain — the ordinary
    // in-life basis model the terminal valuation deliberately does NOT use.
    taxableWithdrawalCents: ({ grossCents, basisCents, balanceCents }) =>
      balanceCents <= 0 || basisCents <= 0
        ? grossCents
        : grossCents - Math.min(basisCents, Math.round(grossCents * Math.min(1, basisCents / balanceCents))),
  };
}

function account(
  id: string,
  taxProfile: SimAccountTaxProfile,
  dollars: number,
  opts: { liquid?: boolean; rate?: number; beneficiaryDesignated?: boolean } = {},
): SimAccount {
  return new SimAccount({
    id,
    ownerId: "p1",
    liquid: opts.liquid ?? false,
    beneficiaryDesignated: opts.beneficiaryDesignated ?? false,
    taxProfile,
    openingBalanceCents: dollarsToCents(dollars),
    initialAnnualRate: opts.rate ?? 0,
  });
}

const cash = (dollars: number) =>
  account("cash", CASH_INTEREST_TAX_PROFILE, dollars, { liquid: true });
/** Beneficiary-designated by construction — the point of the exclusion tests. */
const preTax = (dollars: number) =>
  account("pretax", PRE_TAX_TAX_PROFILE, dollars, { beneficiaryDesignated: true });
const roth = (dollars: number) =>
  account("roth", TAX_EXEMPT_TAX_PROFILE, dollars, { beneficiaryDesignated: true });
const brokerage = (dollars: number, rate = 0) =>
  account("brokerage", CAPITAL_GAINS_TAX_PROFILE, dollars, { rate });

function series(monthlyDollars: number, startMonth = 0, endMonth?: number): SimOwnedSeries {
  return {
    series: new SimCashFlowSeries(startMonth, dollarsToCents(monthlyDollars), { type: "fixed" }, {
      baselineUnit: "monthly",
      ...(endMonth !== undefined ? { endMonth } : {}),
    }),
    ownerId: "p1",
  };
}

function loan(dollars: number, startMonth: number, apr: number, termMonths: number): AmortizingLoan {
  return new AmortizingLoan({
    id: "loan",
    ownerId: "p1",
    kind: "studentLoan",
    openingBalanceCents: dollarsToCents(dollars),
    apr,
    termMonths,
    startMonth,
  });
}

/** A house: never liquidated by the waterfall, so it is still there to value at death. */
function house(dollars: number): SimProperty {
  return {
    id: "house",
    ownerId: "p1",
    startMonth: -1,
    endMonth: null,
    openingValueCents: dollarsToCents(dollars),
    appreciationAnnualRate: 0,
  };
}

/**
 * A household that DIES at the horizon — `householdDeathMonthExclusive` matching, which is the
 * only shape that settles an estate.
 */
function dies(
  horizonMonths: number,
  accounts: SimAccount[],
  overrides: Partial<HouseholdSimInput> = {},
  jurisdiction: Jurisdiction = flatAnnual(RATE),
): ProjectionSeries {
  return simulateHousehold(
    {
      horizonMonths,
      householdDeathMonthExclusive: horizonMonths,
      annualInflationRate: 0,
      startYear: 2026,
      persons: [{ id: "p1", name: "You" }],
      accounts,
      incomeSeries: [],
      expenseSeries: [],
      ...overrides,
    },
    jurisdiction,
  );
}

/**
 * An allowance then two rates. Needed wherever the year's tax must be NON-linear in income: under
 * a flat rate, half a year's instalments and half a year's tax are equal by arithmetic, so a
 * mid-year death would settle at exactly zero and prove nothing.
 */
function progressiveAnnual(): Jurisdiction {
  const scalar = (byCat: Partial<Record<string, number>>): Cents => {
    const total = CATEGORIES.reduce((s, c) => s + (byCat[c] ?? 0), 0);
    const overAllowance = Math.max(0, total - dollarsToCents(20_000));
    const lower = Math.min(overAllowance, dollarsToCents(60_000));
    return Math.round(lower * 0.1 + Math.max(0, overAllowance - lower) * 0.35);
  };
  return {
    id: "progressive-annual",
    computeTaxCents: scalar,
    computeTaxByCategoryCents: (byCat) =>
      Object.fromEntries(
        apportionByWeight(
          scalar(byCat),
          CATEGORIES.map((c) => [c, byCat[c] ?? 0] as const),
        ),
      ),
  };
}

/** The same run with no death declared: an arbitrary horizon that happens to stop there. */
function stopsAtHorizon(
  horizonMonths: number,
  accounts: SimAccount[],
  overrides: Partial<HouseholdSimInput> = {},
): ProjectionSeries {
  return simulateHousehold(
    {
      horizonMonths,
      annualInflationRate: 0,
      startYear: 2026,
      persons: [{ id: "p1", name: "You" }],
      accounts,
      incomeSeries: [],
      expenseSeries: [],
      ...overrides,
    },
    flatAnnual(RATE),
  );
}

const settlementOf = (series: ProjectionSeries) => {
  const settlement = series.estateSettlement;
  if (settlement === undefined) throw new Error("expected an estate settlement");
  return settlement;
};

const sum = (values: readonly Cents[]): Cents => values.reduce((s, v) => s + v, 0);

/**
 * A retired household living off its pre-tax account, holding a house. The loan ORIGINATING at
 * `loanMonth` is the lever that makes the year's estimate miss: the year-start estimate holds
 * liability payments flat from January, so a loan taken later in the year raises real spending —
 * and the pre-tax decumulation funding it — above what the year was paced for. That gap is what
 * survives December as a balance for an April this household never lives to see.
 */
function retiredWithLoanAt(loanMonth: number, horizonMonths = 24): ProjectionSeries {
  return dies(horizonMonths, [cash(10_000), preTax(500_000)], {
    expenseSeries: [series(4_000)],
    properties: [house(300_000)],
    liabilities: [loan(50_000, loanMonth, 0.05, 60)],
  });
}

describe("Estate settlement — when it runs at all", () => {
  it("settles the estate when the run reaches the month the last member dies", () => {
    expect(dies(12, [cash(50_000)]).estateSettlement).toBeDefined();
  });

  it("settles nothing at an arbitrary horizon that no death sized", () => {
    // Same twelve months, same balances; the only difference is that nobody died at the end of
    // them. A debug span, a safety horizon or a truncated preview all take this path.
    expect(stopsAtHorizon(12, [cash(50_000)]).estateSettlement).toBeUndefined();
  });

  it("settles nothing when a blocked obligation truncated the run before the death", () => {
    const blocked = dies(12, [cash(1_000)], {
      fundingDraws: [
        explicitObligation({
          id: "spend",
          sourceId: "cash",
          label: "Unaffordable spend",
          month: 3,
          amountCents: dollarsToCents(500_000),
          orderedAccountIds: ["cash"],
          treatment: "expense",
        }),
      ],
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.estateSettlement).toBeUndefined();
  });

  it("still settles an estate the household died insolvent in", () => {
    // Insolvency is not a reason the run stopped — it kept simulating with net worth nulled — so
    // the death at the end of it is as real as any other, and what it left behind is still worth
    // stating. It is simply nowhere near enough.
    const insolvent = dies(12, [cash(0)], { expenseSeries: [series(9_000)] });
    expect(insolvent.months[11].isInsolvent).toBe(true);
    expect(settlementOf(insolvent).isSolvent).toBe(false);
  });
});

describe("Estate settlement — final federal income tax", () => {
  it("prices the final year off the income actually earned through death, not the year's estimate", () => {
    const settlement = settlementOf(retiredWithLoanAt(18));
    const months = retiredWithLoanAt(18).months.slice(12);
    // Every taxable dollar the final year really produced — the pre-tax draws that funded it.
    const actualTaxableCents = sum(
      months.map((m) => m.flows!.cashFlowIncomeByCategoryCents.ordinaryIncome ?? 0),
    );
    const instalmentsCents = sum(months.map((m) => m.flows!.taxCents));
    // Twelve instalments paced off January's estimate, plus the balance the estate is left with,
    // equal the flat rate on what the year actually earned. The estimate missed; the estate pays.
    // Within a dollar rather than to the cent, because April of this year charged year 1's own
    // rounding residue through the same line and no flow field separates the two.
    expect(
      Math.abs(instalmentsCents + settlement.finalTaxDueCents - Math.round(actualTaxableCents * RATE)),
    ).toBeLessThanOrEqual(dollarsToCents(1));
    expect(settlement.finalTaxDueCents).toBeGreaterThan(0);
    expect(settlement.finalTaxRefundCents).toBe(0);
  });

  it("hands the estate the same balance April would have charged, when death comes first", () => {
    // One year, three deaths. Dying in December of it leaves the whole year for the estate; living
    // to the following April charges it there, to the cent; dying in between leaves it outstanding
    // still. The balance does not change because the household died — only who settles it does.
    const decemberDeath = settlementOf(retiredWithLoanAt(6, 12));
    const survivesToApril = retiredWithLoanAt(6, 16);
    const februaryDeath = settlementOf(retiredWithLoanAt(6, 14));

    expect(decemberDeath.finalTaxDueCents).toBeGreaterThan(0);
    // April's charge is the month's own instalment plus exactly that balance — to the cent the
    // twelve instalments' cumulative rounding allows adjacent months to differ by.
    const aprilCents = survivesToApril.months[15].flows!.taxCents;
    const marchCents = survivesToApril.months[14].flows!.taxCents;
    expect(Math.abs(aprilCents - marchCents - decemberDeath.finalTaxDueCents)).toBeLessThanOrEqual(1);
    // Having paid it in April, that household's estate is left with only the stub of its final
    // year; the February household's estate still carries the whole of the year before.
    expect(settlementOf(survivesToApril).finalTaxDueCents).toBeLessThan(
      decemberDeath.finalTaxDueCents,
    );
    expect(februaryDeath.finalTaxDueCents).toBeGreaterThan(
      settlementOf(survivesToApril).finalTaxDueCents,
    );
  });

  it("counts a final-year overpayment as an estate asset rather than a debt", () => {
    // Dying in June leaves six months of a twelve-month estimate already paid against six months
    // of wages — an overpayment, and the estate collects it. $120k/yr paced at $1,666.67 a month
    // is $10,000 paid in; six months' $60k wages owe $4,000 under this schedule.
    const settlement = settlementOf(
      dies(18, [cash(50_000)], { incomeSeries: [series(10_000)] }, progressiveAnnual()),
    );
    expect(settlement.finalTaxDueCents).toBe(0);
    expect(settlement.finalTaxRefundCents).toBe(dollarsToCents(6_000));
    // Assets are the accounts PLUS the refund, and the surplus carries it through.
    expect(settlement.estateAssetsCents).toBe(
      settlement.estateAccountsCents + settlement.finalTaxRefundCents,
    );
    expect(settlement.estateSurplusCents).toBe(
      settlement.estateAssetsCents - settlement.outstandingDebtCents,
    );
  });

  it("charges the final tax to the estate, never to the final month", () => {
    const dying = retiredWithLoanAt(18);
    const living = stopsAtHorizon(24, [cash(10_000), preTax(500_000)], {
      expenseSeries: [series(4_000)],
      properties: [house(300_000)],
      liabilities: [loan(50_000, 18, 0.05, 60)],
    });
    // Month for month, the two runs are identical: declaring the death changed no instalment, no
    // balance, no net worth. The estate settlement is a statement ABOUT the terminal state, not a
    // twenty-fifth month of simulation.
    expect(dying.months).toEqual(living.months);
    expect(settlementOf(dying).finalTaxDueCents).toBeGreaterThan(0);
  });
});

describe("Estate settlement — what the estate holds", () => {
  it("counts cash at its balance on the day", () => {
    const settlement = settlementOf(dies(12, [cash(50_000)]));
    expect(settlement.estateAccountsCents).toBe(dollarsToCents(50_000));
    expect(settlement.estateAssetsCents).toBe(dollarsToCents(50_000));
    expect(settlement.estateSurplusCents).toBe(dollarsToCents(50_000));
    expect(settlement.isSolvent).toBe(true);
  });

  it("counts appreciated taxable investments at death-date value, realizing no terminal gain", () => {
    // $40k of brokerage that doubled against a $40k basis, beside $40k of cash that did nothing.
    // Under the in-life basis model, liquidating the brokerage would realize $40k of gain and owe
    // $10k on it; the estate values it at what it is worth and stops there.
    const appreciated = settlementOf(dies(12, [cash(10_000), brokerage(40_000, 1.0)]));
    const brokerageValueCents =
      dies(12, [cash(10_000), brokerage(40_000, 1.0)]).months[11].accountBalancesCents.brokerage;
    expect(brokerageValueCents).toBeGreaterThan(dollarsToCents(79_000));
    expect(appreciated.estateAccountsCents).toBe(dollarsToCents(10_000) + brokerageValueCents);
    expect(appreciated.finalTaxDueCents).toBe(0);
    // Same money, no unrealized gain in it: the estate is worth the same either way, which is
    // exactly what the basis reset means.
    const asCash = settlementOf(dies(12, [cash(10_000), brokerage(40_000)]));
    expect(appreciated.estateAssetsCents - appreciated.estateAccountsCents).toBe(
      asCash.estateAssetsCents - asCash.estateAccountsCents,
    );
  });

  it("prices a sale made in life against basis, and the untouched remainder against nothing", () => {
    // The basis reset is terminal-only. This household spends $48k of a fast-appreciating
    // brokerage over its last year: every one of those sales returns basis pro-rata and is taxed
    // on its gain alone, which is what leaves the account's basis below where it started.
    const spent = dies(12, [cash(0), brokerage(100_000, 1.0)], {
      expenseSeries: [series(4_000)],
    });
    const last = spent.months[11];
    const settlement = settlementOf(spent);
    const grossDrawnCents = dollarsToCents(48_000);
    const basisConsumedCents = dollarsToCents(100_000) - last.accountBasisCents.brokerage;
    expect(basisConsumedCents).toBeGreaterThan(0);
    expect(basisConsumedCents).toBeLessThan(grossDrawnCents);
    // Everything the year owed, wherever it was charged: the ordinary rate on realized GAIN, not
    // on the gross the household actually spent.
    expect(sum(spent.months.map((m) => m.flows!.taxCents)) + settlement.finalTaxDueCents).toBe(
      Math.round((grossDrawnCents - basisConsumedCents) * RATE),
    );
    // What was never sold carries an unrealized gain of the same size again, and the estate takes
    // it at value with nothing owed on it.
    expect(settlement.estateAccountsCents).toBe(last.accountBalancesCents.brokerage);
    expect(last.accountBalancesCents.brokerage).toBeGreaterThan(last.accountBasisCents.brokerage);
  });

  it("counts property at its death-date value", () => {
    const withHouse = settlementOf(dies(12, [cash(10_000)], { properties: [house(300_000)] }));
    expect(withHouse.propertyValuesCents).toBe(dollarsToCents(300_000));
    expect(withHouse.estateAssetsCents).toBe(dollarsToCents(310_000));
  });

  it("excludes pre-tax retirement from the estate and reports it as the beneficiaries'", () => {
    const settlement = settlementOf(dies(12, [cash(10_000), preTax(500_000)]));
    expect(settlement.estateAccountsCents).toBe(dollarsToCents(10_000));
    expect(settlement.beneficiaryRetirementAssetsCents).toBe(dollarsToCents(500_000));
    // Excluded from the funding pool, NOT deleted: the balance is intact in the final month and
    // reported in full beside the estate.
    expect(dies(12, [cash(10_000), preTax(500_000)]).months[11].accountBalancesCents.pretax).toBe(
      dollarsToCents(500_000),
    );
  });

  it("excludes a Roth the same way, whatever its withdrawal tax treatment", () => {
    const settlement = settlementOf(dies(12, [cash(10_000), roth(90_000)]));
    expect(settlement.estateAccountsCents).toBe(dollarsToCents(10_000));
    expect(settlement.beneficiaryRetirementAssetsCents).toBe(dollarsToCents(90_000));
  });

  it("never liquidates a retirement account to settle the estate", () => {
    // A household that owes tax and debt at death, holding nothing but a beneficiary-designated
    // account. Under the removed terminal gross-up, funding the tax bill from that account would
    // have realized ordinary income, owed more tax, and sold more of it. Here it is not touched,
    // and the shortfall is reported instead.
    const settlement = settlementOf(retiredWithLoanAt(18));
    const last = retiredWithLoanAt(18).months[23];
    expect(settlement.beneficiaryRetirementAssetsCents).toBe(last.accountBalancesCents.pretax);
    expect(settlement.finalTaxDueCents).toBeGreaterThan(0);
  });
});

describe("Estate settlement — obligations and the verdict", () => {
  it("weighs the debt balance outstanding on the day, not the payments that would have followed", () => {
    const debtFree = settlementOf(dies(12, [cash(200_000)], { incomeSeries: [series(2_000)] }));
    const indebted = dies(12, [cash(200_000)], {
      incomeSeries: [series(2_000)],
      liabilities: [
        loan(60_000, -1, 0, 600),
      ],
    });
    const settlement = settlementOf(indebted);
    // Twelve payments in, so the balance is below the $60k it opened at — and it is that balance,
    // not the 588 remaining payments, that the estate has to clear.
    expect(settlement.outstandingDebtCents).toBe(indebted.months[11].liabilityBalancesCents.loan);
    expect(settlement.outstandingDebtCents).toBeLessThan(dollarsToCents(60_000));
    expect(settlement.outstandingDebtCents).toBeGreaterThan(dollarsToCents(58_000));
    expect(settlement.estateSurplusCents).toBeLessThan(debtFree.estateSurplusCents);
  });

  it("passes when cash and taxable investments cover what is owed", () => {
    const settlement = settlementOf(
      dies(12, [cash(120_000), brokerage(40_000)], {
        liabilities: [
          loan(60_000, -1, 0, 600),
        ],
      }),
    );
    expect(settlement.estateAssetsCents).toBeGreaterThan(settlement.estateObligationsCents);
    expect(settlement.estateSurplusCents).toBeGreaterThan(0);
    expect(settlement.isSolvent).toBe(true);
  });

  it("fails on estate assets alone, however large the beneficiaries' inheritance", () => {
    // The specification's worked example: a household dying with half a million in a retirement
    // account and not enough outside it to clear a mortgage. The inheritance is real and reported;
    // it is simply not available to the creditors.
    const indebted = dies(12, [cash(10_000), brokerage(40_000), preTax(500_000)], {
      liabilities: [
        loan(65_000, -1, 0, 600),
      ],
    });
    const settlement = settlementOf(indebted);
    expect(settlement.estateAccountsCents).toBeLessThan(dollarsToCents(50_000));
    expect(settlement.beneficiaryRetirementAssetsCents).toBe(dollarsToCents(500_000));
    expect(settlement.estateSurplusCents).toBeLessThan(0);
    expect(settlement.isSolvent).toBe(false);
    // The shortfall is stated, not absorbed: no negative cash balance was manufactured to close
    // it, and the retirement account is untouched.
    expect(indebted.months[11].accountBalancesCents.pretax).toBe(dollarsToCents(500_000));
    expect(indebted.months[11].accountBalancesCents.cash).toBeGreaterThanOrEqual(0);
  });

  it("states the surplus as assets less obligations, both of them stated too", () => {
    const settlement = settlementOf(dies(12, [cash(10_000), preTax(500_000)]));
    expect(settlement.estateAssetsCents).toBe(
      settlement.estateAccountsCents + settlement.propertyValuesCents + settlement.finalTaxRefundCents,
    );
    expect(settlement.estateObligationsCents).toBe(
      settlement.finalTaxDueCents + settlement.outstandingDebtCents,
    );
    expect(settlement.estateSurplusCents).toBe(
      settlement.estateAssetsCents - settlement.estateObligationsCents,
    );
    expect(settlement.isSolvent).toBe(settlement.estateSurplusCents >= 0);
  });
});

describe("Estate settlement — the retirement solver's terminal criterion", () => {
  /** Lifetime-solvent throughout: wages cover the spending, so no month is ever short. */
  function livesComfortably(cashDollars: number): ProjectionSeries {
    return dies(24, [cash(cashDollars), preTax(400_000)], {
      incomeSeries: [series(6_000)],
      expenseSeries: [series(3_000)],
      liabilities: [
        loan(150_000, -1, 0, 600),
      ],
    });
  }

  it("rejects a plan that is solvent every month but leaves an estate that cannot pay up", () => {
    const thin = livesComfortably(1_000);
    expect(thin.months.every((m) => !m.isInsolvent)).toBe(true);
    expect(settlementOf(thin).isSolvent).toBe(false);
    // Judged on months alone this plan retires comfortably on a mortgage nobody ever pays off.
    expect(planOutcome(thin)).toBe("fails");
  });

  it("accepts the same plan once the estate can cover the debt and the final tax", () => {
    const funded = livesComfortably(200_000);
    expect(settlementOf(funded).isSolvent).toBe(true);
    expect(planOutcome(funded)).toBe("survives");
  });

  it("leaves the verdict on a run with no death exactly as it was", () => {
    // No estate settlement, no terminal test — a horizon nobody died at is judged on its months
    // alone, which is what every engine-level fixture relies on.
    const noDeath = stopsAtHorizon(24, [cash(1_000), preTax(400_000)], {
      incomeSeries: [series(6_000)],
      expenseSeries: [series(3_000)],
    });
    expect(noDeath.estateSettlement).toBeUndefined();
    expect(planOutcome(noDeath)).toBe("survives");
  });
});

describe("Estate settlement — cost", () => {
  it("prices the estate once, not once per year, and adds no simulation pass", () => {
    function taxCallsFor(years: number, declareDeath: boolean): number {
      let calls = 0;
      const counting: Jurisdiction = {
        ...flatAnnual(RATE),
        computeTaxCents: (byCat, ctx) => {
          calls += 1;
          return flatAnnual(RATE).computeTaxCents(byCat, ctx);
        },
      };
      simulateHousehold(
        {
          horizonMonths: 12 * years,
          ...(declareDeath ? { householdDeathMonthExclusive: 12 * years } : {}),
          annualInflationRate: 0,
          startYear: 2026,
          persons: [{ id: "p1", name: "You" }],
          accounts: [cash(500_000), preTax(500_000)],
          incomeSeries: [series(5_000)],
          expenseSeries: [series(3_000)],
        },
        counting,
      );
      return calls;
    }
    // One extra pricing call per person, whatever the run's length: the settlement is a single
    // local calculation on the terminal state, not a pass over the years.
    expect(taxCallsFor(1, true) - taxCallsFor(1, false)).toBe(1);
    expect(taxCallsFor(40, true) - taxCallsFor(40, false)).toBe(1);
  });
});

describe("Estate settlement — life is unchanged", () => {
  it("still pays a smooth monthly estimate and still settles the prior year in April", () => {
    const working = dies(36, [cash(50_000)], { incomeSeries: [series(10_000)] });
    const taxes = working.months.map((m) => m.flows!.taxCents);
    // Twelve equal instalments a year on steady wages — no December spike, no terminal spike.
    for (let month = 0; month < 12; month++) {
      expect(Math.abs(taxes[month] - dollarsToCents(2_500))).toBeLessThanOrEqual(1);
    }
    // The estimate is exact on wages this steady, so April of year 2 settles nothing and looks
    // like every other month.
    expect(Math.abs(taxes[15] - taxes[14])).toBeLessThanOrEqual(1);
    expect(sum(taxes)).toBe(dollarsToCents(90_000));
    // And nothing is left for the estate to finish.
    expect(settlementOf(working).finalTaxDueCents).toBe(0);
  });

  it("settles a real prior-year balance in April, not at the horizon", () => {
    // The mid-year loan makes year 1 miss its estimate. April of year 2 is where that balance is
    // charged — the estate never sees it, because the household lived to file.
    const settled = retiredWithLoanAt(6, 24);
    const aprilCents = settled.months[15].flows!.taxCents;
    const marchCents = settled.months[14].flows!.taxCents;
    expect(aprilCents).toBeGreaterThan(marchCents);
  });
});
