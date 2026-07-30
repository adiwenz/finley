import { describe, it, expect } from "vitest";
import { emptyLedger } from "./ledger/ledger";
import { replayLedger } from "./projection/buildHouseholdInput";
import type { LedgerBaseConfig } from "./ledger/ledgerBase";
import { dollarsToCents, SimCashFlowSeries } from "./cashFlowSeries";
import { nullJurisdiction } from "./jurisdiction";
import { makeLiquidAccount, baseConfig } from "./events.testSupport";

// Base income/expense series are the value-editing surface — the Base + Adjustments budget.
// They are the sole source of truth for a recurring rate: no timeline event authors one, so
// these drive the projection straight from the base config with an empty ledger.

describe("initialIncomeSeries / initialExpenseSeries", () => {
  it("base income series drive net worth without any events", () => {
    const income = new SimCashFlowSeries(
      0,
      dollarsToCents(4_000),
      { type: "fixed" },
      { baselineUnit: "monthly" },
    );
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      initialAccounts: [makeLiquidAccount()],
      initialIncomeSeries: [{ series: income, ownerId: "p1" }],
    };
    const series = replayLedger(emptyLedger, cfg, nullJurisdiction);
    // $4000/mo × 12 processed months (0..11) = $48,000
    expect(series.months[11].netWorthNominalCents).toBe(dollarsToCents(48_000));
  });

  it("base income and expense net against each other", () => {
    const income = new SimCashFlowSeries(
      0,
      dollarsToCents(3_000),
      { type: "fixed" },
      { baselineUnit: "monthly" },
    );
    const expense = new SimCashFlowSeries(
      0,
      dollarsToCents(1_000),
      { type: "fixed" },
      { baselineUnit: "monthly" },
    );
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      initialAccounts: [makeLiquidAccount()],
      initialIncomeSeries: [{ series: income, ownerId: "p1" }],
      initialExpenseSeries: [{ series: expense, ownerId: "p1" }],
    };
    const series = replayLedger(emptyLedger, cfg, nullJurisdiction);
    // ($3000 − $1000)/mo × 12 processed months (0..11) = $24,000
    expect(series.months[11].netWorthNominalCents).toBe(dollarsToCents(24_000));
  });

  it("a fromHereForward value override on a base series changes the trajectory", () => {
    const expense = new SimCashFlowSeries(
      0,
      dollarsToCents(1_000),
      { type: "fixed" },
      { baselineUnit: "monthly" },
    );
    // A value edit, NOT an event: expenses rise to $2000 from month 6.
    expense.addOverride(6, dollarsToCents(2_000), "fromHereForward");
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      // Large opening balance so no cascade or interest muddies the math.
      initialAccounts: [makeLiquidAccount("checking", dollarsToCents(100_000))],
      initialExpenseSeries: [{ series: expense, ownerId: "p1" }],
    };
    const series = replayLedger(emptyLedger, cfg, nullJurisdiction);
    // Flow lands processed months 0–11; the fromHereForward override covers 6–11:
    // 6 × $1000 + 6 × $2000 = $18,000 spent → $82,000 left.
    expect(series.months[11].netWorthNominalCents).toBe(dollarsToCents(82_000));
  });
});
