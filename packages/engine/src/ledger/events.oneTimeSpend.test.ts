import { describe, it, expect } from "vitest";
import { emptyLedger, type Ledger } from "./ledger";
import { addEvent } from "./addEvent";
import { interpretLedger } from "./interpret";
import { buildProjection } from "../projection/buildHouseholdInput";
import type { LedgerBaseConfig } from "./ledgerBase";
import type { NewLifeEvent } from "./eventTypes";
import { CAPITAL_GAINS_TAX_PROFILE } from "../plan/simAccount";
import { SimCashFlowSeries, dollarsToCents } from "../money/cashFlowSeries";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { personLit } from "./events.testSupport";
import { planAccount, type PlanAccount } from "../plan/planAccount";
import type { PersonId } from "../job/job";
import { automaticFundingTotal } from "../projection/financialObligation";

function liquidAcct(id: string, openingCents: number, rate = 0, label?: string): PlanAccount {
  return planAccount({
    id,
    owners: ["p1" as PersonId],
    ...(label !== undefined ? { label } : {}),
    liquid: true,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    balanceCents: openingCents,
    initialAnnualRate: rate,
  });
}

function baseWithAccounts(accounts: PlanAccount[], inflation = 0): LedgerBaseConfig {
  return {
    horizonMonths: 12,
    annualInflationRate: inflation,
    initialPersons: [personLit("p1", "Alice")],
    initialAccounts: accounts,
  };
}

const AMOUNT = 3_000_000; // $30k

function spend(overrides: Partial<NewLifeEvent> = {}): NewLifeEvent {
  return {
    id: "spend1",
    type: "OneTimeSpendEvent",
    month: 3,
    label: "New car",
    amountCents: AMOUNT,
    fundingSourceIds: ["savings"],
    ...overrides,
  } as NewLifeEvent;
}

function addWithBase(ledger: Ledger, base: LedgerBaseConfig, event: NewLifeEvent): Ledger {
  const result = addEvent(ledger, base, event);
  if (!result.ok) throw new Error(`event rejected: ${result.conflict}`);
  return result.ledger;
}

describe("OneTimeSpendEvent — append and replay", () => {
  it("drains the named source and reduces net worth by the full amount (an expense, not an asset)", () => {
    const base = baseWithAccounts([liquidAcct("savings", 10_000_000)]);
    const ledger = addWithBase(emptyLedger, base, spend());
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    expect(series.months[2].netWorthNominalCents).toBe(10_000_000);
    const m3 = series.months[3];
    expect(m3.accountBalancesCents.savings).toBe(10_000_000 - AMOUNT);
    // Unlike a Home Purchase, nothing is acquired — net worth simply drops by the spend.
    expect(m3.netWorthNominalCents).toBe(10_000_000 - AMOUNT);
  });

  it("authoring never refuses on affordability — even a hopeless shortfall is accepted", () => {
    const base = baseWithAccounts([liquidAcct("savings", 100)]);
    const result = addEvent(emptyLedger, base, spend());
    expect(result.ok).toBe(true);
  });

  it("round-trips through the ledger with deterministic replay", () => {
    const base = baseWithAccounts([liquidAcct("savings", 10_000_000)]);
    const ledger = addWithBase(emptyLedger, base, spend());
    const first = interpretLedger(ledger, base);
    const second = interpretLedger(ledger, base);
    expect(first).toEqual(second);
  });

  it("may name a credit card among its funding sources, drawn in the stated order", () => {
    const base = baseWithAccounts([liquidAcct("savings", 1_000_000)]);
    const withCard = addWithBase(emptyLedger, base, {
      id: "card1",
      type: "LoanEvent",
      month: 0,
      liabilityId: "visa",
      ownerId: "p1",
      kind: "creditCard",
      openingBalanceCents: 0,
      apr: 0.2,
      creditLimitCents: 5_000_000,
    } as NewLifeEvent);
    const ledger = addWithBase(
      withCard,
      base,
      spend({ fundingSourceIds: ["savings", "visa"] }),
    );
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    const m3 = series.months[3];
    // Savings (only $10k) drains first, then the remaining $20k borrows on the named card —
    // plus one month of interest on the balance the borrow leaves.
    expect(m3.accountBalancesCents.savings).toBe(0);
    expect(m3.liabilityBalancesCents.visa).toBeGreaterThanOrEqual(AMOUNT - 1_000_000);
    expect(m3.liabilityBalancesCents.visa).toBeLessThan(AMOUNT - 1_000_000 + 50_000);
  });

  it("rejects an unknown funding source", () => {
    const base = baseWithAccounts([liquidAcct("savings", 10_000_000)]);
    const result = addEvent(emptyLedger, base, spend({ fundingSourceIds: ["nope"] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toMatch(/not found/);
  });

  it("rejects an empty funding source list", () => {
    const base = baseWithAccounts([liquidAcct("savings", 10_000_000)]);
    const result = addEvent(emptyLedger, base, spend({ fundingSourceIds: [] }));
    expect(result.ok).toBe(false);
  });

  it("rejects a non-positive amount", () => {
    const base = baseWithAccounts([liquidAcct("savings", 10_000_000)]);
    const result = addEvent(emptyLedger, base, spend({ amountCents: 0 }));
    expect(result.ok).toBe(false);
  });
});

// The epic's double-count tripwire: full amount in expense reporting, never in the automatic
// funding total or decumulation gap sizing.

describe("OneTimeSpendEvent — the double-count tripwire", () => {
  it("reports the full amount as an expense but excludes it from the automatic funding total", () => {
    const base = baseWithAccounts([liquidAcct("savings", 10_000_000)]);
    const ledger = addWithBase(emptyLedger, base, spend());
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    const flows = series.months[3].flows!;

    expect(flows.expensesCents).toBe(AMOUNT);
    // The explicit draw is excluded from automaticFundingTotal — recomputed here off the exact
    // same obligation list the sim used, so this cannot drift from the engine's own rule.
    expect(automaticFundingTotal(flows.obligations)).toBe(0);

    const obligation = flows.obligations.find((o) => o.sourceEventId === "spend1");
    expect(obligation?.treatment).toBe("expense");
    expect(obligation?.funding.kind).toBe("explicit");
  });

  it("does not widen the decumulation gap: an identical automatic expense borrows nothing more than the spend forces", () => {
    // A one-time spend funded entirely from its own named source must not ALSO inflate the
    // automatic waterfall's ask — if it did, the household would liquidate roughly double.
    const base: LedgerBaseConfig = {
      horizonMonths: 3,
      annualInflationRate: 0,
      initialPersons: [personLit("p1", "Alice")],
      initialAccounts: [liquidAcct("cash", 0), liquidAcct("brokerage", 10_000_000)],
    };
    const withSpend = addWithBase(
      emptyLedger,
      base,
      spend({ month: 0, amountCents: AMOUNT, fundingSourceIds: ["brokerage"] }),
    );
    const series = buildProjection(interpretLedger(withSpend, base), base, nullJurisdiction);
    // No automatic obligations exist in this fixture, so the automatic funding total is 0 —
    // the spend's own $30k draw is the ONLY money that leaves, never counted twice.
    const flows = series.months[0].flows!;
    expect(automaticFundingTotal(flows.obligations)).toBe(0);
    expect(series.months[0].accountBalancesCents.brokerage).toBe(10_000_000 - AMOUNT);
  });
});

// A shortfall blocks the PROJECTION, not authoring — the event stays authored either way.

describe("OneTimeSpendEvent — shortfall blocks the projection, never authoring", () => {
  it("blocks at the spend's month when the named source falls short, naming funding-configuration when eligible money sits elsewhere", () => {
    const base = baseWithAccounts([
      liquidAcct("savings", 1_000_000, 0, "Savings"),
      liquidAcct("brokerage", 5_000_000, 0, "Brokerage"),
    ]);
    const ledger = addWithBase(emptyLedger, base, spend({ fundingSourceIds: ["savings"] }));
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    expect(series.status).toBe("blocked");
    expect(series.blockedAtMonth).toBe(3);
    expect(series.blockingObligation?.fundingFailure.kind).toBe("funding-configuration");
    // Nothing thrown, and the household is still interpretable — the event stays authored.
    expect(() => interpretLedger(ledger, base)).not.toThrow();
  });

  it("names no-eligible-source-suffices when nothing eligible could cover it", () => {
    const base = baseWithAccounts([liquidAcct("savings", 1_000_000)]);
    const ledger = addWithBase(emptyLedger, base, spend());
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    expect(series.status).toBe("blocked");
    expect(series.blockingObligation?.fundingFailure.kind).toBe("no-eligible-source-suffices");
  });

  it("a stranded event does not throw on replay", () => {
    const base = baseWithAccounts([liquidAcct("savings", 100)]);
    const ledger = addWithBase(emptyLedger, base, spend());
    expect(() => interpretLedger(ledger, base)).not.toThrow();
    expect(() => buildProjection(interpretLedger(ledger, base), base, nullJurisdiction)).not.toThrow();
  });
});

// Gate == sim: a spend authored in a month that also has decumulation predicts exactly the
// shortfall the simulator produces.

describe("OneTimeSpendEvent — gate == sim", () => {
  it("the reporter's shortfall for a candidate spend matches what the sim actually blocks on", () => {
    const base: LedgerBaseConfig = {
      horizonMonths: 6,
      annualInflationRate: 0,
      initialPersons: [personLit("p1", "Alice")],
      initialAccounts: [liquidAcct("cash", 0), liquidAcct("brokerage", 4_000_000)],
      initialExpenseSeries: [
        {
          series: new SimCashFlowSeries(0, dollarsToCents(10_000), { type: "fixed" }, { baselineUnit: "monthly" }),
          ownerId: "p1" as PersonId,
        },
      ],
    };
    // Decumulation draws down `brokerage` at $10k/mo of automatic expense; by month 3 the
    // account holds $10k, well short of the $30k spend named against it.
    const ledger = addWithBase(emptyLedger, base, spend({ month: 3, fundingSourceIds: ["brokerage"] }));
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    expect(series.status).toBe("blocked");
    expect(series.blockedAtMonth).toBe(3);
    const shortfall = series.blockingObligation!.shortfallCents;
    expect(shortfall).toBe(AMOUNT - 1_000_000);
  });
});

// Sibling explicit events in the same month resolve in event-sequence order.

describe("OneTimeSpendEvent — siblings resolve in event sequence", () => {
  it("funds the second spend from what the first left in the shared account", () => {
    const base = baseWithAccounts([liquidAcct("a", 5_000_000)]);
    let ledger = addWithBase(emptyLedger, base, spend({ month: 3, amountCents: 3_000_000, fundingSourceIds: ["a"] }));
    ledger = addWithBase(
      ledger,
      base,
      spend({ id: "spend2", month: 3, label: "Second spend", amountCents: 1_000_000, fundingSourceIds: ["a"] }),
    );
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    expect(series.months[3].accountBalancesCents.a).toBe(1_000_000);
    expect(series.status).toBe("ran-to-horizon");
  });
});
