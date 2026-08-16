import { describe, it, expect } from "vitest";
import {
  SimAccount,
  type SimAccountTaxProfile,
  CAPITAL_GAINS_TAX_PROFILE,
  PRE_TAX_TAX_PROFILE,
  TAX_EXEMPT_TAX_PROFILE,
} from "../plan/simAccount";
import { SimCashFlowSeries, dollarsToCents } from "../money/cashFlowSeries";
import { nullJurisdiction, type Jurisdiction } from "../jurisdiction/jurisdiction";
import { simulateHousehold, type HouseholdSimInput, type ProjectionSeries } from "./simulate";
import type { SimPerson } from "./simulate.types";

/** Non-compounding by default, so balances move only by RMD withdrawal/deposit. */
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

/** Surplus idles in the liquid cash account, so an RMD's net take-home lands there. */
function baseInput(
  person: SimPerson,
  accounts: SimAccount[],
  overrides: Partial<HouseholdSimInput> = {},
): HouseholdSimInput {
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

/** Stub: 10% of the pre-tax balance once the holder reaches 73; no tax. */
const rmdStub: Jurisdiction = {
  id: "rmd-stub",
  computeTaxCents: () => 0,
  computeTaxByCategoryCents: () => ({}),
  requiredMinimumDistributionCents: (balance, ctx) =>
    ctx.age >= 73 ? Math.round(balance / 10) : 0,
};

const born73In2026: SimPerson = { id: "p1", name: "You", birthYear: 1953 };

/** Monthly spending, level, for the whole run. */
function spending(monthlyDollars: number): HouseholdSimInput["expenseSeries"][number] {
  return {
    series: new SimCashFlowSeries(0, dollarsToCents(monthlyDollars), { type: "fixed" }, {
      baselineUnit: "monthly",
    }),
    ownerId: "p1",
  };
}

/** What the sim says it forced out of pre-tax this month — the reported gross, not a residual. */
function rmdAt(series: ProjectionSeries, month: number): number {
  return (series.months[month]!.flows?.incomeSources ?? [])
    .filter((source) => source.sourceId === "rmd:p1")
    .reduce((total, source) => total + source.cashInflowCents, 0);
}

const balanceAt = (series: ProjectionSeries, month: number, id: string): number =>
  series.months[month]!.accountBalancesCents[id] ?? 0;

describe("Required Minimum Distributions", () => {
  it("forces the required amount out of pre-tax and into the taxable surplus, conserving net worth", () => {
    const series = simulateHousehold(
      baseInput(born73In2026, [
        account("pretax", PRE_TAX_TAX_PROFILE, 100_000),
        account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
      ]),
      rmdStub,
    );
    // At month 1 (2026, age 73): 10% of $100k = $10k moves pre-tax → cash.
    expect(series.months[1].accountBalancesCents["pretax"]).toBe(dollarsToCents(90_000));
    expect(series.months[1].accountBalancesCents["cash"]).toBe(dollarsToCents(10_000));
    // Tax-free stub → net worth unchanged, only relocated.
    expect(series.months[1].netWorthNominalCents).toBe(dollarsToCents(100_000));
  });

  it("fires exactly once per calendar year, not every month", () => {
    const series = simulateHousehold(
      baseInput(born73In2026, [
        account("pretax", PRE_TAX_TAX_PROFILE, 100_000),
        account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
      ], { horizonMonths: 13 }),
      rmdStub,
    );
    // No draw between the year's trigger (month 0) and the next (month 12).
    expect(series.months[11].accountBalancesCents["pretax"]).toBe(dollarsToCents(90_000));
    expect(series.months[11].accountBalancesCents["cash"]).toBe(dollarsToCents(10_000));
    // Month 12 (2027, age 74): 10% of the remaining $90k = $9k.
    expect(series.months[12].accountBalancesCents["pretax"]).toBe(dollarsToCents(81_000));
    expect(series.months[12].accountBalancesCents["cash"]).toBe(dollarsToCents(19_000));
  });

  it("draws from forced-distribution-eligible accounts only — tax-exempt/capital-gains are exempt", () => {
    const series = simulateHousehold(
      baseInput(born73In2026, [
        account("pretax", PRE_TAX_TAX_PROFILE, 100_000),
        account("taxexempt", TAX_EXEMPT_TAX_PROFILE, 50_000),
        account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
      ]),
      rmdStub,
    );
    expect(series.months[1].accountBalancesCents["pretax"]).toBe(dollarsToCents(90_000));
    expect(series.months[1].accountBalancesCents["taxexempt"]).toBe(dollarsToCents(50_000));
    expect(series.months[1].accountBalancesCents["cash"]).toBe(dollarsToCents(10_000));
  });

  it("does not fire before the holder reaches the start age", () => {
    const tooYoung: SimPerson = { id: "p1", name: "You", birthYear: 1970 }; // 56 in 2026
    const series = simulateHousehold(
      baseInput(tooYoung, [
        account("pretax", PRE_TAX_TAX_PROFILE, 100_000),
        account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
      ]),
      rmdStub,
    );
    expect(series.months[11].accountBalancesCents["pretax"]).toBe(dollarsToCents(100_000));
    expect(series.months[11].accountBalancesCents["cash"]).toBe(0);
  });

  it("null jurisdiction: no RMD seam → pre-tax balances are left untouched", () => {
    const series = simulateHousehold(
      baseInput(born73In2026, [
        account("pretax", PRE_TAX_TAX_PROFILE, 100_000),
        account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
      ]),
      nullJurisdiction,
    );
    expect(series.months[11].accountBalancesCents["pretax"]).toBe(dollarsToCents(100_000));
    expect(series.months[11].accountBalancesCents["cash"]).toBe(0);
  });
});

describe("Required Minimum Distributions — nothing is required of the dead", () => {
  /** A two-person household: Sam holds the pre-tax account and dies at `deathMonth`. */
  function household(deathMonth: number | undefined): HouseholdSimInput {
    return {
      horizonMonths: 36,
      annualInflationRate: 0,
      startYear: 2026,
      persons: [
        { id: "p1", name: "Alex", birthYear: 1970 },
        {
          id: "p2",
          name: "Sam",
          birthYear: 1953,
          ...(deathMonth !== undefined
            ? { activeWindow: { startMonth: 0, endMonthExclusive: deathMonth } }
            : {}),
        },
      ],
      accounts: [
        new SimAccount({
          id: "sams-ira",
          ownerId: "p2",
          liquid: false,
          taxProfile: PRE_TAX_TAX_PROFILE,
          openingBalanceCents: dollarsToCents(100_000),
          initialAnnualRate: 0,
        }),
        account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
      ],
      incomeSeries: [],
      expenseSeries: [],
    };
  }

  it("stops distributing a partner's account once they have died", () => {
    // Sam takes 2026's distribution in January and dies that December. 2027 and 2028 require
    // nothing of them: the balance sits where their death left it.
    const series = simulateHousehold(household(12), rmdStub);
    expect(series.months[11].accountBalancesCents["sams-ira"]).toBe(dollarsToCents(90_000));
    expect(series.months[12].accountBalancesCents["sams-ira"]).toBe(dollarsToCents(90_000));
    expect(series.months[35].accountBalancesCents["sams-ira"]).toBe(dollarsToCents(90_000));
    // The account is not disinherited by the gate — it is still the household's, to the end.
    expect(series.months[35].netWorthNominalCents).toBe(dollarsToCents(100_000));
  });

  it("keeps distributing while they are alive, so the gate is the death and not the account", () => {
    // The same fixture with nobody dying: three years, three distributions.
    const series = simulateHousehold(household(undefined), rmdStub);
    expect(series.months[35].accountBalancesCents["sams-ira"]).toBe(dollarsToCents(72_900));
  });

  it("takes the year's distribution when the death falls LATER in the same year", () => {
    // Sam dies in July 2027, after that January's trigger — the year's requirement was already
    // theirs, and it stands. `isPersonActiveAt` is asked at the trigger month, not at the year.
    const series = simulateHousehold(household(18), rmdStub);
    expect(series.months[12].accountBalancesCents["sams-ira"]).toBe(dollarsToCents(81_000));
    expect(series.months[35].accountBalancesCents["sams-ira"]).toBe(dollarsToCents(81_000));
  });
});

/**
 * **The balance the requirement is priced off.** The IRS mechanic divides the PRIOR year-end
 * balance by the year's divisor, and the engine hands the seam the balance it holds at the trigger
 * month. Those are the same number only because of where the trigger sits in the month pipeline —
 * RMDs are built with the non-withdrawal sources, ahead of both decumulation and `compoundAssets`,
 * so January's opening balance IS December's close. Pin it: move the RMD after either step and
 * these divisions stop reconciling.
 */
describe("Required Minimum Distributions — priced off the prior year-end balance", () => {
  const DIVISOR: Record<number, number> = { 73: 26.5, 74: 25.5, 75: 24.6 };

  /** The real mechanic — balance ÷ Uniform Lifetime divisor — without importing the rules package. */
  const divisorStub: Jurisdiction = {
    id: "divisor-stub",
    computeTaxCents: () => 0,
    computeTaxByCategoryCents: () => ({}),
    requiredMinimumDistributionCents: (balance, ctx) => {
      const divisor = DIVISOR[ctx.age];
      return divisor === undefined ? 0 : Math.round(balance / divisor);
    },
  };

  /** Compounding, so a year-end balance is neither the opening balance nor a round number. */
  const growingHousehold = (): ProjectionSeries =>
    simulateHousehold(
      baseInput(
        born73In2026,
        [
          account("pretax", PRE_TAX_TAX_PROFILE, 100_000, false, 0.12),
          account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
        ],
        { horizonMonths: 36 },
      ),
      divisorStub,
    );

  it("divides the prior year-end balance by the year's divisor, to the cent", () => {
    const series = growingHousehold();
    // The first year has no prior December, so it is priced off the opening balance.
    expect(rmdAt(series, 0)).toBe(Math.round(dollarsToCents(100_000) / DIVISOR[73]!));
    // Every year after divides the balance the previous month closed at.
    for (const [month, age] of [[12, 74], [24, 75]] as const) {
      expect(rmdAt(series, month)).toBe(
        Math.round(balanceAt(series, month - 1, "pretax") / DIVISOR[age]!),
      );
    }
  });

  it("prices off the CLOSING balance, not the opening one — the year's growth is in the base", () => {
    // The distinction only exists because the account compounds: had the requirement been priced
    // off January's post-growth balance, or off the balance the year opened with a year ago, it
    // would divide a different number. Assert the near misses are misses.
    const series = growingHousehold();
    const decemberClose = balanceAt(series, 11, "pretax");
    const januaryClose = balanceAt(series, 12, "pretax");
    expect(decemberClose).not.toBe(januaryClose);
    expect(rmdAt(series, 12)).toBe(Math.round(decemberClose / DIVISOR[74]!));
    expect(rmdAt(series, 12)).not.toBe(Math.round(januaryClose / DIVISOR[74]!));
  });

  /**
   * **The round-number anchor.** A holder who turns 73 next year, holding $530,000 that does
   * nothing at all in the meantime — no growth, no income, no spending, no tax. The prior year-end
   * balance is $530,000 by construction, so the answer is $530,000 / 26.5 = $20,000 exactly, and
   * any deviation is something the year did to the balance rather than a question of arithmetic.
   *
   * Deliberately the whole pipeline rather than the seam alone: the seam dividing correctly is
   * already pinned in `@finley/rules`, and every way this has been suspected of going wrong —
   * pricing off a later balance, a stray withdrawal landing before the trigger, the year's own
   * growth reaching the base — lives between the two.
   */
  it("$530,000 at 73 with nothing happening in between is $20,000, to the cent", () => {
    const series = simulateHousehold(
      baseInput(
        { id: "p1", name: "You", birthYear: 1954 }, // 72 in 2026, 73 in 2027
        [
          account("pretax", PRE_TAX_TAX_PROFILE, 530_000),
          account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
        ],
        { horizonMonths: 13 },
      ),
      divisorStub,
    );
    // Age 72: nothing is required, and nothing else touches the account either.
    for (let month = 0; month <= 11; month++) {
      expect(rmdAt(series, month)).toBe(0);
      expect(balanceAt(series, month, "pretax")).toBe(dollarsToCents(530_000));
    }
    // December 31st — the applicable balance — is the $530,000 it opened with.
    expect(balanceAt(series, 11, "pretax")).toBe(dollarsToCents(530_000));
    // And the year the holder turns 73 divides exactly that, by exactly 26.5.
    expect(DIVISOR[73]).toBe(26.5);
    expect(rmdAt(series, 12)).toBe(dollarsToCents(20_000));
    expect(balanceAt(series, 12, "pretax")).toBe(dollarsToCents(510_000));
  });

  it("takes the distribution before the year's growth, so the withdrawn money never earns it", () => {
    // The balance identity that makes the crossover arithmetic true: a year is
    // `(balance − RMD) × (1 + rate)`, not `balance × (1 + rate) − RMD`. One month of 12%/yr.
    const series = growingHousehold();
    const opening = dollarsToCents(100_000);
    const monthlyRate = Math.pow(1.12, 1 / 12) - 1;
    expect(balanceAt(series, 0, "pretax")).toBe(
      Math.round((opening - rmdAt(series, 0)) * (1 + monthlyRate)),
    );
  });
});

/**
 * **A distribution is forced, not requested.** Once the year's requirement is out, its proceeds are
 * ordinary household cash: spending has to consume them before anything else is sold. A household
 * required to take more than it spends should therefore make NO discretionary retirement
 * withdrawal at all, and bank the difference — the failure mode being a plan that dutifully
 * distributes $10,000, spends its cash, and then sells another $2,400 of the same account to pay
 * for groceries it had already been handed the money for.
 */
describe("Required Minimum Distributions — an excess the household did not ask for", () => {
  const YEAR_ONE_RMD = dollarsToCents(10_000);
  const SPEND = 200;

  function household(monthlyDollars: number, horizonMonths = 13): ProjectionSeries {
    return simulateHousehold(
      baseInput(
        born73In2026,
        [
          account("pretax", PRE_TAX_TAX_PROFILE, 100_000),
          account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
        ],
        { horizonMonths, expenseSeries: [spending(monthlyDollars)] },
      ),
      rmdStub,
    );
  }

  it("draws the requirement and nothing more when it covers the year's spending", () => {
    // $10,000 required against $2,400 spent. The pre-tax account is touched exactly once.
    const series = household(SPEND);
    expect(rmdAt(series, 0)).toBe(YEAR_ONE_RMD);
    expect(balanceAt(series, 11, "pretax")).toBe(dollarsToCents(90_000));
    // …and the second year is priced off that untouched balance, so no drift compounds.
    expect(rmdAt(series, 12)).toBe(dollarsToCents(9_000));
  });

  it("banks the excess as cash rather than leaving it to be re-earned", () => {
    const series = household(SPEND);
    expect(balanceAt(series, 11, "cash")).toBe(YEAR_ONE_RMD - dollarsToCents(SPEND * 12));
    // Nothing was created or destroyed on the way: the year only moved money.
    expect(series.months[11]!.netWorthNominalCents).toBe(
      dollarsToCents(100_000) - dollarsToCents(SPEND * 12),
    );
  });

  it("does draw again once spending outgrows the requirement, so the restraint is not inertia", () => {
    // $24,000 spent against the same $10,000 required. The distributed cash is consumed first and
    // the shortfall — and only the shortfall — comes out of pre-tax after it.
    const series = household(2_000);
    expect(rmdAt(series, 0)).toBe(YEAR_ONE_RMD);
    expect(balanceAt(series, 11, "cash")).toBe(0);
    expect(balanceAt(series, 11, "pretax")).toBe(
      dollarsToCents(100_000) - dollarsToCents(24_000),
    );
    expect(series.months.every((m) => !m.isInsolvent)).toBe(true);
  });
});
