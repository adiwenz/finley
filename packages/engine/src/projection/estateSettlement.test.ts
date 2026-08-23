import { describe, it, expect } from "vitest";
import { flatWageWithholding } from "../testing/mockJurisdiction";
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
    // Payroll withholds at the same flat rate, so a level wage year settles to nothing and any
    // April balance in these tests is genuinely about death and the estate, not about withholding.
    computeWageWithholdingCents: flatWageWithholding(rate),
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

/**
 * The same stream, tagged `wages` — what payroll actually withholds against. Income in these
 * tests is a salary, and the whole final-tax-vs-estate arithmetic turns on what was withheld
 * before death, so the tag is load-bearing rather than decorative.
 */
function wageSeries(monthlyDollars: number, startMonth = 0, endMonth?: number): SimOwnedSeries {
  const s = series(monthlyDollars, startMonth, endMonth);
  return {
    ...s,
    series: new SimCashFlowSeries(startMonth, dollarsToCents(monthlyDollars), { type: "fixed" }, {
      baselineUnit: "monthly",
      taxCategory: "wages",
      ...(endMonth !== undefined ? { endMonth } : {}),
    }),
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
    computeWageWithholdingCents: flatWageWithholding(0.1),
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
    expect(settlementOf(insolvent).isEconomicallySolvent).toBe(false);
    expect(settlementOf(insolvent).isProbateSolvent).toBe(false);
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
    // The final year's OWN charges: April is the one month carrying tax from two years at once, so
    // the balance it settles for the year before — which the estimate's circular residue makes a
    // real figure, not a rounding one — comes back out. March measures the twelfth alone.
    const instalmentsCents =
      sum(months.map((m) => m.flows!.taxCents)) - (months[3]!.flows!.taxCents - months[2]!.flows!.taxCents);
    // Instalments paced off January's estimate, plus the balance the estate is left with, equal
    // the flat rate on what the year actually earned. The estimate missed; the estate pays.
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
    // Dying in June leaves six months of flat-rate withholding against six months of wages the
    // progressive schedule taxes more lightly — an overpayment, and the estate collects it.
    // $60k of wages withheld at 10% is $6,000 paid in; the same $60k owes $4,000 here.
    const settlement = settlementOf(
      dies(18, [cash(50_000)], { incomeSeries: [wageSeries(10_000)] }, progressiveAnnual()),
    );
    expect(settlement.finalTaxDueCents).toBe(0);
    expect(settlement.finalTaxRefundCents).toBe(dollarsToCents(2_000));
    // Probate assets are the accounts PLUS the refund, and both verdicts carry it through.
    expect(settlement.probateAssetsCents).toBe(
      settlement.estateAccountsCents + settlement.finalTaxRefundCents,
    );
    expect(settlement.probateSurplusCents).toBe(
      settlement.probateAssetsCents - settlement.unsecuredDebtCents,
    );
    expect(settlement.terminalEconomicNetWorthCents).toBe(
      settlement.totalAssetsCents + settlement.finalTaxRefundCents,
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
    expect(settlement.probateAssetsCents).toBe(dollarsToCents(50_000));
    expect(settlement.probateSurplusCents).toBe(dollarsToCents(50_000));
    expect(settlement.terminalEconomicNetWorthCents).toBe(dollarsToCents(50_000));
    expect(settlement.isEconomicallySolvent).toBe(true);
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
    expect(appreciated.probateAssetsCents - appreciated.estateAccountsCents).toBe(
      asCash.probateAssetsCents - asCash.estateAccountsCents,
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
    // Ground truth for the returned principal is the basis reduction itself; ground truth for the
    // realized gain is the `capitalGains` band, which reports the gain ALONE rather than the
    // draw's full gross. Together they are exactly what the brokerage paid out this year: the
    // $48k of expenses and not one cent more, because nothing withholds against a brokerage sale
    // and so no month had a tax charge for the same account to fund.
    const basisConsumedCents = dollarsToCents(100_000) - last.accountBasisCents.brokerage;
    const gainRealizedCents = sum(
      spent.months.map((m) => m.flows!.cashFlowIncomeByCategoryCents["capitalGains"] ?? 0),
    );
    const grossDrawnCents = basisConsumedCents + gainRealizedCents;
    expect(grossDrawnCents).toBe(dollarsToCents(48_000));
    expect(basisConsumedCents).toBeGreaterThan(0);
    expect(gainRealizedCents).toBeGreaterThan(0);
    // Everything the year owed, wherever it was charged: the ordinary rate on realized GAIN, not
    // on the gross the household actually spent.
    expect(sum(spent.months.map((m) => m.flows!.taxCents)) + settlement.finalTaxDueCents).toBe(
      Math.round(gainRealizedCents * RATE),
    );
    // What was never sold carries an unrealized gain of the same size again, and the estate takes
    // it at value with nothing owed on it.
    expect(settlement.estateAccountsCents).toBe(last.accountBalancesCents.brokerage);
    expect(last.accountBalancesCents.brokerage).toBeGreaterThan(last.accountBasisCents.brokerage);
  });

  it("counts property at its death-date value", () => {
    const withHouse = settlementOf(dies(12, [cash(10_000)], { properties: [house(300_000)] }));
    expect(withHouse.propertyValuesCents).toBe(dollarsToCents(300_000));
    // Unmortgaged, so all of it is equity and all of it reaches probate.
    expect(withHouse.probateAssetsCents).toBe(dollarsToCents(310_000));
    expect(withHouse.totalAssetsCents).toBe(dollarsToCents(310_000));
  });

  it("excludes pre-tax retirement from PROBATE while still counting it as wealth", () => {
    const settlement = settlementOf(dies(12, [cash(10_000), preTax(500_000)]));
    expect(settlement.estateAccountsCents).toBe(dollarsToCents(10_000));
    expect(settlement.beneficiaryRetirementAssetsCents).toBe(dollarsToCents(500_000));
    // Out of the creditors' reach, in the household's economic position: a designation routes
    // wealth, it does not destroy it.
    expect(settlement.probateAssetsCents).toBe(dollarsToCents(10_000));
    expect(settlement.totalAssetsCents).toBe(dollarsToCents(510_000));
    expect(settlement.terminalEconomicNetWorthCents).toBe(dollarsToCents(510_000));
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
    const debtFree = settlementOf(dies(12, [cash(200_000)], { incomeSeries: [wageSeries(2_000)] }));
    const indebted = dies(12, [cash(200_000)], {
      incomeSeries: [wageSeries(2_000)],
      liabilities: [
        loan(60_000, -1, 0, 600),
      ],
    });
    const settlement = settlementOf(indebted);
    // Twelve payments in, so the balance is below the $60k it opened at — and it is that balance,
    // not the 588 remaining payments, that the estate has to clear.
    expect(settlement.totalDebtCents).toBe(indebted.months[11].liabilityBalancesCents.loan);
    expect(settlement.totalDebtCents).toBeLessThan(dollarsToCents(60_000));
    expect(settlement.totalDebtCents).toBeGreaterThan(dollarsToCents(58_000));
    expect(settlement.terminalEconomicNetWorthCents).toBeLessThan(
      debtFree.terminalEconomicNetWorthCents,
    );
  });

  it("passes when the assets cover what is owed", () => {
    const settlement = settlementOf(
      dies(12, [cash(120_000), brokerage(40_000)], {
        liabilities: [
          loan(60_000, -1, 0, 600),
        ],
      }),
    );
    expect(settlement.terminalEconomicNetWorthCents).toBeGreaterThan(0);
    expect(settlement.isEconomicallySolvent).toBe(true);
    expect(settlement.isProbateSolvent).toBe(true);
  });

  it("states the economic position as everything owned less everything owed", () => {
    const settlement = settlementOf(dies(12, [cash(10_000), preTax(500_000)]));
    expect(settlement.totalAssetsCents).toBe(
      settlement.estateAccountsCents +
        settlement.beneficiaryRetirementAssetsCents +
        settlement.propertyValuesCents,
    );
    expect(settlement.terminalEconomicNetWorthCents).toBe(
      settlement.totalAssetsCents +
        settlement.finalTaxRefundCents -
        settlement.totalDebtCents -
        settlement.finalTaxDueCents,
    );
    expect(settlement.isEconomicallySolvent).toBe(
      settlement.terminalEconomicNetWorthCents >= 0,
    );
  });

  it("reconciles with the final month's net worth, up to the tax the run could not charge", () => {
    // The settlement invents no asset and forgives no debt: it is the last month's balance sheet
    // plus the one thing the projection had no April left to book.
    const dying = retiredWithLoanAt(18);
    const settlement = settlementOf(dying);
    expect(settlement.terminalEconomicNetWorthCents).toBe(
      dying.months[23].netWorthNominalCents! -
        settlement.finalTaxDueCents +
        settlement.finalTaxRefundCents,
    );
  });
});

describe("Estate settlement — probate distribution", () => {
  /** A mortgaged home: the property names the loan securing it, as a real purchase would. */
  function mortgagedHouse(valueDollars: number): Partial<HouseholdSimInput> {
    return {
      properties: [{ ...house(valueDollars), mortgageLiabilityId: "loan" }],
      liabilities: [loan(200_000, -1, 0, 600)],
    };
  }

  it("lets collateral answer for the debt it secures, and passes the equity to probate", () => {
    const run = dies(12, [cash(10_000)], mortgagedHouse(300_000));
    const settlement = settlementOf(run);
    const balanceCents = run.months[11].liabilityBalancesCents.loan;
    expect(settlement.securedDebtCents).toBe(balanceCents);
    // The house is worth more than the mortgage, so the mortgage is covered in full and only the
    // equity — value less the balance — reaches the creditors' pool alongside what cash is left.
    expect(settlement.collateralAppliedCents).toBe(balanceCents);
    expect(settlement.securedDeficiencyCents).toBe(0);
    expect(settlement.unsecuredDebtCents).toBe(0);
    expect(settlement.probateAssetsCents).toBe(
      run.months[11].accountBalancesCents.cash + dollarsToCents(300_000) - balanceCents,
    );
  });

  it("drops an underwater mortgage's deficiency into the unsecured queue", () => {
    // A $120k house against a ~$196k mortgage: the collateral clears what it is worth and the
    // rest becomes an ordinary claim on whatever cash is left.
    const underwater = dies(12, [cash(10_000)], mortgagedHouse(120_000));
    const settlement = settlementOf(underwater);
    const balanceCents = underwater.months[11].liabilityBalancesCents.loan;
    expect(settlement.collateralAppliedCents).toBe(dollarsToCents(120_000));
    expect(settlement.securedDeficiencyCents).toBe(balanceCents - dollarsToCents(120_000));
    expect(settlement.unsecuredDebtCents).toBe(settlement.securedDeficiencyCents);
    // No equity: the house is entirely spoken for, so probate holds only the cash.
    expect(settlement.probateAssetsCents).toBe(underwater.months[11].accountBalancesCents.cash);
    expect(settlement.isProbateSolvent).toBe(false);
  });

  it("leaves unsecured debt unpaid rather than reaching into a beneficiary's account", () => {
    // The old worked example, re-judged. Probate cannot clear the loan and does not pretend to;
    // the shortfall is named, the inheritance passes intact, and no balance moved to close it.
    const indebted = dies(12, [cash(10_000), brokerage(40_000), preTax(500_000)], {
      liabilities: [loan(65_000, -1, 0, 600)],
    });
    const settlement = settlementOf(indebted);
    expect(settlement.probateAssetsCents).toBeLessThan(dollarsToCents(50_000));
    expect(settlement.probateSurplusCents).toBeLessThan(0);
    expect(settlement.isProbateSolvent).toBe(false);
    expect(settlement.unpaidObligationsCents).toBe(-settlement.probateSurplusCents);
    expect(settlement.heirDistributionCents).toBe(dollarsToCents(500_000));
    expect(indebted.months[11].accountBalancesCents.pretax).toBe(dollarsToCents(500_000));
    expect(indebted.months[11].accountBalancesCents.cash).toBeGreaterThanOrEqual(0);
  });

  it("hands the probate residue to the heirs alongside the designated accounts", () => {
    const settlement = settlementOf(dies(12, [cash(50_000), preTax(500_000)]));
    expect(settlement.unpaidObligationsCents).toBe(0);
    expect(settlement.heirDistributionCents).toBe(dollarsToCents(550_000));
  });
});

describe("Estate settlement — the retirement solver's terminal criterion", () => {
  /**
   * Lifetime-solvent throughout — wages cover the spending, so no month is ever short — and
   * carrying a long unsecured loan all the way to death. `retirementDollars` is the only lever:
   * it moves wealth, never liquidity, which is precisely the distinction under test.
   */
  function livesComfortably(cashDollars: number, retirementDollars: number): ProjectionSeries {
    return dies(24, [cash(cashDollars), preTax(retirementDollars)], {
      incomeSeries: [wageSeries(6_000)],
      expenseSeries: [series(3_000)],
      liabilities: [
        loan(150_000, -1, 0, 600),
      ],
    });
  }

  it("rejects a plan that is solvent every month but dies owing more than it owns", () => {
    const short = livesComfortably(1_000, 0);
    expect(short.months.every((m) => !m.isInsolvent)).toBe(true);
    expect(settlementOf(short).terminalEconomicNetWorthCents).toBeLessThan(0);
    // Judged on months alone this plan retires comfortably on a loan nobody ever pays off.
    expect(planOutcome(short)).toBe("fails");
  });

  it("accepts a plan whose wealth sits in a beneficiary-designated account, thin probate and all", () => {
    // Same liquidity, same debt, same months — and now enough wealth to cover what is owed, held
    // where probate cannot reach it. The estate still goes short and says so; the retirement is
    // feasible anyway, because the household was never actually poor.
    const funded = livesComfortably(1_000, 400_000);
    const settlement = settlementOf(funded);
    expect(settlement.probateAssetsCents).toBeLessThan(settlement.probateObligationsCents);
    expect(settlement.isProbateSolvent).toBe(false);
    expect(settlement.unpaidObligationsCents).toBeGreaterThan(0);
    expect(settlement.terminalEconomicNetWorthCents).toBeGreaterThan(0);
    expect(planOutcome(funded)).toBe("survives");
  });

  it("does not fail a household whose probate estate is empty but whose IRA is not", () => {
    // The regression this criterion exists for. Spending cash before selling investments leaves
    // the probate estate at zero and the retirement account fuller — a strictly wealthier plan
    // that the old probate test rejected over a few cents of unsettled final tax.
    const emptyProbate = dies(24, [cash(0), preTax(500_000)], {
      expenseSeries: [series(4_000)],
      liabilities: [loan(50_000, 18, 0.05, 60)],
    });
    const settlement = settlementOf(emptyProbate);
    expect(settlement.estateAccountsCents).toBe(0);
    expect(settlement.finalTaxDueCents).toBeGreaterThan(0);
    expect(settlement.isProbateSolvent).toBe(false);
    expect(settlement.beneficiaryRetirementAssetsCents).toBeGreaterThan(dollarsToCents(300_000));
    expect(settlement.terminalEconomicNetWorthCents).toBeGreaterThan(0);
    expect(planOutcome(emptyProbate)).toBe("survives");
  });

  it("fails a household that dies holding nothing and still owing money", () => {
    // No income, no assets, and a loan whose payments are met on the synthetic card — never
    // insolvent, because the card is never exhausted, and terminally worth less than nothing.
    const broke = dies(24, [cash(0)], { liabilities: [loan(150_000, -1, 0, 600)] });
    const settlement = settlementOf(broke);
    expect(broke.months.every((m) => !m.isInsolvent)).toBe(true);
    expect(settlement.totalAssetsCents).toBe(0);
    // The loan it has been paying down, PLUS the card it paid with — the borrowing that kept it
    // out of insolvency is debt like any other, and the terminal test is where it lands.
    expect(settlement.totalDebtCents).toBe(
      broke.months[23].liabilityBalancesCents.loan +
        broke.months[23].liabilityBalancesCents["synthetic-credit-card"],
    );
    expect(settlement.totalDebtCents).toBeGreaterThan(dollarsToCents(150_000));
    expect(settlement.terminalEconomicNetWorthCents).toBe(-settlement.totalDebtCents);
    expect(planOutcome(broke)).toBe("fails");
  });

  it("counts a house and its mortgage on BOTH sides, netting to the equity", () => {
    const mortgaged = dies(12, [cash(200_000)], {
      properties: [{ ...house(300_000), mortgageLiabilityId: "loan" }],
      liabilities: [loan(200_000, -1, 0, 600)],
    });
    const neither = dies(12, [cash(200_000)]);
    const settlement = settlementOf(mortgaged);
    const balanceCents = mortgaged.months[11].liabilityBalancesCents.loan;
    // Both sides present, neither one quietly dropped.
    expect(settlement.propertyValuesCents).toBe(dollarsToCents(300_000));
    expect(settlement.totalDebtCents).toBe(balanceCents);
    // Every mortgage payment moved a dollar from cash to principal, so at 0% the two cancel and
    // the whole difference is the equity the household bought with its down payment.
    expect(settlement.terminalEconomicNetWorthCents).toBe(
      settlementOf(neither).terminalEconomicNetWorthCents + dollarsToCents(100_000),
    );
    expect(planOutcome(mortgaged)).toBe("survives");
  });

  it("never improves the verdict by borrowing money and spending it", () => {
    // A loan that originates with no paired asset IS borrow-and-spend: the debt arrives, the
    // proceeds are gone, and the payments drain what was there. It can only ever cost.
    const unborrowed = dies(24, [cash(1_000)], {
      incomeSeries: [wageSeries(6_000)],
      expenseSeries: [series(3_000)],
    });
    const borrowed = livesComfortably(1_000, 0);
    expect(planOutcome(unborrowed)).toBe("survives");
    expect(settlementOf(borrowed).terminalEconomicNetWorthCents).toBeLessThan(
      settlementOf(unborrowed).terminalEconomicNetWorthCents,
    );
    expect(planOutcome(borrowed)).toBe("fails");
  });

  /**
   * **Where exactly the line falls.** `isEconomicallySolvent` is `terminalEconomicNetWorthCents >=
   * 0`, and every test above lands comfortably on one side of it or the other — none of them can
   * tell `>= 0` from `> 0`, or catch the boundary drifting by a rounding step. A household that
   * dies having exactly broken even has met its obligations in full and owes nobody anything; one
   * cent short has not.
   *
   * Built so the terminal figure is EXACTLY controllable: no income, no spending, no tax, and a 0%
   * loan, so every payment moves a dollar of cash against a dollar of principal and the two cancel.
   * Terminal net worth is then the opening cash less the opening debt, to the cent, whatever the
   * horizon.
   */
  describe("the boundary itself", () => {
    const DEBT_CENTS = dollarsToCents(150_000);

    function diesWorthExactly(netCents: Cents): ProjectionSeries {
      return dies(
        12,
        [
          new SimAccount({
            id: "cash",
            ownerId: "p1",
            liquid: true,
            taxProfile: CASH_INTEREST_TAX_PROFILE,
            openingBalanceCents: DEBT_CENTS + netCents,
            initialAnnualRate: 0,
          }),
        ],
        { liabilities: [loan(150_000, -1, 0, 600)] },
      );
    }

    it("is where the fixture says it is — the lever moves the terminal figure cent for cent", () => {
      // The premise every assertion below rests on: nothing else is moving.
      expect(settlementOf(diesWorthExactly(0)).terminalEconomicNetWorthCents).toBe(0);
      expect(settlementOf(diesWorthExactly(-1)).terminalEconomicNetWorthCents).toBe(-1);
      expect(settlementOf(diesWorthExactly(1)).terminalEconomicNetWorthCents).toBe(1);
    });

    it("passes a household that dies having broken even to the cent", () => {
      const evens = diesWorthExactly(0);
      expect(settlementOf(evens).isEconomicallySolvent).toBe(true);
      expect(planOutcome(evens)).toBe("survives");
    });

    it("fails the same household one cent short", () => {
      const short = diesWorthExactly(-1);
      // Not a liquidity failure — every month funded itself either way, so the verdict changed on
      // the terminal test alone.
      expect(short.months.every((m) => !m.isInsolvent)).toBe(true);
      expect(settlementOf(short).isEconomicallySolvent).toBe(false);
      expect(planOutcome(short)).toBe("fails");
    });
  });

  /**
   * **The same boundary, with the FINAL TAX as the lever.** Above, the terminal figure is moved by
   * the opening cash and `finalTaxDueCents` is zero throughout — so the one term the projection
   * never charged to a month is never the term deciding the verdict. It is also the term most
   * worth pinning: a sign error or an off-by-one in `totalAssets − totalDebt − finalTaxDue` would
   * leave every other test in this file green, because they all assert only that it is positive.
   *
   * A household near the end of life, dying in June of its last year: it takes a $240,000 lump
   * distribution in January, spends $120,000 in February, and carries an unsecured $70,000 loan to
   * the grave. That shape is what makes the tax controllable — the year's liability is paced as
   * twelve instalments and death stops it after six, so exactly half the year's tax is left
   * outstanding, and the schedule below sets what half that is.
   */
  describe("the boundary, with the final tax as the lever", () => {
    /**
     * A schedule pricing this household's year at exactly `annualLiabilityCents`. Flat rates and
     * progressive brackets alike make the liability a function of the income, and the income is
     * also on the balance sheet — so neither can move the tax by one cent without moving the
     * assets too, and neither can put the terminal figure exactly on the line. Gated on there
     * being income at all, so the estate is charged for a year the household actually earned in.
     */
    function owesExactly(annualLiabilityCents: Cents): Jurisdiction {
      const scalar = (byCat: Partial<Record<string, number>>): Cents =>
        CATEGORIES.reduce((s, c) => s + (byCat[c] ?? 0), 0) > 0 ? annualLiabilityCents : 0;
      return {
        id: "fixed-liability",
        computeTaxCents: scalar,
        computeTaxByCategoryCents: (byCat) => ({ ordinaryIncome: scalar(byCat) }),
        // Withholds HALF the year's fixed liability from this household's single paycheck. Half
        // is the lever these boundary tests need: it leaves the estate carrying the other half,
        // so the terminal figure moves with the tax and can be put exactly on the line.
        computeWageWithholdingCents: (request) =>
          request.taxCategory === "wages" && request.regularWagesCents > 0
            ? Math.round(annualLiabilityCents / 2)
            : 0,
      };
    }

    /** Dies in June, six instalments into a year priced at `annualLiabilityCents`. */
    function diesOwing(annualLiabilityCents: Cents): ProjectionSeries {
      return dies(
        6,
        [cash(10_000)],
        {
          incomeSeries: [wageSeries(240_000, 0, 0)],
          expenseSeries: [series(120_000, 1, 1)],
          liabilities: [loan(70_000, -1, 0, 600)],
        },
        owesExactly(annualLiabilityCents),
      );
    }

    const paidInLifeCents = (run: ProjectionSeries): Cents =>
      sum(run.months.map((m) => m.flows!.taxCents));

    it("halves a year's tax at a June death — half withheld in life, half left to the estate", () => {
      // The premise. $60,000 for the year, half of it withheld from the household's one paycheck,
      // dead in June: the estate's charge is the half nobody withheld, not a residue of anything.
      const run = diesOwing(dollarsToCents(60_000));
      expect(run.months.map((m) => m.flows!.taxCents)).toEqual([
        dollarsToCents(30_000),
        0,
        0,
        0,
        0,
        0,
      ]);
      expect(paidInLifeCents(run)).toBe(dollarsToCents(30_000));
      expect(settlementOf(run).finalTaxDueCents).toBe(dollarsToCents(30_000));
      expect(settlementOf(run).finalTaxRefundCents).toBe(0);
      // And the position it is charged against: $100,000 of assets against $70,000 of debt, less
      // the loan principal repaid on the way, which leaves cash and debt lower by the same amount.
      const last = run.months[5]!;
      expect(settlementOf(run).totalAssetsCents).toBe(last.accountBalancesCents.cash);
      expect(settlementOf(run).totalAssetsCents - settlementOf(run).totalDebtCents).toBe(
        dollarsToCents(30_000),
      );
    });

    it("passes a household whose final tax bill takes it to exactly nothing", () => {
      // $30,000 of assets over debt, $30,000 owed: it dies having met every obligation in full
      // with not a cent to spare, which is solvent.
      const evens = diesOwing(dollarsToCents(60_000));
      expect(settlementOf(evens).terminalEconomicNetWorthCents).toBe(0);
      expect(settlementOf(evens).isEconomicallySolvent).toBe(true);
      expect(planOutcome(evens)).toBe("survives");
    });

    it("fails the same household for one cent more of tax", () => {
      const short = diesOwing(dollarsToCents(60_000) + 1);
      expect(short.months.every((m) => !m.isInsolvent)).toBe(true);
      expect(settlementOf(short).terminalEconomicNetWorthCents).toBe(-1);
      expect(settlementOf(short).isEconomicallySolvent).toBe(false);
      expect(planOutcome(short)).toBe("fails");
    });

    it("charges the estate the cent, not just the year — the settlement's own term moves", () => {
      // The cent above rounds into the withheld half, so it is the paycheck that got dearer and
      // the estate's charge that stayed put. Two cents splits one to each half, which is the
      // assertion that pins `finalTaxDueCents`: nothing else in this file states it to the cent.
      const dearer = diesOwing(dollarsToCents(60_000) + 2);
      expect(paidInLifeCents(dearer)).toBe(dollarsToCents(30_000) + 1);
      expect(settlementOf(dearer).finalTaxDueCents).toBe(dollarsToCents(30_000) + 1);
      expect(settlementOf(dearer).terminalEconomicNetWorthCents).toBe(-2);
      expect(planOutcome(dearer)).toBe("fails");
    });

    it("would have passed on its months alone — the tax is what fails it", () => {
      // Every month funded itself in all three runs, and the balance sheet is the same in all
      // three: nothing but the unpaid tax separates the survivor from the two failures.
      const runs = [60_000_00, 60_000_01, 60_000_02].map((l) => diesOwing(l));
      for (const run of runs) expect(run.months.every((m) => !m.isInsolvent)).toBe(true);
      expect(new Set(runs.map((r) => settlementOf(r).totalDebtCents)).size).toBe(1);
      expect(runs.map((r) => planOutcome(r))).toEqual(["survives", "fails", "fails"]);
    });
  });

  it("leaves the verdict on a run with no death exactly as it was", () => {
    // No estate settlement, no terminal test — a horizon nobody died at is judged on its months
    // alone, which is what every engine-level fixture relies on.
    const noDeath = stopsAtHorizon(24, [cash(1_000), preTax(400_000)], {
      incomeSeries: [wageSeries(6_000)],
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
          incomeSeries: [wageSeries(5_000)],
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
    const working = dies(36, [cash(50_000)], { incomeSeries: [wageSeries(10_000)] });
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
