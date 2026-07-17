/**
 * The §5.0 waterfall config (goals + levers) and the §5.5 income plan descriptor
 * live on the value-editing surface (LedgerBaseConfig), not the event ledger
 * (§10.2). These tests pin that they survive the replay → simulate bridge, so the
 * app's Budget/Accounts + Goals panels (issue #8) actually reach the waterfall.
 */
import { describe, it, expect } from "vitest";
import { emptyLedger, replayLedger, type LedgerBaseConfig } from "../index";
import { CashFlowSeries, dollarsToCents } from "../cashFlowSeries";
import { Account, CAPITAL_GAINS_TAX_PROFILE, PRE_TAX_TAX_PROFILE } from "../account";
import { nullJurisdiction } from "../jurisdiction";

const person = { id: "p1", name: "Alex" };

function monthly(cents: number): CashFlowSeries {
  return new CashFlowSeries(0, cents, { type: "fixed" }, { baselineUnit: "monthly" });
}

function account(id: string, liquid: boolean): Account {
  return new Account({
    id,
    ownerId: "p1",
    liquid,
    taxProfile: liquid ? CAPITAL_GAINS_TAX_PROFILE : PRE_TAX_TAX_PROFILE,
    openingBalanceCents: 0,
    initialAnnualRate: 0,
  });
}

describe("LedgerBaseConfig → waterfall threading (issue #8 spine)", () => {
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
    // $500/mo deferred → $1500 by month 3; $4500/mo take-home idles in savings.
    expect(series.months[3].accountBalancesCents["retirement"]).toBe(dollarsToCents(1500));
    expect(series.months[3].accountBalancesCents["savings"]).toBe(dollarsToCents(13500));
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
          type: "horizon",
          scope: "shared",
        },
      ],
    };
    const series = replayLedger(emptyLedger, base, nullJurisdiction);
    // Filled to its $5000 target by month 3, then capped; surplus idles after.
    expect(series.months[3].accountBalancesCents["emergency"]).toBe(dollarsToCents(5000));
    expect(series.months[6].accountBalancesCents["emergency"]).toBe(dollarsToCents(5000));
    expect(series.months[6].accountBalancesCents["savings"]).toBe(dollarsToCents(7000));
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
    expect(series.months[6].accountBalancesCents["brokerage"]).toBe(dollarsToCents(12000));
    expect(series.months[6].accountBalancesCents["savings"]).toBe(0);
  });
});
