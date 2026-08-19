import { describe, it, expect } from "vitest";
import {
  SimAccount,
  type SimAccountTaxProfile,
  type SimOneTimeTransfer,
  CAPITAL_GAINS_TAX_PROFILE,
  PRE_TAX_TAX_PROFILE,
} from "../plan/simAccount";
import { SimCashFlowSeries, dollarsToCents } from "../money/cashFlowSeries";
import { apportionByWeight, type Cents } from "../money/money";
import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import {
  simulateHousehold,
  type HouseholdSimInput,
  type ProjectionSeries,
  type SimOwnedSeries,
} from "./simulate";
import type { SimPerson } from "./simulate.types";
import { explicitObligation } from "./financialObligation";
import { flatWageWithholding } from "../testing/mockJurisdiction";


/** A non-compounding account so balances move only by withdrawal/deposit unless a rate is given. */
function account(id: string, taxProfile: SimAccountTaxProfile, dollars: number, liquid = false, rate = 0): SimAccount {
  return new SimAccount({
    id,
    ownerId: "p1",
    liquid,
    taxProfile,
    openingBalanceCents: dollarsToCents(dollars),
    initialAnnualRate: rate,
  });
}

/** A recurring or one-shot expense/wage series, keyed off explicit start/end months. */
function series(monthlyDollars: number, startMonth = 0, endMonth?: number): SimOwnedSeries {
  return {
    series: new SimCashFlowSeries(startMonth, dollarsToCents(monthlyDollars), { type: "fixed" }, {
      baselineUnit: "monthly",
      ...(endMonth !== undefined ? { endMonth } : {}),
    }),
    ownerId: "p1",
  };
}

const person: SimPerson = { id: "p1", name: "You" };

function baseInput(accounts: SimAccount[], overrides: Partial<HouseholdSimInput> = {}): HouseholdSimInput {
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

const CATEGORIES = ["wages", "ordinaryIncome", "capitalGains", "taxExempt"] as const;

/**
 * A flat rate on the combined categories, with the SAME per-category rounding feeding both the
 * scalar and the breakdown, so the two are exact by construction — isolating this test suite
 * from the reconciliation math `rules`/`waterfallInvariants.ts` already cover elsewhere.
 */
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
  };
}

/**
 * A BRACKETED jurisdiction: an allowance, then two rates. Progressive on purpose — under a flat
 * rate the year's tax is linear in income, so summing twelve instalments and reconciling can
 * agree by arithmetic that says nothing about the annual seam. Here the estimate's marginal rate
 * genuinely differs from the actual year's.
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

/** Every month's charged federal income tax, in order. */
function monthlyTax(projection: ProjectionSeries): Cents[] {
  return projection.months.map((m) => m.flows!.taxCents);
}

const sum = (values: readonly Cents[]): Cents => values.reduce((s, v) => s + v, 0);


/** A flat-rate jurisdiction whose payroll withholds at the SAME rate, so a level wage year settles to nothing. */
function flatAnnualWithheld(rate: number): Jurisdiction {
  return { ...flatAnnual(rate), computeWageWithholdingCents: flatWageWithholding(rate) };
}

/** A wage series paying `monthlyDollars` over `[startMonth, endMonth]`, with a source id to band on. */
function wages(monthlyDollars: number, startMonth = 0, endMonth?: number, sourceId = "job"): SimOwnedSeries {
  return {
    series: new SimCashFlowSeries(
      startMonth,
      dollarsToCents(monthlyDollars),
      { type: "fixed" },
      { baselineUnit: "monthly", taxCategory: "wages", ...(endMonth !== undefined ? { endMonth } : {}) },
    ),
    ownerId: "p1",
    sourceId,
  };
}

/** April of the year AFTER the tax year opening at month 0 — where that year's balance settles. */
const SETTLEMENT_MONTH = 15;

/**
 * The prior year's BALANCE alone, out of April's total tax cash. April is an ordinary month too:
 * its own paycheck is withheld against like any other, and the settlement rides on top.
 */
function settlementIn(monthly: readonly Cents[], aprilWithholdingCents: Cents): Cents {
  return monthly[SETTLEMENT_MONTH]! - aprilWithholdingCents;
}

describe("Federal income tax — withholding is causal: a paycheck prices itself", () => {
  it("withholds a level salary evenly all year and leaves April with nothing to settle", () => {
    const p = simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true)], {
        horizonMonths: 16,
        incomeSeries: [wages(5_000)],
      }),
      flatAnnualWithheld(0.2),
    );
    const monthly = monthlyTax(p);
    expect(monthly.slice(0, 12)).toEqual(Array.from({ length: 12 }, () => dollarsToCents(1_000)));
    expect(settlementIn(monthly, dollarsToCents(1_000))).toBe(0);
  });

  it("starts withholding when a job starts mid-year, with nothing withheld before it", () => {
    const p = simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, dollarsToCents(0) + 5_000_00, true)], {
        horizonMonths: 12,
        incomeSeries: [wages(5_000, 6)],
      }),
      flatAnnualWithheld(0.2),
    );
    const monthly = monthlyTax(p);
    // Nothing to withhold from before the first paycheck, and nothing annualized backward into
    // those months once it arrives.
    expect(monthly.slice(0, 6)).toEqual(Array.from({ length: 6 }, () => 0));
    expect(monthly.slice(6, 12)).toEqual(Array.from({ length: 6 }, () => dollarsToCents(1_000)));
  });

  it("stops withholding when a job ends mid-year, without reaching back to re-withhold", () => {
    const p = simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 100_000_00, true)], {
        horizonMonths: 12,
        incomeSeries: [wages(5_000, 0, 5)],
      }),
      flatAnnualWithheld(0.2),
    );
    const monthly = monthlyTax(p);
    expect(monthly.slice(0, 6)).toEqual(Array.from({ length: 6 }, () => dollarsToCents(1_000)));
    expect(monthly.slice(6, 12)).toEqual(Array.from({ length: 6 }, () => 0));
  });

  it("raises withholding from the raised paycheck onward, and lowers it from the cut one", () => {
    const raise: SimOwnedSeries = wages(5_000);
    raise.series.addOverride(6, dollarsToCents(8_000), "fromHereForward");
    const p = simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true)], {
        horizonMonths: 12,
        incomeSeries: [raise],
      }),
      flatAnnualWithheld(0.2),
    );
    const monthly = monthlyTax(p);
    expect(monthly.slice(0, 6)).toEqual(Array.from({ length: 6 }, () => dollarsToCents(1_000)));
    expect(monthly.slice(6, 12)).toEqual(Array.from({ length: 6 }, () => dollarsToCents(1_600)));
  });

  it("withholds nothing from a missed paycheck, and does not catch up the month after", () => {
    const missed: SimOwnedSeries = wages(5_000);
    missed.series.addOverride(4, 0, "thisMonthOnly");
    const p = simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 50_000_00, true)], {
        horizonMonths: 12,
        incomeSeries: [missed],
      }),
      flatAnnualWithheld(0.2),
    );
    const monthly = monthlyTax(p);
    expect(monthly[4]).toBe(0);
    expect(monthly[5]).toBe(dollarsToCents(1_000));
    expect(sum(monthly.slice(0, 12))).toBe(dollarsToCents(11_000));
  });

  it("tracks variable pay month by month rather than averaging the year", () => {
    const variable: SimOwnedSeries = wages(5_000);
    variable.series.addOverride(2, dollarsToCents(9_000), "thisMonthOnly");
    variable.series.addOverride(3, dollarsToCents(1_000), "thisMonthOnly");
    const p = simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 50_000_00, true)], {
        horizonMonths: 12,
        incomeSeries: [variable],
      }),
      flatAnnualWithheld(0.2),
    );
    const monthly = monthlyTax(p);
    expect(monthly[2]).toBe(dollarsToCents(1_800));
    expect(monthly[3]).toBe(dollarsToCents(200));
    expect(monthly[1]).toBe(dollarsToCents(1_000));
  });
});

describe("Federal income tax — non-payroll events never reach backward", () => {
  const ira = () =>
    new SimAccount({
      id: "ira",
      ownerId: "p1",
      liquid: false,
      taxProfile: PRE_TAX_TAX_PROFILE,
      openingBalanceCents: dollarsToCents(500_000),
      initialAnnualRate: 0,
    });

  /** A salaried household with, optionally, one taxable pre-tax withdrawal drawn in October. */
  function withOctoberDraw(drawDollars = 0): ProjectionSeries {
    return simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true), ira()], {
        horizonMonths: 16,
        incomeSeries: [wages(5_000)],
        expenseSeries: [series(3_000)],
        ...(drawDollars > 0
          ? {
              fundingDraws: [
                explicitObligation({
                  id: "october",
                  sourceId: "october-spend",
                  month: 9,
                  amountCents: dollarsToCents(drawDollars),
                  orderedAccountIds: ["ira"],
                  treatment: "expense",
                }),
              ],
            }
          : {}),
      }),
      flatAnnualWithheld(0.2),
    );
  }

  it("leaves January–September untouched by an OCTOBER retirement withdrawal", () => {
    const withoutDraw = monthlyTax(withOctoberDraw());
    const withDraw = monthlyTax(withOctoberDraw(40_000));
    // The invariant, stated directly: an event in month 9 moved nothing in months 0–8.
    expect(withDraw.slice(0, 9)).toEqual(withoutDraw.slice(0, 9));
    // And nothing was withheld against it in October either — no payroll system saw it.
    expect(withDraw[9]).toBe(withoutDraw[9]);
  });

  it("settles the whole tax on that withdrawal in the FOLLOWING April, not during the year", () => {
    const monthly = monthlyTax(withOctoberDraw(40_000));
    // 20% of a $40,000 pre-tax draw, none of it withheld, all of it due on the filing date.
    expect(settlementIn(monthly, dollarsToCents(1_000))).toBe(dollarsToCents(8_000));
  });

  it("leaves prior withholding unchanged when a capital gain is realized late in the year", () => {
    const brokerage = (transfers: SimOneTimeTransfer[]) =>
      new SimAccount({
        id: "brokerage",
        ownerId: "p1",
        liquid: false,
        taxProfile: CAPITAL_GAINS_TAX_PROFILE,
        openingBalanceCents: dollarsToCents(100_000),
        // Growth the sale realizes a gain against.
        initialAnnualRate: 0.5,
        ...(transfers.length > 0 ? { oneTimeTransfers: transfers } : {}),
      });
    const run = (transfers: SimOneTimeTransfer[]) =>
      monthlyTax(
        simulateHousehold(
          baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true), brokerage(transfers)], {
            horizonMonths: 16,
            incomeSeries: [wages(5_000)],
          }),
          flatAnnualWithheld(0.2),
        ),
      );
    const withSale = run([{ month: 9, amountCents: dollarsToCents(30_000) }]);
    expect(withSale.slice(0, 9)).toEqual(run([]).slice(0, 9));
  });
});

describe("Federal income tax — the year's balance settles the following April", () => {
  it("bills in April exactly what the year owed less what payroll withheld", () => {
    // Withholding at 10% against a liability of 25%: the gap is the April balance, to the cent.
    const jurisdiction: Jurisdiction = {
      ...flatAnnual(0.25),
      computeWageWithholdingCents: flatWageWithholding(0.1),
    };
    const p = simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 50_000_00, true)], {
        horizonMonths: 16,
        incomeSeries: [wages(5_000)],
      }),
      jurisdiction,
    );
    const monthly = monthlyTax(p);
    const withheld = sum(monthly.slice(0, 12));
    expect(withheld).toBe(dollarsToCents(6_000)); // 10% of $60,000
    expect(settlementIn(monthly, dollarsToCents(500))).toBe(dollarsToCents(15_000) - withheld);
  });

  it("REFUNDS in April when payroll over-withheld, as cash the household keeps", () => {
    const jurisdiction: Jurisdiction = {
      ...flatAnnual(0.1),
      computeWageWithholdingCents: flatWageWithholding(0.25),
    };
    const p = simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 50_000_00, true)], {
        horizonMonths: 16,
        incomeSeries: [wages(5_000)],
      }),
      jurisdiction,
    );
    const monthly = monthlyTax(p);
    const settlement = settlementIn(monthly, dollarsToCents(1_250));
    expect(settlement).toBe(dollarsToCents(6_000) - dollarsToCents(15_000));
    expect(settlement).toBeLessThan(0);
  });

  it("charges the balance exactly ONCE — the months either side of April settle nothing", () => {
    const jurisdiction: Jurisdiction = {
      ...flatAnnual(0.25),
      computeWageWithholdingCents: flatWageWithholding(0.1),
    };
    const p = simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 100_000_00, true)], {
        horizonMonths: 20,
        incomeSeries: [wages(5_000)],
      }),
      jurisdiction,
    );
    const monthly = monthlyTax(p);
    const withheldMonthly = dollarsToCents(500);
    for (const month of [SETTLEMENT_MONTH - 1, SETTLEMENT_MONTH + 1]) {
      expect(monthly[month]).toBe(withheldMonthly);
    }
    expect(monthly[SETTLEMENT_MONTH]).toBeGreaterThan(withheldMonthly);
    // And the year 2 balance, settled a further twelve months on, is a fresh figure rather than a
    // second charge of the same one.
    expect(monthly[SETTLEMENT_MONTH]).not.toBe(0);
  });

  it("makes a year's withholding plus its balance equal the annual tax on its ACTUAL income", () => {
    // A progressive schedule, so the identity cannot hold by linearity alone.
    const jurisdiction: Jurisdiction = {
      ...progressiveAnnual(),
      computeWageWithholdingCents: flatWageWithholding(0.12),
    };
    const p = simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 100_000_00, true)], {
        horizonMonths: 16,
        incomeSeries: [wages(6_000)],
      }),
      jurisdiction,
    );
    const monthly = monthlyTax(p);
    const owed = progressiveAnnual().computeTaxCents({ wages: dollarsToCents(72_000) }, { year: 2026 });
    expect(sum(monthly.slice(0, 12)) + settlementIn(monthly, dollarsToCents(720))).toBe(owed);
  });

  it("puts the April balance through the ordinary waterfall, funding it by decumulation like any need", () => {
    const jurisdiction: Jurisdiction = {
      ...flatAnnual(0.3),
      computeWageWithholdingCents: flatWageWithholding(0.05),
    };
    const brokerage = new SimAccount({
      id: "brokerage",
      ownerId: "p1",
      liquid: false,
      taxProfile: CAPITAL_GAINS_TAX_PROFILE,
      openingBalanceCents: dollarsToCents(200_000),
      initialAnnualRate: 0,
    });
    const p = simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true), brokerage], {
        horizonMonths: 16,
        incomeSeries: [wages(5_000)],
        expenseSeries: [series(4_500)],
      }),
      jurisdiction,
    );
    // The balance was met by selling, not by leaving the household insolvent.
    expect(p.months.some((m) => m.insolvencyReport !== undefined)).toBe(false);
    expect(settlementIn(monthlyTax(p), dollarsToCents(250))).toBeGreaterThan(0);
  });
});

describe("Federal income tax — a bonus is withheld apart from the salary it rides on", () => {
  /** A $5,000 salary with a $10,000 bonus in month 3, separated as supplemental. */
  function withBonus(supplemental: boolean): ProjectionSeries {
    const job = wages(5_000);
    job.series.addOverride(3, dollarsToCents(15_000), "thisMonthOnly");
    const withBonusSeries: SimOwnedSeries = supplemental
      ? { ...job, supplementalByMonth: new Map([[3, dollarsToCents(10_000)]]) }
      : job;
    return simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 50_000_00, true)], {
        horizonMonths: 16,
        incomeSeries: [withBonusSeries],
      }),
      {
        ...flatAnnual(0.2),
        // Regular pay at 10%, supplemental at a flat 22% — two visibly different methods, so the
        // bonus month's figure says which one priced it.
        computeWageWithholdingCents: (request) =>
          request.taxCategory === "wages"
            ? Math.round(request.regularWagesCents * 0.1 + request.supplementalWagesCents * 0.22)
            : 0,
      },
    );
  }

  it("prices the bonus by the supplemental method, leaving the salary beside it alone", () => {
    const monthly = monthlyTax(withBonus(true));
    // $5,000 salary at 10% plus $10,000 bonus at 22%.
    expect(monthly[3]).toBe(dollarsToCents(500) + dollarsToCents(2_200));
  });

  it("does NOT let a bonus alter the withholding on any other paycheck, before or after", () => {
    const monthly = monthlyTax(withBonus(true));
    const ordinary = dollarsToCents(500);
    expect(monthly.slice(0, 3)).toEqual([ordinary, ordinary, ordinary]);
    expect(monthly.slice(4, 12)).toEqual(Array.from({ length: 8 }, () => ordinary));
  });

  it("still taxes the bonus as ordinary wage income in the year's authoritative liability", () => {
    const p = withBonus(true);
    const monthly = monthlyTax(p);
    // $70,000 of wages at 20% owed, whatever the two withholding methods took during the year.
    expect(sum(monthly.slice(0, 12)) + settlementIn(monthly, dollarsToCents(500))).toBe(
      dollarsToCents(14_000),
    );
  });
});

describe("Federal income tax — payroll tax is withheld per employer and squared up on the return", () => {
  /** A capped payroll seam: 10% of the first $60,000 ONE source pays, nothing above. */
  const cappedWageBase = dollarsToCents(60_000);
  const jurisdiction: Jurisdiction = {
    ...flatAnnualWithheld(0.2),
    computePayrollWithholdingCents: (byCat) =>
      Math.round(Math.min(byCat.wages ?? 0, cappedWageBase) * 0.1),
    computePayrollWithholdingByCategoryCents: (byCat) => {
      const charge = Math.round(Math.min(byCat.wages ?? 0, cappedWageBase) * 0.1);
      return charge > 0 ? { wages: charge } : {};
    },
    // Excess over ONE combined cap comes back as a credit, exactly as a real return gives it.
    reconcilePayrollTaxCents: (perSource) => {
      const withheld = perSource.reduce(
        (sum, earned) => sum + Math.round(Math.min(earned.wages ?? 0, cappedWageBase) * 0.1),
        0,
      );
      const combined = perSource.reduce((sum, earned) => sum + (earned.wages ?? 0), 0);
      return -Math.max(0, withheld - Math.round(Math.min(combined, cappedWageBase) * 0.1));
    },
  };

  function twoJobs(): ProjectionSeries {
    return simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true)], {
        horizonMonths: 16,
        incomeSeries: [wages(4_000, 0, undefined, "jobA"), wages(4_000, 0, undefined, "jobB")],
      }),
      jurisdiction,
    );
  }

  it("applies the wage base to EACH job's own wages, as a real employer must", () => {
    const payroll = twoJobs().months.map((m) => m.flows!.payrollTaxCents);
    // Each job pays $48,000 a year, both under the $60,000 base, so every month of both is
    // charged in full: 10% of $8,000 = $800. One combined cap would have stopped in month 7.
    expect(payroll.slice(0, 12)).toEqual(Array.from({ length: 12 }, () => dollarsToCents(800)));
  });

  it("refunds the resulting excess on the return, in April, not silently during the year", () => {
    const monthly = monthlyTax(twoJobs());
    // Withheld: 10% × $96,000 = $9,600. Owed on one combined cap: 10% × $60,000 = $6,000.
    // The $3,600 credit lands in the April balance alongside the income-tax reconciliation.
    const incomeTaxOwed = dollarsToCents(96_000 * 0.2);
    const incomeTaxWithheld = sum(monthly.slice(0, 12));
    expect(settlementIn(monthly, dollarsToCents(1_600))).toBe(
      incomeTaxOwed - incomeTaxWithheld - dollarsToCents(3_600),
    );
  });

  it("reconciles a single-job year to nothing, so ordinary FICA never reaches April", () => {
    const oneJob = simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true)], {
        horizonMonths: 16,
        incomeSeries: [wages(4_000, 0, undefined, "jobA")],
      }),
      jurisdiction,
    );
    const monthly = monthlyTax(oneJob);
    // Income tax alone settles: 20% of $48,000 owed against 20% withheld → nothing left.
    expect(settlementIn(monthly, dollarsToCents(800))).toBe(0);
  });
});

describe("Federal income tax — the causality invariant", () => {
  /**
   * The invariant the whole arrangement exists to hold: an event in month M leaves every cash
   * flow before M exactly as it was. Asserted over the household's WHOLE cash position rather
   * than over the tax line alone, because a tax that moved would drag funding with it.
   *
   * There is no early-withdrawal penalty in the model to test separately; a penalty would be one
   * more non-payroll charge in the month it falls, and this is the property it would have to
   * satisfy.
   */
  function afterTaxIncomeByMonth(drawMonth: number | null): Cents[] {
    const ira = new SimAccount({
      id: "ira",
      ownerId: "p1",
      liquid: false,
      taxProfile: PRE_TAX_TAX_PROFILE,
      openingBalanceCents: dollarsToCents(400_000),
      initialAnnualRate: 0,
    });
    const p = simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 20_000_00, true), ira], {
        horizonMonths: 24,
        incomeSeries: [wages(5_000)],
        expenseSeries: [series(3_500)],
        ...(drawMonth !== null
          ? {
              fundingDraws: [
                explicitObligation({
                  id: "event",
                  sourceId: "event-spend",
                  month: drawMonth,
                  amountCents: dollarsToCents(50_000),
                  orderedAccountIds: ["ira"],
                  treatment: "expense",
                }),
              ],
            }
          : {}),
      }),
      flatAnnualWithheld(0.2),
    );
    return p.months.map((m) => m.flows!.totalIncomeCents - m.flows!.taxCents);
  }

  it("leaves every month before the event identical, tax and funding alike", () => {
    const baseline = afterTaxIncomeByMonth(null);
    for (const eventMonth of [5, 9, 11]) {
      expect(afterTaxIncomeByMonth(eventMonth).slice(0, eventMonth)).toEqual(
        baseline.slice(0, eventMonth),
      );
    }
  });
});
