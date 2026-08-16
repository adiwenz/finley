import { describe, it, expect } from "vitest";
import {
  SimAccount,
  type SimAccountTaxProfile,
  CAPITAL_GAINS_TAX_PROFILE,
  PRE_TAX_TAX_PROFILE,
  TAX_EXEMPT_TAX_PROFILE,
} from "../plan/simAccount";
import { dollarsToCents } from "../money/cashFlowSeries";
import { nullJurisdiction, type Jurisdiction } from "../jurisdiction/jurisdiction";
import { simulateHousehold, type HouseholdSimInput } from "./simulate";
import type { SimPerson } from "./simulate.types";

/** A non-compounding account so balances move only by RMD withdrawal/deposit. */
function account(id: string, taxProfile: SimAccountTaxProfile, dollars: number, liquid = false): SimAccount {
  return new SimAccount({
    id,
    ownerId: "p1",
    liquid,
    taxProfile,
    openingBalanceCents: dollarsToCents(dollars),
    initialAnnualRate: 0,
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
