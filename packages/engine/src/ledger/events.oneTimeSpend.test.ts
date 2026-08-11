/**
 * OneTimeSpendEvent: a dated, source-directed cash outflow — the down payment's `expense`
 * sibling. Shares the exact draw/gate/block machinery {@link
 * import("./events.homePurchase.test").purchase} exercises for Home Purchase; these tests pin
 * only what is DISTINCT about a spend: it never refuses on affordability, it may name a credit
 * card, and it must appear in expense reporting without ever inflating the automatic total.
 */

import { describe, it, expect } from "vitest";
import { emptyLedger, type Ledger } from "./ledger";
import { addEvent, fundingLookup } from "./addEvent";
import { interpretLedger } from "./interpret";
import { removeEvent } from "./removeEvent";
import { buildProjection } from "../projection/buildHouseholdInput";
import type { LedgerBaseConfig } from "./ledgerBase";
import type { NewLifeEvent } from "./eventTypes";
import { CAPITAL_GAINS_TAX_PROFILE } from "../plan/simAccount";
import { SimCashFlowSeries, dollarsToCents } from "../money/cashFlowSeries";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { personLit } from "./events.testSupport";
import { planAccount, type PlanAccount } from "../plan/planAccount";
import type { PersonId } from "../job/job";
import { SYNTHETIC_CARD_ID } from "../liability/liability";

const AMOUNT = 3_000_000; // $30k

function liquidAcct(id: string, openingCents: number, rate = 0): PlanAccount {
  return planAccount({
    id,
    owners: ["p1" as PersonId],
    liquid: true,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    balanceCents: openingCents,
    initialAnnualRate: rate,
  });
}

function baseWithAccounts(accounts: PlanAccount[]): LedgerBaseConfig {
  return {
    horizonMonths: 24,
    annualInflationRate: 0,
    initialPersons: [personLit("p1", "Alice")],
    initialAccounts: accounts,
  };
}

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
  it("drains the named source and conserves net worth", () => {
    const base = baseWithAccounts([liquidAcct("savings", 5_000_000)]);
    const ledger = addWithBase(emptyLedger, base, spend());
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    expect(series.months[2].accountBalancesCents.savings).toBe(5_000_000);
    const netBefore = series.months[2].netWorthNominalCents;
    expect(series.months[3].accountBalancesCents.savings).toBe(5_000_000 - AMOUNT);
    // Spending, not acquiring: net worth drops by the amount, unlike a home purchase.
    expect(series.months[3].netWorthNominalCents).toBe((netBefore ?? 0) - AMOUNT);
  });

  it("drains ordered sources in order, each emptied before the next", () => {
    const base = baseWithAccounts([liquidAcct("a", 1_000_000), liquidAcct("b", 5_000_000)]);
    const ledger = addWithBase(
      emptyLedger,
      base,
      spend({ fundingSourceIds: ["a", "b"] }),
    );
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    const m3 = series.months[3];
    expect(m3.accountBalancesCents.a).toBe(0);
    expect(m3.accountBalancesCents.b).toBe(1_000_000 + 5_000_000 - AMOUNT);
  });

  it("round-trips through the ledger and undoes cleanly", () => {
    const base = baseWithAccounts([liquidAcct("savings", 5_000_000)]);
    const ledger = addWithBase(emptyLedger, base, spend());
    expect(ledger.events).toHaveLength(1);
    const result = removeEvent(ledger, "spend1", base);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ledger.events).toHaveLength(0);
      const series = buildProjection(interpretLedger(result.ledger, base), base, nullJurisdiction);
      expect(series.months[3].accountBalancesCents.savings).toBe(5_000_000);
    }
  });

  it("rejects a funding source that names no known account or card", () => {
    const base = baseWithAccounts([liquidAcct("savings", 5_000_000)]);
    const result = addEvent(emptyLedger, base, spend({ fundingSourceIds: ["ghost"] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toMatch(/funding source "ghost" not found/);
  });

  it("rejects zero funding sources, an empty label, or a non-positive amount", () => {
    const base = baseWithAccounts([liquidAcct("savings", 5_000_000)]);
    expect(addEvent(emptyLedger, base, spend({ fundingSourceIds: [] })).ok).toBe(false);
    expect(addEvent(emptyLedger, base, spend({ label: "" })).ok).toBe(false);
    expect(addEvent(emptyLedger, base, spend({ amountCents: 0 })).ok).toBe(false);
  });
});

describe("OneTimeSpendEvent — authoring never refuses on affordability (#189)", () => {
  it("authors a spend whose named source cannot cover it — no down-payment-style hard block", () => {
    // Unlike HomePurchaseEvent, a shortfall here does not refuse authoring.
    const base = baseWithAccounts([liquidAcct("savings", 100_000)]); // $1k < $30k
    const result = addEvent(emptyLedger, base, spend());
    expect(result.ok).toBe(true);
  });

  it("blocks the PROJECTION instead, naming the shortfall the same way an unaffordable down payment does", () => {
    const base = baseWithAccounts([liquidAcct("savings", 100_000)]);
    const ledger = addWithBase(emptyLedger, base, spend());
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    expect(series.status).toBe("blocked");
    expect(series.blockingObligation?.month).toBe(3);
    expect(series.blockingObligation?.shortfallCents).toBe(AMOUNT - 100_000);
    expect(["funding-configuration", "no-eligible-source-suffices"]).toContain(
      series.blockingObligation?.fundingFailure.kind,
    );
    // A stranded event does not throw — the projection ran to the block and stopped cleanly.
    expect(series.months.length).toBeGreaterThan(0);
  });

  it("names an alternative eligible account instead of refusing blind, when one exists", () => {
    const base = baseWithAccounts([liquidAcct("savings", 100_000), liquidAcct("brokerage", 5_000_000)]);
    const ledger = addWithBase(emptyLedger, base, spend());
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    expect(series.blockingObligation?.fundingFailure.kind).toBe("funding-configuration");
  });
});

describe("OneTimeSpendEvent — a credit card may be named among the sources (#191)", () => {
  function withCard(base: LedgerBaseConfig, creditLimitCents: number): Ledger {
    return addWithBase(emptyLedger, base, {
      id: "card1",
      type: "LoanEvent",
      month: 0,
      liabilityId: "cc1",
      ownerId: "p1",
      kind: "creditCard",
      openingBalanceCents: 0,
      apr: 0,
      creditLimitCents,
    } as NewLifeEvent);
  }

  it("draws credit as a named source, ordered after cash, and never spills to the cascade", () => {
    const base = baseWithAccounts([liquidAcct("savings", 1_000_000)]);
    const ledger = addWithBase(withCard(base, 5_000_000), base, spend({ fundingSourceIds: ["savings", "cc1"] }));
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    const m3 = series.months[3];

    expect(m3.accountBalancesCents.savings).toBe(0);
    expect(m3.liabilityBalancesCents.cc1).toBe(AMOUNT - 1_000_000);
    // The named card covered the shortfall itself — the synthetic shortfall card never engages.
    expect(m3.liabilityBalancesCents[SYNTHETIC_CARD_ID] ?? 0).toBe(0);
  });

  it("blocks rather than substituting an unnamed card once every named source (cash + its card) is exhausted", () => {
    const base = baseWithAccounts([liquidAcct("savings", 100_000)]);
    const ledger = addWithBase(withCard(base, 500_000), base, spend({ fundingSourceIds: ["savings", "cc1"] }));
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    expect(series.status).toBe("blocked");
    expect(series.blockingObligation?.shortfallCents).toBe(AMOUNT - 100_000 - 500_000);
  });
});

describe("OneTimeSpendEvent — expense reporting vs. the automatic funding total (the tripwire)", () => {
  it("appears in expense reporting at its full amount", () => {
    const base = baseWithAccounts([liquidAcct("savings", 5_000_000)]);
    const ledger = addWithBase(emptyLedger, base, spend());
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    expect(series.months[3].flows?.expensesCents).toBe(AMOUNT);
  });

  it("never enters the automatic funding total or widens the decumulation gap", () => {
    // $60k brokerage funds both the $30k spend and a $20k/mo automatic obligation with no income.
    // Were the spend double-counted into the automatic total, decumulation would try to liquidate
    // roughly DOUBLE ($40k) from the $30k the spend left behind and spill the rest onto the
    // synthetic shortfall card; since it does not, decumulation covers exactly its own $20k,
    // leaving $10k and borrowing nothing.
    const base: LedgerBaseConfig = {
      ...baseWithAccounts([liquidAcct("brokerage", 6_000_000)]),
      initialExpenseSeries: [
        {
          series: new SimCashFlowSeries(0, dollarsToCents(20_000), { type: "fixed" }, { baselineUnit: "monthly" }),
          ownerId: "p1" as PersonId,
        },
      ],
      horizonMonths: 3,
    };
    const ledger = addWithBase(
      emptyLedger,
      base,
      spend({ month: 0, fundingSourceIds: ["brokerage"] }),
    );
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    expect(series.months[0].liabilityBalancesCents[SYNTHETIC_CARD_ID] ?? 0).toBe(0);
    expect(series.months[0].accountBalancesCents.brokerage).toBe(6_000_000 - AMOUNT - 2_000_000);
  });
});

describe("OneTimeSpendEvent — gate == sim", () => {
  it("predicts exactly the shortfall the simulator produces for a spend authored in a decumulating month", () => {
    const base: LedgerBaseConfig = {
      ...baseWithAccounts([liquidAcct("brokerage", 2_000_000)]),
      initialExpenseSeries: [
        {
          series: new SimCashFlowSeries(0, dollarsToCents(10_000), { type: "fixed" }, { baselineUnit: "monthly" }),
          ownerId: "p1" as PersonId,
        },
      ],
      horizonMonths: 3,
    };
    const candidate = spend({ month: 0, amountCents: 2_500_000, fundingSourceIds: ["brokerage"] });
    const candidateFields = candidate as unknown as {
      fundingSourceIds: string[];
      amountCents: number;
      month: number;
    };
    const gateShortfall = fundingLookup(emptyLedger, base, nullJurisdiction).availabilityAt(
      candidateFields.fundingSourceIds,
      candidateFields.amountCents,
      candidateFields.month,
    ).shortfallCents;

    const ledger = addWithBase(emptyLedger, base, candidate);
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    expect(series.blockingObligation?.shortfallCents).toBe(gateShortfall);
    expect(gateShortfall).toBeGreaterThan(0);
  });
});

describe("OneTimeSpendEvent — siblings in the same month resolve in event-sequence order", () => {
  it("funds the second spend from what the first left in the shared account", () => {
    const base = baseWithAccounts([liquidAcct("a", 4_000_000)]);
    let ledger = addWithBase(emptyLedger, base, spend({ id: "spend1", month: 3, amountCents: 3_000_000, fundingSourceIds: ["a"] }));
    ledger = addWithBase(
      ledger,
      base,
      spend({ id: "spend2", month: 3, amountCents: 500_000, fundingSourceIds: ["a"] }),
    );
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    expect(series.months[3].accountBalancesCents.a).toBe(4_000_000 - 3_000_000 - 500_000);
  });
});
