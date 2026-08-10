import { describe, it, expect } from "vitest";
import { emptyLedger, type Ledger } from "./ledger";
import { addEvent } from "./addEvent";
import { interpretLedger } from "./interpret";
import { buildProjection } from "../projection/buildHouseholdInput";
import type { LedgerBaseConfig } from "./ledgerBase";
import type { NewLifeEvent } from "./eventTypes";
import { CAPITAL_GAINS_TAX_PROFILE } from "../plan/simAccount";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { personLit } from "./events.testSupport";
import { planAccount, type PlanAccount } from "../plan/planAccount";
import type { PersonId } from "../job/job";
import { PRE_NOW_MONTH } from "../projection/nowMarker";
import { Projection } from "../facade/projectionFacade";
import { oneTimeSpendInsolvencyNudge } from "../authoring/spending";
import { SAVINGS_ID } from "../compile/projectionBase";

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
    amountCents: 3_000_000, // $30k
    fundingSourceIds: ["checking"],
    ...overrides,
  } as NewLifeEvent;
}

function addWithBase(ledger: Ledger, base: LedgerBaseConfig, event: NewLifeEvent): Ledger {
  const result = addEvent(ledger, base, event);
  if (!result.ok) throw new Error(`event rejected: ${result.conflict}`);
  return result.ledger;
}

function cardLoanEvent(overrides: Partial<NewLifeEvent> = {}): NewLifeEvent {
  return {
    id: "card1",
    type: "LoanEvent",
    month: PRE_NOW_MONTH,
    liabilityId: "visa",
    ownerId: "p1",
    kind: "creditCard",
    openingBalanceCents: 0,
    apr: 0,
    creditLimitCents: 10_000_00,
    ...overrides,
  } as NewLifeEvent;
}

describe("OneTimeSpendEvent — one explicit expense obligation", () => {
  it("drains the named source and leaves everything else untouched", () => {
    const base = baseWithAccounts([liquidAcct("checking", 10_000_000)]);
    const ledger = addWithBase(emptyLedger, base, spend());
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    expect(series.months[2].accountBalancesCents.checking).toBe(10_000_000);
    const m3 = series.months[3];
    expect(m3.accountBalancesCents.checking).toBe(10_000_000 - 3_000_000);
    expect(m3.netWorthNominalCents).toBe(10_000_000 - 3_000_000);
  });

  it("round-trips through replay: interpreting the ledger twice yields the identical draw", () => {
    const base = baseWithAccounts([liquidAcct("checking", 10_000_000)]);
    const ledger = addWithBase(emptyLedger, base, spend());
    const first = interpretLedger(ledger, base);
    const second = interpretLedger(ledger, base);
    expect(first.fundingDraws).toEqual(second.fundingDraws);
    expect(first.fundingDraws).toHaveLength(1);
    expect(first.fundingDraws[0]).toMatchObject({
      treatment: "expense",
      funding: { kind: "explicit", orderedAccountIds: ["checking"] },
      amountCents: 3_000_000,
      sourceEventId: "spend1",
    });
  });
});

// The epic's double-count tripwire: the spend must appear in expense reporting at its full
// amount, and never in the automatic funding total the waterfall was sized against.

describe("OneTimeSpendEvent — the double-count tripwire", () => {
  it("appears in expense reporting at its full amount, and never in the automatic funding total", () => {
    const base = baseWithAccounts([liquidAcct("checking", 10_000_000)]);
    const withSpend = buildProjection(
      interpretLedger(addWithBase(emptyLedger, base, spend()), base),
      base,
      nullJurisdiction,
    );
    const without = buildProjection(interpretLedger(emptyLedger, base), base, nullJurisdiction);

    const flowsWith = withSpend.months[3].flows!;
    const flowsWithout = without.months[3].flows!;

    // Full amount in expense reporting.
    expect(flowsWith.expensesCents - flowsWithout.expensesCents).toBe(3_000_000);
    // Untouched automatic funding total — the waterfall never sized against this draw.
    expect(flowsWith.totalObligationsCents).toBe(flowsWithout.totalObligationsCents);
  });
});

// Authoring never refuses on affordability — only a shortfall blocks the PROJECTION.

describe("OneTimeSpendEvent — authoring never refuses on affordability", () => {
  it("accepts an event whose named source cannot possibly cover it", () => {
    const base = baseWithAccounts([liquidAcct("checking", 1_00)]); // $1
    const result = addEvent(emptyLedger, base, spend());
    expect(result.ok).toBe(true);
  });

  it("blocks the projection at the event's month, reporting the block instead", () => {
    const base = baseWithAccounts([liquidAcct("checking", 1_00)]);
    const ledger = addWithBase(emptyLedger, base, spend());
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    expect(series.status).toBe("blocked");
    expect(series.blockedAtMonth).toBe(3);
    expect(series.blockingObligation?.fundingFailure.kind).toBe("no-eligible-source-suffices");
  });

  it("names an eligible unselected account instead — funding-configuration, not insolvency", () => {
    const base = baseWithAccounts([liquidAcct("checking", 1_00), liquidAcct("brokerage", 10_000_000)]);
    const ledger = addWithBase(emptyLedger, base, spend({ fundingSourceIds: ["checking"] }));
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    expect(series.status).toBe("blocked");
    const failure = series.blockingObligation?.fundingFailure;
    expect(failure?.kind).toBe("funding-configuration");
    if (failure?.kind === "funding-configuration") {
      expect(failure.alternativeSources.map((s) => s.accountId)).toContain("brokerage");
    }
  });

  it("does not throw on a stranded spend — the projection just stops cleanly", () => {
    const base = baseWithAccounts([liquidAcct("checking", 0)]);
    const ledger = addWithBase(emptyLedger, base, spend());
    expect(() => buildProjection(interpretLedger(ledger, base), base, nullJurisdiction)).not.toThrow();
  });
});

// A credit card may be named among the funding sources, drawn in the stated order — the engine
// borrows against it rather than substituting it for something else.

describe("OneTimeSpendEvent — credit card as a funding source", () => {
  it("borrows on a named card once the liquid source is exhausted", () => {
    const base = baseWithAccounts([liquidAcct("checking", 1_000_000)]); // $10k
    const withCard = addWithBase(emptyLedger, base, cardLoanEvent({ creditLimitCents: 5_000_000 }));
    const ledger = addWithBase(
      withCard,
      base,
      spend({ amountCents: 3_000_000, fundingSourceIds: ["checking", "visa"] }),
    );
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    const m3 = series.months[3];
    expect(m3.accountBalancesCents.checking).toBe(0);
    expect(m3.liabilityBalancesCents.visa).toBe(2_000_000);
    expect(series.status).toBe("ran-to-horizon");
  });
});

// Sibling explicit events in the same month resolve in event-sequence order, the second priced
// against what the first left behind.

describe("OneTimeSpendEvent — siblings resolve in event-sequence order", () => {
  it("funds the second spend from what the first left in the shared account", () => {
    const base = baseWithAccounts([liquidAcct("checking", 5_000_000)]); // $50k
    let ledger = addWithBase(
      emptyLedger,
      base,
      spend({ id: "spend1", month: 3, amountCents: 3_000_000, fundingSourceIds: ["checking"] }),
    );
    ledger = addWithBase(
      ledger,
      base,
      spend({ id: "spend2", month: 3, amountCents: 3_000_000, fundingSourceIds: ["checking"] }),
    );
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    expect(series.status).toBe("blocked");
    // The first spend resolved (its own outcome executed) draining $30k of the $50k; the
    // second — priced against the $20k it left — is the one that fell short and never applied.
    expect(series.blockingObligation?.sourceEventId).toBe("spend2");
    expect(series.months[3].accountBalancesCents.checking).toBe(2_000_000);
  });
});

describe("OneTimeSpendEvent — post-add insolvency nudge", () => {
  const scalars = {
    name: "Test",
    startYear: 2026,
    openingBalanceCents: 3_000_000, // $30k savings, no other liquid buffer
    savingsReturnPct: 0,
    retirementReturnPct: 0,
    brokerageReturnPct: 0,
    sharedScheme: "proportional" as const,
    inflationPct: 0,
    birthYear: 2026 - 30,
    lifeExpectancy: 90,
    benefitClaimingAge: 67,
  };

  /** No income; a $5k/mo "wants" line drains savings, then the synthetic credit cascade,
   *  going insolvent inside the 24-month horizon (the synthetic card's $50k limit is not
   *  enough on its own to outlast it). */
  function initHousehold(): Projection {
    const p = Projection.init(scalars, nullJurisdiction);
    p.addBudgetLine({
      label: "Wants",
      target: { kind: "expense" },
      amountSource: { kind: "literal", monthlyCents: 5_000_00 },
      category: "wants",
    });
    return p;
  }

  it("fires when an affordable spend pulls the insolvency date earlier", () => {
    const p = initHousehold();
    // $10k is well within the $30k opening balance — the draw itself never blocks.
    const eventId = p.spendOnce({
      month: 1,
      label: "New car",
      amountCents: 1_000_000,
      fundingSourceIds: [SAVINGS_ID],
    });

    const nudge = oneTimeSpendInsolvencyNudge(p.state, nullJurisdiction, eventId);
    expect(nudge).not.toBeNull();
    expect(nudge?.eventId).toBe(eventId);

    // Sanity: WITHOUT the spend, the plan goes insolvent later (or not at all within the run).
    const withoutSpend = Projection.init(scalars, nullJurisdiction);
    withoutSpend.addBudgetLine({
      label: "Wants",
      target: { kind: "expense" },
      amountSource: { kind: "literal", monthlyCents: 5_000_00 },
      category: "wants",
    });
    const baseline = withoutSpend.run(nullJurisdiction).firstInsolventMonth;
    expect(baseline === null || baseline > (nudge?.insolventFromMonth ?? -Infinity)).toBe(true);
  });

  it("never fires for a spend that never went on the ledger", () => {
    const p = initHousehold();
    expect(oneTimeSpendInsolvencyNudge(p.state, nullJurisdiction, "not-an-event")).toBeNull();
  });

  it("never fires for a spend that was itself blocked — that is a harder warning already shown", () => {
    // $1 opening, so a $10k spend from it is instantly stranded — blocked, not a nudge.
    const broke = Projection.init({ ...scalars, openingBalanceCents: 1_00 }, nullJurisdiction);
    broke.addBudgetLine({
      label: "Wants",
      target: { kind: "expense" },
      amountSource: { kind: "literal", monthlyCents: 5_000_00 },
      category: "wants",
    });
    const eventId = broke.spendOnce({
      month: 1,
      label: "New car",
      amountCents: 1_000_000,
      fundingSourceIds: [SAVINGS_ID],
    });
    expect(oneTimeSpendInsolvencyNudge(broke.state, nullJurisdiction, eventId)).toBeNull();
  });
});
