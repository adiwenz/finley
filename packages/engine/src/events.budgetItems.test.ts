import { describe, it, expect } from "vitest";
import { emptyLedger, replayLedger, type LedgerBaseConfig } from "./index";
import { dollarsToCents, SimCashFlowSeries } from "./cashFlowSeries";
import { nullJurisdiction } from "./jurisdiction";
import { makeLiquidAccount, baseConfig, add } from "./events.testSupport";

// ─── Income series (BudgetItemStartEvent) ─────────────────────────────────────

describe("income series (BudgetItemStartEvent)", () => {
  it("creates income series that increases the liquid account balance", () => {
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      initialAccounts: [makeLiquidAccount()],
    };
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "j1",
      type: "BudgetItemStartEvent",
      month: 0,
      seriesId: "s1",
      ownerId: "p1",
      seriesType: "income",
      monthlyCents: dollarsToCents(5_000), // $5000/mo
      growthMode: { type: "fixed" },
      taxCategory: "wages",
    });
    const series = replayLedger(ledger, cfg, nullJurisdiction);
    // $5000/mo × 12 months = $60,000
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(60_000));
  });

  it("ending an income series and starting a new one swaps the active income", () => {
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      initialAccounts: [makeLiquidAccount()],
    };
    let ledger = emptyLedger;
    // First job: $3000/mo from month 0
    ledger = add(ledger, {
      id: "j1",
      type: "BudgetItemStartEvent",
      month: 0,
      seriesId: "s1",
      ownerId: "p1",
      seriesType: "income",
      monthlyCents: dollarsToCents(3_000), // $3000/mo
      growthMode: { type: "fixed" },
      taxCategory: "wages",
    });
    // Job change at month 6: end s1, then start s2 at $6000/mo
    ledger = add(ledger, {
      id: "end1",
      type: "BudgetItemEndEvent",
      month: 6,
      seriesId: "s1",
    });
    ledger = add(ledger, {
      id: "j2",
      type: "BudgetItemStartEvent",
      month: 6,
      seriesId: "s2",
      ownerId: "p1",
      seriesType: "income",
      monthlyCents: dollarsToCents(6_000), // $6000/mo
      growthMode: { type: "fixed" },
      taxCategory: "wages",
    });
    const series = replayLedger(ledger, cfg, nullJurisdiction);
    // Old job ends at month 5 (endMonth = 6−1); new job starts at month 6.
    // Months 1–5 at $3000 = $15,000; months 6–12 at $6000 = $42,000 → $57,000
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(57_000));
  });
});

// ─── BudgetItemStartEvent / BudgetItemEndEvent ────────────────────────────────

describe("BudgetItemStartEvent / BudgetItemEndEvent", () => {
  it("creates an expense series that reduces net worth", () => {
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      initialAccounts: [makeLiquidAccount("checking", dollarsToCents(24_000))],
    };
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "b1",
      type: "BudgetItemStartEvent",
      month: 0,
      seriesId: "rent",
      ownerId: "p1",
      seriesType: "expense",
      monthlyCents: dollarsToCents(2_000),
      growthMode: { type: "fixed" },
    });
    const series = replayLedger(ledger, cfg, nullJurisdiction);
    // $24,000 opening − $2000/mo × 12 = $0
    expect(series.months[12].netWorthNominalCents).toBe(0);
  });

  it("BudgetItemEndEvent ends the expense series at month−1", () => {
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      initialAccounts: [makeLiquidAccount("checking", dollarsToCents(12_000))],
    };
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "b1",
      type: "BudgetItemStartEvent",
      month: 0,
      seriesId: "rent",
      ownerId: "p1",
      seriesType: "expense",
      monthlyCents: dollarsToCents(1_000),
      growthMode: { type: "fixed" },
    });
    // End rent at month 6 (stops after month 5, last active = month 5)
    ledger = add(ledger, {
      id: "b2",
      type: "BudgetItemEndEvent",
      month: 6,
      seriesId: "rent",
    });
    const series = replayLedger(ledger, cfg, nullJurisdiction);
    // Months 1–5 active: 5 × $1000 = $5000 spent → $7000 remaining
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(7_000));
  });
});

// ─── Base series (value-editing surface, §10.2) ───────────────────────────────

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
    // $4000/mo × 12 = $48,000
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(48_000));
  });

  it("base expense series net against event-derived income", () => {
    const expense = new SimCashFlowSeries(
      0,
      dollarsToCents(1_000),
      { type: "fixed" },
      { baselineUnit: "monthly" },
    );
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      initialAccounts: [makeLiquidAccount()],
      initialExpenseSeries: [{ series: expense, ownerId: "p1" }],
    };
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "j1",
      type: "BudgetItemStartEvent",
      month: 0,
      seriesId: "s1",
      ownerId: "p1",
      seriesType: "income",
      monthlyCents: dollarsToCents(3_000), // $3000/mo
      growthMode: { type: "fixed" },
      taxCategory: "wages",
    });
    const series = replayLedger(ledger, cfg, nullJurisdiction);
    // ($3000 − $1000)/mo × 12 = $24,000
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(24_000));
  });

  it("a fromHereForward value override on a base series changes the trajectory", () => {
    const expense = new SimCashFlowSeries(
      0,
      dollarsToCents(1_000),
      { type: "fixed" },
      { baselineUnit: "monthly" },
    );
    // Value edit (override), NOT an event: expenses rise to $2000 from month 6.
    expense.addOverride(6, dollarsToCents(2_000), "fromHereForward");
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      // Large opening balance so no shortfall cascade / interest muddies the math.
      initialAccounts: [makeLiquidAccount("checking", dollarsToCents(100_000))],
      initialExpenseSeries: [{ series: expense, ownerId: "p1" }],
    };
    const series = replayLedger(emptyLedger, cfg, nullJurisdiction);
    // Flow lands months 1–12. Override at month 6 (fromHereForward) covers
    // months 6–12: 5 months × $1000 + 7 months × $2000 = $19,000 spent.
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(81_000));
  });
});
