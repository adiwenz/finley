/**
 * The waterfall config (goals + levers) and the income plan descriptor live on the
 * value-editing surface (LedgerBaseConfig), not the event ledger. These tests pin that they
 * survive the replay → simulate bridge, so the app's Budget/Accounts + Goals panels reach
 * the waterfall.
 */
import { describe, it, expect } from "vitest";
import { emptyLedger } from "./ledger";
import { replayLedger } from "../projection/buildHouseholdInput";
import type { LedgerBaseConfig } from "./ledgerBase";
import { SimCashFlowSeries, dollarsToCents } from "../money/cashFlowSeries";
import { CAPITAL_GAINS_TAX_PROFILE, PRE_TAX_TAX_PROFILE } from "../plan/simAccount";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import type { Person } from "../plan/person";
import { planAccount, type PlanAccount } from "../plan/planAccount";
import type { PersonId } from "../job/job";

const person: Person = {
  id: "p1",
  name: "Alex",
  birthYear: 1990,
  lifeExpectancy: 85,
  benefitClaimingAge: 67,
  jobs: [],
};

function monthly(cents: number): SimCashFlowSeries {
  return new SimCashFlowSeries(0, cents, { type: "fixed" }, { baselineUnit: "monthly" });
}

function account(id: string, liquid: boolean): PlanAccount {
  return planAccount({
    id,
    owners: ["p1" as PersonId],
    liquid,
    taxProfile: liquid ? CAPITAL_GAINS_TAX_PROFILE : PRE_TAX_TAX_PROFILE,
    balanceCents: 0,
    initialAnnualRate: 0,
  });
}

describe("LedgerBaseConfig → waterfall threading", () => {
  it("a base income series' planDescriptor defers pre-tax through replay", () => {
    const base: LedgerBaseConfig = {
      horizonMonths: 3,
      annualInflationRate: 0,
      initialPersons: [person],
      initialAccounts: [account("savings", true), account("retirement", false)],
      initialIncomeSeries: [
        {
          series: monthly(dollarsToCents(5000)),
          ownerId: "p1",
          planDescriptor: { deferralFraction: 0.1, fundAccountId: "retirement" },
        },
      ],
    };
    const series = replayLedger(emptyLedger, base, nullJurisdiction);
    // 3 flow-months (months[2] is the last of a 3-month horizon): $500/mo deferred → $1500;
    // $4500/mo take-home idles in savings → $13500.
    expect(series.months[2].accountBalancesCents["retirement"]).toBe(dollarsToCents(1500));
    expect(series.months[2].accountBalancesCents["savings"]).toBe(dollarsToCents(13500));
  });

  it("base goals fund in priority order ahead of idle surplus", () => {
    const base: LedgerBaseConfig = {
      horizonMonths: 6,
      annualInflationRate: 0,
      initialPersons: [person],
      initialAccounts: [account("savings", true), account("emergency", false)],
      initialIncomeSeries: [{ series: monthly(dollarsToCents(2000)), ownerId: "p1" }],
      goals: [
        {
          id: "ef",
          name: "Emergency fund",
          targetCents: dollarsToCents(5000),
          targetDate: "asap",
          fundAccountId: "emergency",
          priority: 1,
          disposition: "drawDown",
          scope: "shared",
        },
      ],
    };
    const series = replayLedger(emptyLedger, base, nullJurisdiction);
    // Filled to its $5000 target after 3 flow-months (months[2]: $2000+$2000+$1000), then
    // capped; by the last of the 6-month horizon (months[5]) the surplus has idled into savings.
    expect(series.months[2].accountBalancesCents["emergency"]).toBe(dollarsToCents(5000));
    expect(series.months[5].accountBalancesCents["emergency"]).toBe(dollarsToCents(5000));
    expect(series.months[5].accountBalancesCents["savings"]).toBe(dollarsToCents(7000));
  });

  it("the surplus-destination lever routes leftover away from liquid", () => {
    const base: LedgerBaseConfig = {
      horizonMonths: 6,
      annualInflationRate: 0,
      initialPersons: [person],
      initialAccounts: [account("savings", true), account("brokerage", false)],
      initialIncomeSeries: [{ series: monthly(dollarsToCents(2000)), ownerId: "p1" }],
      surplusDestination: { kind: "swept", accountId: "brokerage" },
    };
    const series = replayLedger(emptyLedger, base, nullJurisdiction);
    // 6 flow-months (months[5] is the last of the 6-month horizon): all $2000/mo swept away.
    expect(series.months[5].accountBalancesCents["brokerage"]).toBe(dollarsToCents(12000));
    expect(series.months[5].accountBalancesCents["savings"]).toBe(0);
  });
});
