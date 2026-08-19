/**
 * **Causal withholding on ordinary wages + exact year-end tax calculation + April true-up.**
 *
 * The model in one line, and this suite is what holds it there. Wages are withheld against every
 * month they are paid, using only what the household has already earned; everything else — gains,
 * pre-tax withdrawals, RMDs, early-withdrawal penalties — bears no in-year cash and reaches the
 * household through the following April's true-up. The invariant underneath all of it: an event
 * in month M must never change a cash flow in a month before M.
 *
 * The sibling suite {@link import("./taxCausality.test")} pins the same causality rule for a
 * jurisdiction that withholds NOTHING (the April-only model); this one pins it with withholding
 * switched on, which is where a forecast would be tempting and must still never appear.
 */
import { describe, it, expect } from "vitest";
import {
  SimAccount,
  CAPITAL_GAINS_TAX_PROFILE,
  PRE_TAX_TAX_PROFILE,
  type SimAccountTaxProfile,
} from "../plan/simAccount";
import { SimCashFlowSeries, dollarsToCents, type TaxCategory } from "../money/cashFlowSeries";
import { apportionByWeight, type Cents } from "../money/money";
import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import { simulateHousehold, type HouseholdSimInput, type SimOwnedSeries } from "./simulate";
import type { ProjectionSeries, SimPerson } from "./simulate.types";
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

/** A level salary, paid every month from month 0 — `endMonth` stops it mid-year. */
function wages(monthlyDollars: number, endMonth?: number): SimOwnedSeries {
  return {
    series: new SimCashFlowSeries(0, dollarsToCents(monthlyDollars), { type: "fixed" }, {
      baselineUnit: "monthly",
      taxCategory: "wages",
      ...(endMonth !== undefined ? { endMonth } : {}),
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
    incomeSeries: [wages(5_000)],
    expenseSeries: [],
    ...overrides,
  };
}

/** October — month index 9 of a January-start year. */
const OCTOBER = 9;
/** April of the following year — where year 0's balance settles. */
const SETTLEMENT_MONTH = 15;

const MONTHLY_WAGES = dollarsToCents(5_000);
/** 20% of $5,000 — a level salary withholds a level twelfth of a level annual tax. */
const MONTHLY_WITHHOLDING = dollarsToCents(1_000);
/** 7.65% of $5,000, charged on current-period wages regardless of anything income tax does. */
const MONTHLY_FICA = Math.round(MONTHLY_WAGES * 0.0765);

const totalOf = (byCategory: Partial<Record<TaxCategory, Cents>>): Cents =>
  Object.values(byCategory).reduce((sum: Cents, cents) => sum + (cents ?? 0), 0);

/** Every category apportioned its share of a household total, summing back to it exactly. */
function splitAcrossCategories(
  byCategory: Partial<Record<TaxCategory, Cents>>,
  totalTaxCents: Cents,
): Partial<Record<TaxCategory, Cents>> {
  if (totalTaxCents === 0) return {};
  const weights = Object.entries(byCategory).map(([c, cents]) => [c, cents ?? 0] as const);
  const out: Partial<Record<TaxCategory, Cents>> = {};
  for (const [category, cents] of apportionByWeight(totalTaxCents, weights)) {
    if (cents) out[category as TaxCategory] = cents;
  }
  return out;
}

/**
 * A flat 20% on every category, FICA on wages, and withholding on wages alone. Flat is
 * deliberate: annualizing a level salary and prorating it back is exact under a flat rate, so
 * every figure below is a round number and any true-up that appears is genuinely the tax on
 * income nobody withheld against, never an artifact of the approximation.
 */
const flat20: Jurisdiction = {
  id: "flat-20",
  computeTaxCents: (byCat) => Math.round(totalOf(byCat) * 0.2),
  computeTaxByCategoryCents: (byCat) => splitAcrossCategories(byCat, Math.round(totalOf(byCat) * 0.2)),
  isWithheldCategory: (category) => category === "wages",
  computePayrollTaxCents: (byCat) => Math.round((byCat.wages ?? 0) * 0.0765),
  computePayrollTaxByCategoryCents: (byCat) => {
    const charge = Math.round((byCat.wages ?? 0) * 0.0765);
    return charge > 0 ? { wages: charge } : {};
  },
};

/** {@link flat20} plus a flat 10% early-withdrawal penalty under 59½. */
const flat20WithPenalty: Jurisdiction = {
  ...flat20,
  earlyWithdrawalPenaltyCents: (basis, wctx) =>
    basis.category === "ordinaryIncome" && wctx.age < 59.5 ? Math.round(basis.grossCents * 0.1) : 0,
};

/**
 * 30% on income above a $30,000 exemption — the shape that makes annualization an ESTIMATE
 * rather than an identity, so a year whose earnings stop early over-withholds and gets a refund.
 */
const progressive: Jurisdiction = {
  ...flat20,
  id: "progressive",
  computeTaxCents: (byCat) => Math.round(Math.max(0, totalOf(byCat) - dollarsToCents(30_000)) * 0.3),
  computeTaxByCategoryCents: (byCat) =>
    splitAcrossCategories(
      byCat,
      Math.round(Math.max(0, totalOf(byCat) - dollarsToCents(30_000)) * 0.3),
    ),
};

/** A one-time spend drawn from named accounts — how an authored event reaches the engine. */
function spend(id: string, month: number, dollars: number, fromAccountIds: string[]) {
  return explicitObligation({
    id,
    sourceId: id,
    month,
    amountCents: dollarsToCents(dollars),
    orderedAccountIds: fromAccountIds,
    treatment: "expense" as const,
  });
}

const accounts = (): SimAccount[] => [
  account("cash", CAPITAL_GAINS_TAX_PROFILE, 20_000, true),
  account("pretax", PRE_TAX_TAX_PROFILE, 200_000),
];

const taxAt = (series: ProjectionSeries, month: number): Cents =>
  series.months[month]!.flows!.taxCents;

describe("1. Wage income produces smooth monthly federal withholding plus FICA", () => {
  it("charges the same income-tax and payroll-tax cents every month of a level salary", () => {
    const series = simulateHousehold(baseInput(accounts()), flat20);

    for (let m = 0; m < 12; m++) {
      expect(taxAt(series, m), `month ${m} withholding`).toBe(MONTHLY_WITHHOLDING);
      expect(series.months[m]!.flows!.payrollTaxCents, `month ${m} FICA`).toBe(MONTHLY_FICA);
    }
    // Gradual, not a cliff: the household never accumulates a balance on money that was never
    // its own, so nothing has to crash the following April to give it back.
    const settlement = taxAt(series, SETTLEMENT_MONTH) - MONTHLY_WITHHOLDING;
    expect(settlement).toBe(0);
  });

  it("attributes the withholding back to the job that bore it, alongside its FICA", () => {
    const series = simulateHousehold(baseInput(accounts()), flat20);
    const flows = series.months[3]!.flows!;
    expect(totalOf(flows.taxByCategoryCents ?? {})).toBe(MONTHLY_WITHHOLDING);
    expect(Object.values(flows.taxBySourceCents).reduce((s, c) => s + c, 0)).toBe(
      MONTHLY_WITHHOLDING,
    );
  });
});

describe("2. A later taxable event does not alter prior months' balances or withholding", () => {
  it("leaves January–September bit-identical whether or not an October withdrawal is authored", () => {
    const withoutEvent = simulateHousehold(baseInput(accounts()), flat20);
    const withEvent = simulateHousehold(
      baseInput(accounts(), { fundingDraws: [spend("oct", OCTOBER, 50_000, ["pretax"])] }),
      flat20,
    );

    for (let m = 0; m < OCTOBER; m++) {
      expect(taxAt(withEvent, m), `month ${m} withholding`).toBe(taxAt(withoutEvent, m));
      expect(withEvent.months[m]!.accountBalancesCents, `month ${m} balances`).toEqual(
        withoutEvent.months[m]!.accountBalancesCents,
      );
      expect(withEvent.months[m]!.netWorthNominalCents, `month ${m} net worth`).toBe(
        withoutEvent.months[m]!.netWorthNominalCents,
      );
    }
    // Withholding never notices the withdrawal at all — not before it, and not after it either:
    // a payer withholds on wages, and the wages did not change.
    for (let m = OCTOBER; m < 12; m++) {
      expect(taxAt(withEvent, m), `month ${m} withholding`).toBe(MONTHLY_WITHHOLDING);
    }
    expect(withEvent.months[OCTOBER]!.accountBalancesCents.pretax).toBeLessThan(
      withoutEvent.months[OCTOBER]!.accountBalancesCents.pretax!,
    );
  });
});

describe("3. The year-end liability subtracts the tax already withheld", () => {
  it("settles a pure-wage year at exactly zero — the withholding already paid all of it", () => {
    const series = simulateHousehold(baseInput(accounts()), flat20);
    // $60,000 of wages → $12,000 owed for 2026, and $12,000 withheld across the twelve months.
    // April 2027 carries its own withholding and not a cent more.
    expect(taxAt(series, SETTLEMENT_MONTH)).toBe(MONTHLY_WITHHOLDING);
  });

  it("settles a year with an unwithheld withdrawal at exactly the tax on that withdrawal", () => {
    const withoutEvent = simulateHousehold(baseInput(accounts()), flat20);
    const withEvent = simulateHousehold(
      baseInput(accounts(), { fundingDraws: [spend("oct", OCTOBER, 50_000, ["pretax"])] }),
      flat20,
    );
    // 2026's liability rises by 20% of the $50,000 draw; the year's withholding is unchanged,
    // since it never saw the draw. The difference — and only the difference — lands in April.
    expect(taxAt(withEvent, SETTLEMENT_MONTH) - taxAt(withoutEvent, SETTLEMENT_MONTH)).toBe(
      dollarsToCents(10_000),
    );
  });
});

describe("4. The remaining balance — or refund — settles in April", () => {
  it("hands back over-withheld tax as real April cash when the year's earnings stop early", () => {
    // Six months of salary, then nothing. Each of those months annualizes $60,000 and withholds
    // against a $9,000 liability, but the year actually earns $30,000 and owes nothing at all.
    const series = simulateHousehold(
      baseInput([account("cash", CAPITAL_GAINS_TAX_PROFILE, 20_000, true)], {
        incomeSeries: [wages(5_000, 5)],
      }),
      progressive,
    );

    // Months 0–5 withhold; from month 6 the annualized run rate falls and withholding simply
    // STOPS rather than clawing anything back — no month ever refunds mid-year.
    const withheld = [...Array(12).keys()].map((m) => taxAt(series, m));
    for (const charge of withheld.slice(0, 6)) expect(charge).toBeGreaterThan(0);
    for (const charge of withheld.slice(6, 12)) expect(charge).toBe(0);
    const totalWithheld = withheld.reduce((s, c) => s + c, 0);
    expect(totalWithheld).toBe(dollarsToCents(4_500));

    // April 2027 refunds every cent of it: the year owed nothing, so the whole over-withholding
    // comes back in one signed charge, raising take-home rather than lowering it.
    expect(taxAt(series, SETTLEMENT_MONTH)).toBe(-dollarsToCents(4_500));
  });
});

describe("5. A large October withdrawal never makes an earlier same-year spend unaffordable", () => {
  it("executes a June spend that drains its source, then executes the October withdrawal too", () => {
    const june = 5;
    // The brokerage holds EXACTLY what June spends. Any attempt to reserve tax up front — for the
    // June spend, or worse, for the October withdrawal that has not happened yet — blocks it.
    const build = (withOctober: boolean): HouseholdSimInput =>
      baseInput(
        [
          account("cash", CAPITAL_GAINS_TAX_PROFILE, 20_000, true),
          account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 40_000),
          account("pretax", PRE_TAX_TAX_PROFILE, 200_000),
        ],
        {
          fundingDraws: [
            spend("june", june, 40_000, ["brokerage"]),
            ...(withOctober ? [spend("oct", OCTOBER, 80_000, ["pretax"])] : []),
          ],
        },
      );
    const alone = simulateHousehold(build(false), flat20);
    const both = simulateHousehold(build(true), flat20);

    expect(both.status).toBe("ran-to-horizon");
    expect(both.obligationOutcomes["draw:june"]).toEqual({ status: "executed" });
    expect(both.obligationOutcomes["draw:oct"]).toEqual({ status: "executed" });
    expect(both.months[june]!.accountBalancesCents.brokerage).toBe(0);

    // And the October withdrawal changed nothing about June, or any month before October.
    for (let m = 0; m < OCTOBER; m++) {
      expect(both.months[m]!.accountBalancesCents, `month ${m}`).toEqual(
        alone.months[m]!.accountBalancesCents,
      );
      expect(taxAt(both, m), `month ${m} withholding`).toBe(taxAt(alone, m));
    }
  });
});

describe("6. An early-withdrawal penalty is never netted from the proceeds, and settles with the tax", () => {
  it("delivers the full $1,000 draw in October and charges its $100 penalty the following April", () => {
    const withDraw = simulateHousehold(
      baseInput(accounts(), { fundingDraws: [spend("oct", OCTOBER, 1_000, ["pretax"])] }),
      flat20WithPenalty,
    );
    const withoutDraw = simulateHousehold(baseInput(accounts()), flat20WithPenalty);

    // Exactly $1,000 left the account — not $1,111 grossed up to cover the penalty too — and
    // October's own tax cash is just its ordinary wage withholding.
    expect(withDraw.months[OCTOBER]!.accountBalancesCents.pretax).toBe(dollarsToCents(199_000));
    expect(taxAt(withDraw, OCTOBER)).toBe(MONTHLY_WITHHOLDING);

    // April settles both halves of what the draw cost: 20% income tax on the $1,000, plus the
    // flat $100 penalty added on top of the bracket-priced liability.
    expect(taxAt(withDraw, SETTLEMENT_MONTH) - taxAt(withoutDraw, SETTLEMENT_MONTH)).toBe(
      dollarsToCents(200) + dollarsToCents(100),
    );
  });
});

describe("7. Capital gains cause no retroactive change to earlier months", () => {
  it("leaves every month before an October brokerage sale untouched, settling its gain in April", () => {
    // 12%/yr on the brokerage, so by October the account carries a real embedded gain; selling it
    // realizes capital gains, which nobody withholds against.
    const build = (withSale: boolean): HouseholdSimInput =>
      baseInput(
        [
          account("cash", CAPITAL_GAINS_TAX_PROFILE, 20_000, true),
          account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 100_000, false, 0.12),
        ],
        { fundingDraws: withSale ? [spend("oct", OCTOBER, 50_000, ["brokerage"])] : [] },
      );
    const withoutSale = simulateHousehold(build(false), flat20);
    const withSale = simulateHousehold(build(true), flat20);

    for (let m = 0; m < OCTOBER; m++) {
      expect(withSale.months[m]!.accountBalancesCents, `month ${m}`).toEqual(
        withoutSale.months[m]!.accountBalancesCents,
      );
      expect(taxAt(withSale, m), `month ${m} withholding`).toBe(MONTHLY_WITHHOLDING);
      expect(withSale.months[m]!.netWorthNominalCents, `month ${m} net worth`).toBe(
        withoutSale.months[m]!.netWorthNominalCents,
      );
    }
    // Not even the sale's own month withholds against the gain — wages are the whole base.
    expect(taxAt(withSale, OCTOBER)).toBe(MONTHLY_WITHHOLDING);
    // The gain's tax shows up once, in April, and it is a real amount rather than a rounding.
    expect(taxAt(withSale, SETTLEMENT_MONTH)).toBeGreaterThan(
      taxAt(withoutSale, SETTLEMENT_MONTH),
    );
  });
});
