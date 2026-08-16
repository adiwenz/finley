/**
 * The year's estimate is a SIMULATION of the year, run on a discarded clone before the
 * authoritative months commit to instalments for it. Everything here follows from that one fact:
 * the estimate needs no model of contributions, basis, exhaustion, transfers or debt schedules,
 * because the simulator has one and the forecast pass IS the simulator.
 *
 * Each test below is a thing the old lightweight forecast either modelled separately or missed
 * entirely, now anticipated with no code of its own. The one thing the forecast pass cannot
 * bootstrap is the tax it charges while it runs — a cheap decumulation-aware estimate seeds that,
 * and the last test pins what the two leave behind.
 */
import { describe, it, expect } from "vitest";
import {
  SimAccount,
  CAPITAL_GAINS_TAX_PROFILE,
  PRE_TAX_TAX_PROFILE,
  TAX_EXEMPT_TAX_PROFILE,
  type SimAccountTaxProfile,
} from "../plan/simAccount";
import { SimCashFlowSeries, dollarsToCents } from "../money/cashFlowSeries";
import type { Cents } from "../money/money";
import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import type { BudgetLine } from "../budget/budgetLine";
import { simulateHousehold, type HouseholdSimInput, type SimOwnedSeries } from "./simulate";

const RATE = 0.25;

/** Flat 25% on everything a draw or a wage can be, and nothing on a tax-exempt withdrawal. */
const flat25: Jurisdiction = {
  id: "flat-25",
  computeTaxCents: (byCat) =>
    Math.round(((byCat.wages ?? 0) + (byCat.ordinaryIncome ?? 0) + (byCat.capitalGains ?? 0)) * RATE),
  computeTaxByCategoryCents: (byCat) => {
    const out: Partial<Record<string, Cents>> = {};
    for (const category of ["wages", "ordinaryIncome", "capitalGains"] as const) {
      const cents = byCat[category] ?? 0;
      if (cents > 0) out[category] = Math.round(cents * RATE);
    }
    return out;
  },
  // Pro-rata return of capital, so a drawn-down taxable account realizes only its gain — the
  // thing basis tracking exists to get right.
  taxableWithdrawalCents: ({ grossCents, basisCents, balanceCents }) =>
    grossCents - Math.round(grossCents * (balanceCents > 0 ? Math.min(1, basisCents / balanceCents) : 0)),
};

function account(
  id: string,
  taxProfile: SimAccountTaxProfile,
  dollars: number,
  liquid = false,
  rate = 0,
): SimAccount {
  return new SimAccount({
    id,
    ownerId: "p1",
    liquid,
    taxProfile,
    openingBalanceCents: dollarsToCents(dollars),
    initialAnnualRate: rate,
  });
}

function series(monthlyDollars: number, startMonth = 0, endMonth?: number): SimOwnedSeries {
  return {
    series: new SimCashFlowSeries(startMonth, dollarsToCents(monthlyDollars), { type: "fixed" }, {
      baselineUnit: "monthly",
      ...(endMonth !== undefined ? { endMonth } : {}),
    }),
    ownerId: "p1",
  };
}

function input(accounts: SimAccount[], overrides: Partial<HouseholdSimInput> = {}): HouseholdSimInput {
  return {
    horizonMonths: 16,
    annualInflationRate: 0,
    startYear: 2026,
    persons: [{ id: "p1", name: "You" }],
    accounts,
    incomeSeries: [],
    expenseSeries: [],
    ...overrides,
  };
}

const taxesOf = (i: HouseholdSimInput): Cents[] =>
  simulateHousehold(i, flat25).months.map((m) => m.flows!.taxCents);

const sum = (values: readonly Cents[]): Cents => values.reduce((s, v) => s + v, 0);

/** The year's own twelve instalments: April's charge carries the prior year's balance too. */
const yearZeroInstalments = (taxes: readonly Cents[]): Cents => sum(taxes.slice(0, 12));

describe("The year's estimate is the year, simulated", () => {
  it("prices a drawn-down taxable account on its GAIN, following basis as it falls", () => {
    // $200k of brokerage at 12%, funding $4,000 a month. Under pro-rata return of capital only
    // the appreciation is taxable, and the taxable fraction RISES as the account is drawn and
    // regrown — a moving figure no single January reading can produce, and one the forecast pass
    // gets by simply doing the twelve draws.
    const taxes = taxesOf(
      input(
        [
          account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true),
          account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 200_000, false, 0.12),
        ],
        { expenseSeries: [series(4_000, 0, 11)] },
      ),
    );
    const collected = yearZeroInstalments(taxes);
    // Far below 25% of the $48,000 drawn — most of every draw is the household's own principal
    // coming back, which a forecast blind to basis would have taxed in full.
    expect(collected).toBeGreaterThan(0);
    expect(collected).toBeLessThan(Math.round(dollarsToCents(48_000) * RATE) / 2);
    // And still paced: twelve equal instalments, no month singled out.
    expect(Math.max(...taxes.slice(0, 12)) - Math.min(...taxes.slice(0, 12))).toBeLessThanOrEqual(1);
  });

  it("sees a contribution divert the surplus that would have funded the rest of the year", () => {
    // Six months of $6,000 wages against $3,000 of spending all year. Left alone, the $18,000
    // surplus banks in checking and pays for the second half — no sale, no tax beyond the wages.
    // Route it into a tax-exempt account instead and the second half has to come out of pre-tax,
    // which is taxable. The estimate is a simulation of the year, so the deposit half of the
    // waterfall runs in it: January already knows the household will be selling in July.
    const contribution: BudgetLine = {
      id: "roth-contrib",
      label: "Roth",
      target: { kind: "account", accountId: "roth", taxTreatment: "postTax" },
      amountSource: { kind: "literal", monthlyCents: dollarsToCents(3_000) },
      category: "savings",
      span: { startMonth: 0, endMonth: 6 },
    };
    const runs = (contributionLines: BudgetLine[]): Cents[] =>
      taxesOf(
        input(
          [
            account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true),
            account("pretax", PRE_TAX_TAX_PROFILE, 500_000),
            account("roth", TAX_EXEMPT_TAX_PROFILE, 0),
          ],
          {
            incomeSeries: [series(6_000, 0, 5)],
            expenseSeries: [series(3_000, 0, 11)],
            contributionLines,
          },
        ),
      );
    const banked = yearZeroInstalments(runs([]));
    const contributed = yearZeroInstalments(runs([contribution]));
    // Both years tax the same $36,000 of wages and the selling their own instalments force; only
    // the contributed one also taxes the pre-tax selling the diverted surplus causes — five
    // figures of it, on a contribution the old forecast modelled not at all.
    expect(banked).toBeGreaterThan(Math.round(dollarsToCents(36_000) * RATE));
    expect(contributed - banked).toBeGreaterThan(Math.round(dollarsToCents(12_000) * RATE));
    // And paced from January, not discovered in July.
    const paced = runs([contribution]).slice(0, 12);
    expect(Math.max(...paced) - Math.min(...paced)).toBeLessThanOrEqual(1);
  });

  it("sees an account run dry mid-year and stops taxing draws that move to a tax-exempt one", () => {
    // $5,000 a month against $30,000 of pre-tax and an unlimited tax-exempt account behind it.
    // Six months in, the pre-tax account is empty and every later draw is tax-free — so the year
    // owes roughly a quarter of $30,000, not of $60,000.
    const runs = (preTaxDollars: number): Cents[] =>
      taxesOf(
        input(
          [
            account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true),
            account("pretax", PRE_TAX_TAX_PROFILE, preTaxDollars),
            account("roth", TAX_EXEMPT_TAX_PROFILE, 500_000),
          ],
          { expenseSeries: [series(5_000, 0, 11)] },
        ),
      );
    const exhausts = yearZeroInstalments(runs(30_000));
    const ample = yearZeroInstalments(runs(500_000));
    // The whole pre-tax balance is drawn and taxed, and nothing beyond it.
    expect(exhausts).toBeGreaterThan(Math.round(dollarsToCents(29_000) * RATE));
    expect(exhausts).toBeLessThan(Math.round(dollarsToCents(34_000) * RATE));
    // The control funds the same $60,000 entirely from pre-tax and owes twice as much.
    expect(ample).toBeGreaterThan(exhausts * 1.9);
  });

  it("sees a one-time transfer empty an account, and prices the selling that forces", () => {
    const withTransfer = (month: number | null): SimAccount => {
      const checking = account("checking", CAPITAL_GAINS_TAX_PROFILE, 60_000, true);
      if (month !== null) checking.addTransfer({ month, proportionalFraction: -1 });
      return checking;
    };
    const runs = (emptiedAt: number | null): Cents[] =>
      taxesOf(
        input([withTransfer(emptiedAt), account("pretax", PRE_TAX_TAX_PROFILE, 500_000)], {
          expenseSeries: [series(5_000, 0, 11)],
        }),
      );
    // $60k of checking covers the whole $60k year — unless it is emptied in July, after which
    // every remaining month must sell pre-tax. A forecast that walked balances through draws and
    // growth alone saw none of this and owed the whole bill to the following April.
    const intact = yearZeroInstalments(runs(null));
    const emptied = yearZeroInstalments(runs(6));
    expect(intact).toBe(0);
    // July's own $5,000 still comes out of checking — transfers land after the month's spending —
    // so it is the remaining $25,000 that pre-tax has to cover.
    expect(emptied).toBe(Math.round(dollarsToCents(25_000) * RATE));
  });

  it("charges a lumpy mid-year spend across all twelve months, not the month it lands in", () => {
    const taxes = taxesOf(
      input([account("pretax", PRE_TAX_TAX_PROFILE, 500_000)], {
        expenseSeries: [series(40_000, 7, 7)],
      }),
    );
    // August is no heavier than January: the liability is annual, so the payments are too.
    expect(Math.max(...taxes.slice(0, 12)) - Math.min(...taxes.slice(0, 12))).toBeLessThanOrEqual(1);
    expect(yearZeroInstalments(taxes)).toBeGreaterThan(Math.round(dollarsToCents(39_000) * RATE));
  });

  it("collects the gross-up too, leaving April a residue of cents", () => {
    // The one thing the forecast pass cannot perform is its own conclusion: it has to charge
    // SOMETHING while it runs, and the extra selling its own instalments force is selling it only
    // does if those instalments were about the right size. That is exactly what the cheap seed is
    // for. Funding $48,000 from a fully taxable account costs $48,000 plus the tax on the sales
    // that pay the tax — T = 0.25 × ($48,000 + T) → $16,000 — and the year collects it.
    //
    // Seeded with scheduled income alone the pass would draw only $48,000, estimate $12,000, and
    // leave $4,000 for April: a five-figure Aprils sawtooth in exactly the households this model
    // exists for.
    const taxes = taxesOf(
      input([account("pretax", PRE_TAX_TAX_PROFILE, 1_000_000)], {
        expenseSeries: [series(4_000, 0, 11)],
      }),
    );
    const collected = yearZeroInstalments(taxes);
    expect(Math.abs(collected - dollarsToCents(16_000))).toBeLessThan(dollarsToCents(1));
    // April 2027 carries year 0's balance on top of its own instalment, which March measures —
    // cents of it, where the seed's own approximation is all that is left to settle.
    const balance = taxes[15]! - taxes[14]!;
    expect(Math.abs(balance)).toBeLessThan(dollarsToCents(1));
    // And the two together are the annual tax on what the year ACTUALLY drew: the spending plus
    // the instalments that funded themselves out of the same account. To the cent by which April's
    // charge can differ from March's under cumulative instalment rounding, which `balance` reads
    // off a neighbouring month rather than the same one.
    expect(
      Math.abs(collected + balance - Math.round((dollarsToCents(48_000) + collected) * RATE)),
    ).toBeLessThanOrEqual(1);
  });
});
