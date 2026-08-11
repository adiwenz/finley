import { describe, it, expect } from "vitest";
import { emptyLedger, type Ledger } from "./ledger";
import { addEvent, fundingLookup } from "./addEvent";
import { interpretLedger } from "./interpret";
import { buildProjection } from "../projection/buildHouseholdInput";
import type { LedgerBaseConfig } from "./ledgerBase";
import type { NewLifeEvent } from "./eventTypes";
import { CAPITAL_GAINS_TAX_PROFILE } from "../plan/simAccount";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { personLit } from "./events.testSupport";
import { planAccount, type PlanAccount } from "../plan/planAccount";
import type { PersonId } from "../job/job";

function savings(id: string, openingCents: number): PlanAccount {
  return planAccount({
    id,
    owners: ["p1" as PersonId],
    liquid: true,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    balanceCents: openingCents,
    initialAnnualRate: 0,
  });
}

function baseWith(openingCents: number, extra: readonly PlanAccount[] = []): LedgerBaseConfig {
  return {
    horizonMonths: 24,
    annualInflationRate: 0,
    initialPersons: [personLit("p1", "Alice")],
    initialAccounts: [savings("savings", openingCents), ...extra],
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

describe("OneTimeSpendEvent", () => {
  it("drains the named source and reduces net worth by the spend, at the authored month", () => {
    const base = baseWith(10_000_000); // $100k
    const ledger = addWithBase(emptyLedger, base, spend());
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    expect(series.months[2].accountBalancesCents.savings).toBe(10_000_000);
    const m3 = series.months[3];
    expect(m3.accountBalancesCents.savings).toBe(10_000_000 - AMOUNT);
    expect(m3.netWorthNominalCents).toBe(10_000_000 - AMOUNT);
  });

  it("creates no property or liability — a bare expense, unlike Home Purchase", () => {
    const base = baseWith(10_000_000);
    const ledger = addWithBase(emptyLedger, base, spend());
    const household = interpretLedger(ledger, base);
    expect(household.properties).toHaveLength(0);
    expect(household.liabilities).toHaveLength(0);
  });

  it("drains ordered sources across accounts, each emptied before the next", () => {
    const base = baseWith(1_000_000, [savings("checking", 5_000_000)]);
    const ledger = addWithBase(
      emptyLedger,
      base,
      spend({ fundingSourceIds: ["savings", "checking"] }),
    );
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    const m3 = series.months[3];
    // "savings" ($10k) drained first and fully, "checking" covers the $20k remainder.
    expect(m3.accountBalancesCents.savings).toBe(0);
    expect(m3.accountBalancesCents.checking).toBe(5_000_000 - (AMOUNT - 1_000_000));
  });

  it("draws a named credit card in the user's order — never eligible for a down payment, but expense treatment admits it", () => {
    const base = baseWith(1_000_000);
    const withCard = addWithBase(emptyLedger, base, {
      id: "card",
      type: "LoanEvent",
      month: 0,
      liabilityId: "cc1",
      ownerId: "p1",
      kind: "creditCard",
      openingBalanceCents: 0,
      apr: 0,
      creditLimitCents: 50_000_000,
    } as NewLifeEvent);
    const ledger = addWithBase(withCard, base, spend({ fundingSourceIds: ["savings", "cc1"] }));
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    const m3 = series.months[3];
    expect(m3.accountBalancesCents.savings).toBe(0);
    expect(m3.liabilityBalancesCents.cc1).toBe(AMOUNT - 1_000_000);
    // Net worth falls only by the cash slice — the borrowed slice is a liability, not spent cash.
    expect(m3.netWorthNominalCents).toBe(1_000_000 - AMOUNT);
  });
});

describe("OneTimeSpendEvent — authoring never refuses on affordability", () => {
  it("accepts a spend whose named sources cannot cover it", () => {
    const base = baseWith(1_000_000); // $10k < $30k
    const result = addEvent(emptyLedger, base, spend());
    expect(result.ok).toBe(true);
  });

  it("accepts a spend naming an empty or unknown-balance source", () => {
    const base = baseWith(0);
    const result = addEvent(emptyLedger, base, spend());
    expect(result.ok).toBe(true);
  });

  it("still refuses on STRUCTURAL grounds — an unknown source, or none named at all", () => {
    const base = baseWith(10_000_000);
    expect(addEvent(emptyLedger, base, spend({ fundingSourceIds: [] })).ok).toBe(false);
    expect(addEvent(emptyLedger, base, spend({ fundingSourceIds: ["nope"] })).ok).toBe(false);
    expect(addEvent(emptyLedger, base, spend({ amountCents: 0 })).ok).toBe(false);
  });
});

describe("OneTimeSpendEvent — shortfall blocks the projection rather than financing itself", () => {
  it("stops the projection at the spend's month, naming it as the blocking obligation", () => {
    const base = baseWith(1_000_000); // $10k < $30k, nothing else eligible
    const ledger = addWithBase(emptyLedger, base, spend());
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    expect(series.status).toBe("blocked");
    expect(series.blockedAtMonth).toBe(3);
    expect(series.blockingObligation?.sourceEventId).toBe("spend1");
    expect(series.blockingObligation?.shortfallCents).toBe(AMOUNT - 1_000_000);
  });

  it("does not throw for a stranded event — it blocks and reports a classified failure", () => {
    const base = baseWith(1_000_000);
    const ledger = addWithBase(emptyLedger, base, spend());
    expect(() => buildProjection(interpretLedger(ledger, base), base, nullJurisdiction)).not.toThrow();
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    expect(["funding-configuration", "no-eligible-source-suffices"]).toContain(
      series.blockingObligation?.fundingFailure.kind,
    );
  });

  it("reports no-eligible-source-suffices when the whole eligible pool falls short", () => {
    const base = baseWith(1_000_000);
    const ledger = addWithBase(emptyLedger, base, spend());
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    expect(series.blockingObligation?.fundingFailure.kind).toBe("no-eligible-source-suffices");
  });

  it("reports funding-configuration when eligible money sits in an unselected account", () => {
    const base = baseWith(1_000_000, [savings("checking", 5_000_000)]);
    const ledger = addWithBase(emptyLedger, base, spend()); // only "savings" selected
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    expect(series.blockingObligation?.fundingFailure.kind).toBe("funding-configuration");
  });
});

describe("OneTimeSpendEvent — the double-count tripwire", () => {
  it("appears in expense reporting at its full amount, and never in the automatic funding total", () => {
    const base = baseWith(10_000_000);
    const ledger = addWithBase(emptyLedger, base, spend());
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    const flows = series.months[3].flows;
    expect(flows?.expensesCents).toBeGreaterThanOrEqual(AMOUNT);
    // Nothing about this draw inflated the AUTOMATIC total — it drew its own named source, not
    // the shared waterfall, so `totalObligationsCents` (== automaticFundingTotal) excludes it.
    const withoutSpendBase = baseWith(10_000_000);
    const bareSeries = buildProjection(
      interpretLedger(emptyLedger, withoutSpendBase),
      withoutSpendBase,
      nullJurisdiction,
    );
    expect(flows?.totalObligationsCents ?? 0).toBe(bareSeries.months[3].flows?.totalObligationsCents ?? 0);
  });
});

describe("OneTimeSpendEvent — sibling explicit events resolve in sequence order", () => {
  it("the second spend is validated against what the first left, not the original balance", () => {
    const base = baseWith(5_000_000); // $50k
    let ledger = addWithBase(emptyLedger, base, spend({ id: "spend1", amountCents: 3_000_000 }));
    ledger = addWithBase(
      ledger,
      base,
      spend({ id: "spend2", amountCents: 3_000_000, fundingSourceIds: ["savings"] }),
    );
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    // $50k funds the first $30k spend in full, leaving $20k — short of the second's $30k.
    expect(series.status).toBe("blocked");
    expect(series.blockingObligation?.sourceEventId).toBe("spend2");
    expect(series.blockedAtMonth).toBe(3);
  });
});

describe("OneTimeSpendEvent — gate == sim (fundingLookup mirrors the simulator's own block)", () => {
  it("availabilityAt reports exactly the shortfall the projection later blocks on", () => {
    const base = baseWith(1_000_000);
    const avail = fundingLookup(emptyLedger, base, nullJurisdiction).availabilityAt(
      ["savings"],
      AMOUNT,
      3,
    );
    const ledger = addWithBase(emptyLedger, base, spend());
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    expect(avail.shortfallCents).toBe(series.blockingObligation?.shortfallCents);
  });
});
