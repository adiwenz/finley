/**
 * A deceased partner's accounts becoming the survivor's, at the death month — the fix for
 * "Casey runs a deficit beside Alex's untouched fortune" (see `runMonth`'s call into {@link
 * applyDeathOwnershipTransfers}). Retirement accounts are deliberately excluded — inherited
 * distribution rules are unmodelled — so the mechanism, and each test below, is scoped to cash
 * and taxable brokerage.
 */
import { describe, it, expect } from "vitest";
import {
  SimAccount,
  CAPITAL_GAINS_TAX_PROFILE,
  CASH_INTEREST_TAX_PROFILE,
  PRE_TAX_TAX_PROFILE,
} from "../plan/simAccount";
import { SimCashFlowSeries, dollarsToCents } from "../money/cashFlowSeries";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { Projection } from "../index";
import { PRIMARY_PERSON_ID } from "../compile/projectionBase";
import { samplePlan, stateOf, SAMPLE_START_YEAR } from "../testing/samplePlan";
import { simulateHousehold, type HouseholdSimInput, type SimOwnedSeries } from "./simulate";
import type { SimPerson } from "./simulate.types";
import { applyDeathOwnershipTransfers } from "./deathOwnershipTransfer";

function account(
  id: string,
  ownerId: string,
  dollars: number,
  profile = CASH_INTEREST_TAX_PROFILE,
  liquid = true,
): SimAccount {
  return new SimAccount({
    id,
    ownerId,
    liquid,
    taxProfile: profile,
    openingBalanceCents: dollarsToCents(dollars),
    initialAnnualRate: 0,
  });
}

/** A person who dies at `deathMonth` — the first month they are gone — or never. */
function person(id: string, deathMonth?: number): SimPerson {
  return {
    id,
    name: id,
    ...(deathMonth !== undefined
      ? { activeWindow: { startMonth: 0, endMonthExclusive: deathMonth } }
      : {}),
  };
}

function spending(ownerId: string, monthlyDollars: number, startMonth = 0): SimOwnedSeries {
  return {
    series: new SimCashFlowSeries(startMonth, dollarsToCents(monthlyDollars), { type: "fixed" }, {
      baselineUnit: "monthly",
    }),
    ownerId,
  };
}

describe("applyDeathOwnershipTransfers", () => {
  it("reassigns a matching cash/brokerage account exactly at the transfer's month", () => {
    const alexSavings = account("alex-savings", "alex", 100_000);
    applyDeathOwnershipTransfers(
      [alexSavings],
      [{ deceasedPersonId: "alex", survivorPersonId: "casey", month: 12 }],
      11,
    );
    expect(alexSavings.ownerId).toBe("alex");
    applyDeathOwnershipTransfers(
      [alexSavings],
      [{ deceasedPersonId: "alex", survivorPersonId: "casey", month: 12 }],
      12,
    );
    expect(alexSavings.ownerId).toBe("casey");
  });

  it("leaves a retirement (forced-distribution-eligible) account with its original owner", () => {
    const alexIra = account("alex-ira", "alex", 500_000, PRE_TAX_TAX_PROFILE, false);
    applyDeathOwnershipTransfers(
      [alexIra],
      [{ deceasedPersonId: "alex", survivorPersonId: "casey", month: 12 }],
      12,
    );
    expect(alexIra.ownerId).toBe("alex");
  });

  it("touches only the account owned by the deceased named in the transfer", () => {
    const caseySavings = account("casey-savings", "casey", 10_000);
    applyDeathOwnershipTransfers(
      [caseySavings],
      [{ deceasedPersonId: "alex", survivorPersonId: "casey", month: 12 }],
      12,
    );
    expect(caseySavings.ownerId).toBe("casey");
  });
});

describe("the household simulator, wired to a death ownership transfer", () => {
  const HORIZON = 36;
  const DEATH = 12;
  // Non-liquid, so a person's ONE account cannot also be selected as their "buffer" — every
  // draw then runs through the plain liquidation-order `drainAccounts` path these tests pin,
  // undisturbed by the separate liquid-buffer prediction mechanism.
  const cash = (id: string, ownerId: string, dollars: number): SimAccount =>
    account(id, ownerId, dollars, CASH_INTEREST_TAX_PROFILE, false);

  function household(overrides: Partial<HouseholdSimInput> = {}): HouseholdSimInput {
    return {
      horizonMonths: HORIZON,
      annualInflationRate: 0,
      startYear: 2026,
      persons: [person("casey"), person("alex", DEATH)],
      accounts: [cash("casey-savings", "casey", 0), cash("alex-savings", "alex", 100_000)],
      // Starts exactly at the death month: Casey has no expense of her own before it, so the
      // household draws nothing at all pre-death and Alex's balance is untouched for a reason
      // that has nothing to do with ownership.
      expenseSeries: [spending("casey", 2_000, DEATH)],
      incomeSeries: [],
      deathOwnershipTransfers: [
        { deceasedPersonId: "alex", survivorPersonId: "casey", month: DEATH },
      ],
      ...overrides,
    };
  }

  it("leaves the deceased's account untouched before the death month", () => {
    const series = simulateHousehold(household(), nullJurisdiction);
    expect(series.months[DEATH - 1]!.accountBalancesCents["alex-savings"]).toBe(
      dollarsToCents(100_000),
    );
  });

  it("draws the inherited account for the survivor's own deficit, starting at the death month", () => {
    const series = simulateHousehold(
      household({ accounts: [cash("alex-savings", "alex", 100_000)] }),
      nullJurisdiction,
    );
    expect(series.months[DEATH]!.accountBalancesCents["alex-savings"]).toBe(
      dollarsToCents(100_000 - 2_000),
    );
  });

  it("spends the survivor's own (smaller) account before the inherited (larger) one", () => {
    // Casey brings a little of her own; the roster lists her account first, so the liquidation
    // order drains it — same tax treatment, same rank — before touching Alex's.
    const series = simulateHousehold(
      household({ accounts: [cash("casey-savings", "casey", 1_000), cash("alex-savings", "alex", 100_000)] }),
      nullJurisdiction,
    );
    const atDeath = series.months[DEATH]!.accountBalancesCents;
    expect(atDeath["casey-savings"]).toBe(0);
    expect(atDeath["alex-savings"]).toBe(dollarsToCents(100_000) - dollarsToCents(1_000));
  });

  it("transfers nothing, and the account stays put, when nobody survives to inherit it", () => {
    const series = simulateHousehold(
      household({
        persons: [person("alex", DEATH)],
        accounts: [cash("alex-savings", "alex", 100_000)],
        expenseSeries: [],
        deathOwnershipTransfers: [],
      }),
      nullJurisdiction,
    );
    expect(series.months[HORIZON - 1]!.accountBalancesCents["alex-savings"]).toBe(
      dollarsToCents(100_000),
    );
  });
});

describe("the death ownership transfer, derived from a real marriage and a real death", () => {
  const ALEX_DEATH_MONTH = (65 - 60) * 12; // joins at 60, dies at 65

  it("moves Alex's own net worth onto Casey's, at Alex's death month, with no separate event authored", () => {
    // Alex joins as a partner at month 0, brings a savings balance, and dies well before the
    // primary (Casey) — reproducing the reported shape without needing any spending or income
    // to observe it: `netWorthByPersonCents` is exactly what the death boundary reassigns.
    const p = Projection.fromState(
      stateOf({ ...samplePlan, primary: { ...samplePlan.primary, lifeExpectancy: 100 } }),
      nullJurisdiction,
    );
    const alexId = p.marry({
      month: 0,
      name: "Alex",
      birthYear: SAMPLE_START_YEAR - 60,
      lifeExpectancy: 65,
      accounts: {
        savingsBalanceCents: dollarsToCents(500_000),
        savingsReturnPct: 0,
        retirementBalanceCents: 0,
        retirementReturnPct: 0,
        brokerageBalanceCents: 0,
        brokerageReturnPct: 0,
      },
    });
    const result = p.run(nullJurisdiction);
    const before = result.series.months[ALEX_DEATH_MONTH - 1]!.netWorthByPersonCents!;
    const after = result.series.months[ALEX_DEATH_MONTH]!.netWorthByPersonCents!;
    // Real household spending draws Alex's savings down some over the five years before death,
    // so this checks only that real money is still there to transfer, not the brought-in amount.
    expect(before[alexId]).toBeGreaterThan(dollarsToCents(100_000));
    expect(after[alexId] ?? 0).toBe(0);
    // Casey's own net worth rose by (at least) exactly what Alex's held, the same month Alex's
    // dropped to nothing — the same money, re-owned rather than destroyed or duplicated.
    expect(after[PRIMARY_PERSON_ID]! - before[PRIMARY_PERSON_ID]!).toBeGreaterThanOrEqual(
      before[alexId]!,
    );
  });

  it("still drains a departing partner's account to zero on separation — nothing transfers there", () => {
    const p = Projection.fromState(
      stateOf({
        ...samplePlan,
        primary: { ...samplePlan.primary, jobs: [], lifeExpectancy: 100 },
        budgetLines: [],
      }),
      nullJurisdiction,
    );
    const alexId = p.marry({
      month: 0,
      name: "Alex",
      birthYear: SAMPLE_START_YEAR - 60,
      lifeExpectancy: 65,
      accounts: {
        savingsBalanceCents: dollarsToCents(500_000),
        savingsReturnPct: 0,
        retirementBalanceCents: 0,
        retirementReturnPct: 0,
        brokerageBalanceCents: 0,
        brokerageReturnPct: 0,
      },
    });
    p.separate({ month: 12, partnerPersonId: alexId });
    const result = p.run(nullJurisdiction);
    const alexAccountId = Object.keys(result.series.months[0]!.accountBalancesCents).find((id) =>
      id.includes("savings-person"),
    )!;
    expect(result.series.months[12]!.accountBalancesCents[alexAccountId]).toBe(0);
  });
});

describe("estate settlement, after a mid-run ownership transfer", () => {
  /** No income, no spending, no growth, no tax: every dollar present at month 0 is present at the end. */
  function couple(persons: SimPerson[], accounts: SimAccount[], overrides: Partial<HouseholdSimInput> = {}) {
    const horizonMonths = 24;
    return simulateHousehold(
      {
        horizonMonths,
        householdDeathMonthExclusive: horizonMonths,
        annualInflationRate: 0,
        startYear: 2026,
        persons,
        accounts,
        incomeSeries: [],
        expenseSeries: [],
        ...overrides,
      },
      nullJurisdiction,
    );
  }

  it("reports the identical estate whether or not Alex's account was reassigned mid-run", () => {
    const withoutTransfer = couple(
      [person("casey"), person("alex", 12)],
      [account("casey-savings", "casey", 20_000), account("alex-brokerage", "alex", 80_000, CAPITAL_GAINS_TAX_PROFILE)],
    );
    const withTransfer = couple(
      [person("casey"), person("alex", 12)],
      [account("casey-savings", "casey", 20_000), account("alex-brokerage", "alex", 80_000, CAPITAL_GAINS_TAX_PROFILE)],
      { deathOwnershipTransfers: [{ deceasedPersonId: "alex", survivorPersonId: "casey", month: 12 }] },
    );
    expect(withTransfer.estateSettlement!.totalAssetsCents).toBe(
      withoutTransfer.estateSettlement!.totalAssetsCents,
    );
    expect(withTransfer.estateSettlement!.terminalEconomicNetWorthCents).toBe(
      withoutTransfer.estateSettlement!.terminalEconomicNetWorthCents,
    );
    expect(withTransfer.estateSettlement!.totalAssetsCents).toBe(dollarsToCents(100_000));
  });
});
