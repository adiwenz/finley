/**
 * `OneTimeSpendEvent`: a dated, source-directed cash outflow. These tests pin the
 * ledger-plane behaviour — `check`/`apply`, replay, undo — distinct from the simulator's funding
 * resolution and blocking, which `simulate.oneTimeSpend.test.ts` covers.
 */
import { describe, it, expect } from "vitest";
import { emptyLedger, type Ledger } from "./ledger";
import { addEvent } from "./addEvent";
import { interpretLedger } from "./interpret";
import { removeEvent } from "./removeEvent";
import type { LedgerBaseConfig } from "./ledgerBase";
import type { NewLifeEvent } from "./eventTypes";
import { personLit, makeLiquidAccount } from "./events.testSupport";
import { dollarsToCents } from "../money/cashFlowSeries";

function baseWith(overrides: Partial<LedgerBaseConfig> = {}): LedgerBaseConfig {
  return {
    horizonMonths: 24,
    annualInflationRate: 0,
    initialPersons: [personLit("p1", "Alice")],
    initialAccounts: [makeLiquidAccount("checking", dollarsToCents(50_000))],
    ...overrides,
  };
}

function spend(overrides: Partial<NewLifeEvent> = {}): NewLifeEvent {
  return {
    id: "spend-1",
    type: "OneTimeSpendEvent",
    month: 3,
    label: "New roof",
    amountCents: dollarsToCents(30_000),
    fundingSourceIds: ["checking"],
    ...overrides,
  } as NewLifeEvent;
}

function addWithBase(ledger: Ledger, base: LedgerBaseConfig, event: NewLifeEvent) {
  return addEvent(ledger, base, event);
}

describe("OneTimeSpendEvent — structural validation (check)", () => {
  it("accepts a well-formed spend against a known liquid account", () => {
    const result = addWithBase(emptyLedger, baseWith(), spend());
    expect(result.ok).toBe(true);
  });

  it("refuses an empty label", () => {
    const result = addWithBase(emptyLedger, baseWith(), spend({ label: "  " } as Partial<NewLifeEvent>));
    expect(result.ok).toBe(false);
  });

  it("refuses a non-positive amount", () => {
    const result = addWithBase(emptyLedger, baseWith(), spend({ amountCents: 0 }));
    expect(result.ok).toBe(false);
  });

  it("refuses an empty funding-source list", () => {
    const result = addWithBase(emptyLedger, baseWith(), spend({ fundingSourceIds: [] }));
    expect(result.ok).toBe(false);
  });

  it("refuses a repeated funding source", () => {
    const result = addWithBase(
      emptyLedger,
      baseWith(),
      spend({ fundingSourceIds: ["checking", "checking"] }),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses a funding source that names no known account or credit card", () => {
    const result = addWithBase(emptyLedger, baseWith(), spend({ fundingSourceIds: ["no-such"] }));
    expect(result.ok).toBe(false);
  });

  it("accepts a credit card among the funding sources — unlike a home purchase's down payment", () => {
    const base = baseWith();
    const withCard = addWithBase(emptyLedger, base, {
      id: "card-1",
      type: "LoanEvent",
      month: 0,
      liabilityId: "visa",
      ownerId: "p1",
      kind: "creditCard",
      openingBalanceCents: 0,
      apr: 0.2,
      creditLimitCents: dollarsToCents(10_000),
    } as NewLifeEvent);
    expect(withCard.ok).toBe(true);
    if (!withCard.ok) return;
    const result = addWithBase(withCard.ledger, base, spend({ fundingSourceIds: ["visa"] }));
    expect(result.ok).toBe(true);
  });

  it("never refuses on affordability — a shortfall against the named sources still authors", () => {
    // Unlike `homePurchase.check`'s down-payment hard block, `check` here is purely structural:
    // authoring is never refused because the account cannot actually cover the amount. A
    // shortfall blocks the PROJECTION instead — see simulate.oneTimeSpend.test.ts.
    const base = baseWith({ initialAccounts: [makeLiquidAccount("checking", dollarsToCents(10))] });
    const result = addWithBase(
      emptyLedger,
      base,
      spend({ amountCents: dollarsToCents(30_000), fundingSourceIds: ["checking"] }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("OneTimeSpendEvent — apply, replay, undo", () => {
  it("pushes exactly one explicit expense draw naming its own sources", () => {
    const base = baseWith();
    const added = addEvent(emptyLedger, base, spend());
    if (!added.ok) throw new Error("fixture rejected");
    const state = interpretLedger(added.ledger, base);
    expect(state.fundingDraws).toHaveLength(1);
    const draw = state.fundingDraws[0];
    expect(draw.treatment).toBe("expense");
    expect(draw.month).toBe(3);
    expect(draw.amountCents).toBe(dollarsToCents(30_000));
    expect(draw.funding).toEqual({ kind: "explicit", orderedAccountIds: ["checking"] });
    expect(draw.sourceEventId).toBe("spend-1");
    expect(draw.label).toBe("New roof");
  });

  it("touches no account, series, liability, or property directly — only the draw records the intent", () => {
    // Unlike Home Purchase, a One-Time Spend originates no durable entity: the simulator resolves
    // the draw against real balances later, replay carries only the obligation.
    const base = baseWith();
    const added = addEvent(emptyLedger, base, spend());
    if (!added.ok) throw new Error("fixture rejected");
    const state = interpretLedger(added.ledger, base);
    expect(state.properties).toHaveLength(0);
    expect(state.liabilities).toHaveLength(0);
    expect(state.series).toHaveLength(0);
    expect(state.accountTransfers).toHaveLength(0);
  });

  it("undo drops the draw — the event is fully reversible", () => {
    const base = baseWith();
    const added = addEvent(emptyLedger, base, spend());
    if (!added.ok) throw new Error("fixture rejected");
    const removed = removeEvent(added.ledger, "spend-1", base);
    if (!removed.ok) throw new Error("undo rejected");
    const state = interpretLedger(removed.ledger, base);
    expect(state.fundingDraws).toHaveLength(0);
  });

  it("replays deterministically — the same ledger interprets to the same draw twice", () => {
    const base = baseWith();
    const added = addEvent(emptyLedger, base, spend());
    if (!added.ok) throw new Error("fixture rejected");
    const a = interpretLedger(added.ledger, base);
    const b = interpretLedger(added.ledger, base);
    expect(a.fundingDraws).toEqual(b.fundingDraws);
  });
});
